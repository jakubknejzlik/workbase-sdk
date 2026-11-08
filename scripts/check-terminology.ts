import { privateBrand as brand } from './lib/public-vocabulary'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import ts from 'typescript'
import { renderInvitationEmail, type InvitationEmailInput, type RenderedInvitationEmail } from '../packages/plugins/members/src/emails/invitation-email'

export interface Finding {
  code: 'terminology_forbidden' | 'brand_forbidden' | 'brand_asset_unreviewed'
  location: string
  match: string
}
// Match compounds too (e.g. workspace-settings accidentally used as a title).
const terminology = /workspace(?:s)?|pracovn(?:ího|ímu|ími|ích|ím|í)\s+prostor(?:ům|ech|em|ů|u|y|a)?/iu
// Reference 1593f1931901f60d0458bff21eddc8c3b06aa758, frontend-app/public:
// images/logo.png and favicon.png. Renaming either asset must still fail.
const referenceImages = new Set([
  '7d7abd378e5861150c54dc77ed6630a41c6195cc35f35e15d046b76f9cdd3f92',
  '85755631a75642db7e9085e9a0d7575036fe953c6752fa68ebe6f34f328ad83b',
])
// The console currently ships no image files. Future image assets need an exact
// path + digest + review reason so an anonymous/modified logo cannot evade text checks.
const reviewedImages: readonly { path: string; sha256: string; reason: string }[] = []
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
function decoded(value: string): string {
  const entities: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", Tab: '\t', NewLine: '\n' }
  let result = value.normalize('NFC')
  for (let pass = 0; pass < 3; pass++) {
    result = result.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (!code.startsWith('#')) return entities[code] ?? entity
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity
    }).replace(/(?:%[\da-f]{2})+/gi, part => { try { return decodeURIComponent(part) } catch { return part } })
  }
  return result
}
export function inspectCopy(location: string, value: string): Finding[] {
  const findings: Finding[] = []
  const check = (copy: string) => {
    for (const [code, rule] of [['terminology_forbidden', terminology], ['brand_forbidden', brand]] as const) {
      const match = rule.exec(decoded(copy))
      if (match) findings.push({ code, location, match: match[0] })
    }
  }
  check(value)
  for (const match of value.matchAll(/data:[^\s"'<>]*?;base64,([a-z\d+/=]+)/gi)) {
    const bytes = Buffer.from(match[1], 'base64')
    check(bytes.toString('utf8'))
    if (referenceImages.has(hash(bytes))) findings.push({ code: 'brand_forbidden', location, match: 'reference logo bytes' })
  }
  return findings
}

const blockTag = /^(?:address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|th|thead|tr|ul)$/i
const collapsed = (value: string) => value.replace(/\s+/g, ' ').trim()
function inspectHtml(location: string, html: string): Finding[] {
  // Keep metadata, URLs and embedded-asset checks alongside rendered copy.
  const findings = inspectCopy(location, html)
  const text = html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?([a-z][\w:-]*)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi, (_tag, name: string) => blockTag.test(name) ? ' ' : '')
  // Decode after stripping markup: escaped tags are visible literal text.
  for (const finding of inspectCopy(location, collapsed(decoded(text)))) {
    if (!findings.some(existing => existing.code === finding.code)) findings.push(finding)
  }
  return findings
}

// Reviewed technical exceptions. Each is an exact value in a specific AST context;
// none applies to locale values, JSX copy, accessibility attributes or mail.
const routeValues = new Set([
  'workspace-settings', 'workspace-members', '/workspace-settings', '/workspace-members',
  '/o/$orgId/settings/workspace-settings', '/o/$orgId/settings/workspace-members',
])
function propertyName(node: ts.Node): string | undefined {
  return ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : undefined
}
function technicalValue(node: ts.StringLiteralLike, file: string): boolean {
  let parent = node.parent
  while (ts.isAsExpression(parent)) parent = parent.parent
  if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node) return true
  if (ts.isImportTypeNode(parent) || ts.isLiteralTypeNode(parent)) return true
  // Object keys are code/API fields, not their displayed values.
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === node) return true
  const attribute = ts.isJsxAttribute(parent) ? parent.name.getText() : propertyName(parent)
  // Exact instance discriminator: technical contract data, never a displayed brand.
  if (node.text === 'workspace' && attribute === 'data-slot') return true // preserved shell slot
  if (node.text === 'workspace-identity' && ts.isArrayLiteralExpression(parent)) return true // TanStack query key
  if (routeValues.has(node.text) && (
    ['id', 'path', 'fullPath', 'to'].includes(propertyName(parent) ?? '') ||
    ts.isCallExpression(parent) && parent.arguments[0] === node && ts.isIdentifier(parent.expression) && parent.expression.text === 'createFileRoute'
  )) return true // preserved public URL aliases; never a UI attribute
  if (['workspace', 'workspaceLabel'].includes(node.text) && ts.isCallExpression(parent) && parent.arguments[0] === node
    && ts.isIdentifier(parent.expression) && (parent.expression.text === 't' || node.text === 'workspaceLabel' && file.startsWith('packages/frontend-console/dist/'))) return true // existing translation keys
  return false
}

/** Scan all literal values, not just known UI props; moving copy into a helper cannot bypass it. */
export function inspectSource(file: string, source: string): Finding[] {
  if (file.endsWith('.json')) {
    const findings: Finding[] = []
    const visit = (value: unknown, path: string) => {
      // Owner-approved product name from instance config; generic console copy stays unbranded.
      if (typeof value === 'string') findings.push(...inspectCopy(`${file}:${path}`, value))
      else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`)
    }
    visit(JSON.parse(source), '$')
    return findings
  }
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TSX)
  const findings: Finding[] = []
  const constantText = (node: ts.Node): string | undefined => {
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = constantText(node.left), right = constantText(node.right)
      return left === undefined || right === undefined ? undefined : left + right
    }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text
      for (const span of node.templateSpans) {
        const value = constantText(span.expression)
        if (value === undefined) return undefined
        text += value + span.literal.text
      }
      return text
    }
    return undefined
  }
  const jsxText = (node: ts.Node): string => {
    if (ts.isJsxText(node)) {
      // JSX trims indentation and joins nonempty source lines with a space.
      const lines = node.text.replace(/\r\n?/g, '\n').split('\n')
      return lines.map((line, index) => {
        let text = line.replace(/\t/g, ' ')
        if (index > 0) text = text.replace(/^ +/, '')
        if (index < lines.length - 1) text = text.replace(/ +$/, '')
        return text
      }).filter(Boolean).join(' ')
    }
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const text = node.children.map(jsxText).join('')
      return ts.isJsxElement(node) && blockTag.test(node.openingElement.tagName.getText(tree)) ? ` ${text} ` : text
    }
    if (ts.isJsxExpression(node)) return node.expression ? constantText(node.expression) ?? '\0' : ''
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === 'br') return ' '
    // Unknown expressions/components must not join otherwise separate words.
    return '\0'
  }
  const visit = (node: ts.Node) => {
    const start = findings.length
    if (ts.isBinaryExpression(node) || ts.isTemplateExpression(node)) {
      const value = constantText(node)
      if (value !== undefined) findings.push(...inspectCopy(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`, value))
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (!ts.isStringLiteralLike(node) || !technicalValue(node, file)) {
        const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
        findings.push(...inspectCopy(`${file}:${line}`, node.text))
      }
    }
    ts.forEachChild(node, visit)
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1
      const descendants = findings.slice(start)
      for (const finding of inspectCopy(`${file}:${line}`, collapsed(decoded(jsxText(node))))) {
        // Report at the smallest element containing the match, once per subtree.
        if (!descendants.some(existing => existing.code === finding.code && existing.match === finding.match)) findings.push(finding)
      }
    }
  }
  visit(tree)
  return findings
}

const sourceRoots = [
  'packages/frontend-console/src', 'packages/frontend-console/index.html', 'packages/frontend-console/public',
  'packages/ui/src', 'packages/console-generated/src', 'packages/console-generated/snapshots',
  'packages/console-generated/scripts', 'packages/plugins/members/src/emails',
]
const buildRoots = ['packages/frontend-console/dist', 'packages/ui/dist']
export function checkTerminology(root = resolve(fileURLToPath(new URL('..', import.meta.url))), options: {
  renderMail?: boolean
  mailRenderer?: (input: InvitationEmailInput) => RenderedInvitationEmail
  requireBuild?: boolean
} = {}) {
  const findings: Finding[] = []
  let files = 0, mailVariants = 0
  const walk = (path: string, built: boolean) => {
    let entry
    try { entry = lstatSync(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (entry.isSymbolicLink()) throw new Error(`terminology_unscannable: ${path}: symlink`)
    if (entry.isDirectory()) { for (const child of readdirSync(path)) walk(resolve(path, child), built); return }
    const file = relative(root, path)
    // Development tests and truthful provenance/license records never ship as UI.
    if (file === 'packages/ui/src/vendor/tiketo/files.json') return // exact source-blob mapping; reviewed provenance
    if (!built && (/\.(?:test|spec)\.[^.]+$/.test(file) || /\.(?:md|d\.ts)$/.test(file))) return
    files++
    const bytes = readFileSync(path)
    if (/\.(?:png|jpe?g|gif|webp|avif|ico|bmp|svg)$/i.test(file) && !reviewedImages.some(review => review.path === file && review.sha256 === hash(bytes) && review.reason.trim())) {
      findings.push({ code: 'brand_asset_unreviewed', location: file, match: 'image requires an exact path/hash review' })
    }
    if (referenceImages.has(hash(bytes))) findings.push({ code: 'brand_forbidden', location: file, match: 'reference logo bytes' })
    // File names in public/build are product asset URLs (source vendor paths are provenance).
    if (built || file.includes('/public/')) {
      const match = brand.exec(file)
      if (match) findings.push({ code: 'brand_forbidden', location: file, match: match[0] })
    }
    if (/\.(?:[cm]?[jt]sx?|json)$/.test(file)) findings.push(...inspectSource(file, bytes.toString('utf8')))
    else if (/\.css$/.test(file)) {
      // Ignore comments/selector identifiers, but inspect CSS content, URLs and embedded assets.
      const css = bytes.toString('utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      const match = brand.exec(decoded(css))
      if (match) findings.push({ code: 'brand_forbidden', location: file, match: match[0] })
      for (const text of css.matchAll(/["']([^"']*)["']/g)) findings.push(...inspectCopy(file, text[1]))
    } else if (/\.(?:html?|svg|xml)$/.test(file)) findings.push(...inspectHtml(file, bytes.toString('utf8')))
    else if (/\.(?:txt|webmanifest)$/.test(file)) findings.push(...inspectCopy(file, bytes.toString('utf8')))
  }
  for (const path of sourceRoots) {
    if (['packages/console-generated/snapshots', 'packages/console-generated/scripts'].includes(path)) {
      try { lstatSync(resolve(root, path)) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        console.log(`Terminology scan: skipping absent private input ${path}`)
        continue
      }
    }
    walk(resolve(root, path), false)
  }
  for (const path of buildRoots) {
    if (options.requireBuild && !existsSync(resolve(root, path))) throw new Error(`terminology_missing_build: ${path}; run bun run console:build`)
    walk(resolve(root, path), true)
  }
  if (options.renderMail !== false) for (const language of ['en', 'cs'] as const) for (const kind of ['invite', 'reminder'] as const) for (const tenant of ['organization', 'single'] as const) {
    const mail = (options.mailRenderer ?? renderInvitationEmail)({
      language, kind, inviterDisplayName: 'Jana Nováková', organizationName: tenant === 'organization' ? 'Example Organization' : undefined,
      roleLabel: language === 'en' ? 'Member' : 'Člen', expiresAt: new Date('2026-11-04T12:00:00Z'), timeZone: 'Europe/Prague',
      configuredOrigin: 'https://console.example.test', acceptUrl: 'https://console.example.test/invitation?token=synthetic',
    })
    for (const channel of ['subject', 'preheader', 'html', 'text'] as const) {
      const inspect = channel === 'html' ? inspectHtml : inspectCopy
      findings.push(...inspect(`mail/${language}/${kind}/${tenant}/${channel}`, mail[channel]))
    }
    mailVariants++
  }
  if (findings.length) throw new Error(findings.map(item => `${item.code}: ${item.location}: ${JSON.stringify(item.match)}`).join('\n'))
  return { files, mailVariants }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkTerminology(undefined, { requireBuild: process.argv.includes('--require-build') })
    console.log(`Terminology and brand: ${result.files} files; ${result.mailVariants} rendered mail variants (4 channels each) passed`)
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }
}
