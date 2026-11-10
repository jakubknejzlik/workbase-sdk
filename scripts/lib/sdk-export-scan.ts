import { registerTempDir, cleanupTempDir } from './test-temp-dir.mjs'
import ts from 'typescript'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isIP } from 'node:net'
import { join, relative } from 'node:path'
import { customerTerms, reviewDigest } from './public-vocabulary'

interface TermReview {
  pathDigest: string
  lineDigest: string
  lineNumber: number
  reason: string
}
interface ReviewedLine {
  path: string
  line: string
  lineNumber: number
  reason: string
}
export interface ScanPolicy {
  nameDigests: string[]
  hosts?: { value: string; reason: string }[]
  hostLiterals?: (ReviewedLine & { value: string })[]
  emails?: (ReviewedLine & { value: string })[]
  encoded?: (ReviewedLine & { payload: string })[]
  terms: TermReview[]
  ids: (ReviewedLine & { value: string })[]
}
// Policy JSON contains hashed legal reviews and synthetic literals.
// Review exact serialized lines using only already reviewed values.
// New workflow/docs content receives no additional allowance.
export function withPolicyDataReviews(policy: ScanPolicy): ScanPolicy {
  const lines = (JSON.stringify(policy, null, 2) + '\n').split('\n')
  const review = (line: string, index: number) => ({ path: 'scripts/sdk-scan-policy.json', line, lineNumber: index + 1, reason: 'Exact serialization of reviewed scan policy data.' })
  return {
    ...policy,
    ids: [...policy.ids, ...lines.flatMap((line, index) => policy.ids.filter(entry => line.includes(entry.value)).map(entry => ({ ...review(line, index), value: entry.value })))],
    emails: [...policy.emails ?? [], ...lines.flatMap((line, index) => (policy.emails ?? []).filter(entry => line.includes(entry.value)).map(entry => ({ ...review(line, index), value: entry.value })))],
    encoded: [...policy.encoded ?? [], ...lines.flatMap((line, index) => (policy.encoded ?? []).filter(entry => line.includes(entry.payload)).map(entry => ({ ...review(line, index), payload: entry.payload })))],
    hostLiterals: [...policy.hostLiterals ?? [], ...lines.flatMap((line, index) => (policy.hostLiterals ?? []).filter(entry => line.includes(entry.value)).map(entry => ({ ...review(line, index), value: entry.value })))],
  }
}
// Union of the public console, package boundary and terminology brand detectors.
export { customerTerms } from './public-vocabulary'
// Consume each local-part run once, even without @. Retrying after punctuation
// would scan every suffix of inputs such as a.a.a. or a+a+a+.
function* emailCandidates(text: string): Generator<string> {
  const alphanumeric = /[a-z\d]/i, local = /[a-z\d.!#$%&*+=?^_{}|~-]/i
  const label = /[a-z\d-]/i, letter = /[a-z]/i
  let cursor = 0
  while (cursor < text.length) {
    if (!local.test(text[cursor])) { cursor++; continue }
    let start = -1
    while (cursor < text.length && local.test(text[cursor])) {
      if (start < 0 && alphanumeric.test(text[cursor]) && (cursor === 0 || !alphanumeric.test(text[cursor - 1]))) start = cursor
      cursor++
    }
    if (start < 0 || text[cursor] !== '@') continue
    let domain = cursor + 1, end = -1, dotted = false
    // Remember the last eligible TLD, including a letter prefix of a label.
    // This preserves the original detector's partial-address matching semantics.
    while (domain < text.length && label.test(text[domain])) {
      const labelStart = domain
      while (domain < text.length && letter.test(text[domain])) domain++
      if (dotted && domain - labelStart >= 2) end = domain
      while (domain < text.length && label.test(text[domain])) domain++
      if (text[domain] !== '.') break
      dotted = true
      domain++
    }
    if (end >= 0) {
      yield text.slice(start, end)
      cursor = end
    } else cursor++ // The text after @ may itself start another candidate.
  }
}
const allowedEmail = /^(?:[^@]+@(?:example\.(?:com|org|net|test|invalid)|[^@]+\.example\.(?:com|org|net|test|invalid))|noreply@workbase\.dev|workbase@users\.noreply\.github\.com)$/i
const hash = /(?<![a-f\d])[a-f\d]{32}(?![a-f\d])/gi
function matchesLine(review: ReviewedLine | TermReview, path: string, line: string, index: number): boolean {
  return review.lineNumber === index + 1 && !!review.reason && ('lineDigest' in review
    ? review.pathDigest === reviewDigest(path) && review.lineDigest === reviewDigest(line)
    : review.path === path && review.line === line)
}
function unchangedLinePolicy(policy: ScanPolicy, original: string, transformed: string): ScanPolicy {
  const before = original.split('\n'), after = transformed.split('\n')
  const unchanged = (review: ReviewedLine | TermReview) => {
    const index = review.lineNumber - 1
    return before[index] !== undefined && before[index] === after[index] && ('lineDigest' in review
      ? reviewDigest(before[index]) === review.lineDigest : before[index] === review.line)
  }
  return {
    ...policy,
    terms: policy.terms.filter(unchanged), ids: policy.ids.filter(unchanged),
    emails: policy.emails?.filter(unchanged), hostLiterals: policy.hostLiterals?.filter(unchanged), encoded: policy.encoded?.filter(unchanged),
  }
}
// Scope bare DNS detection to source literals/comments, not dotted code access.
function hostLiteralText(path: string, text: string): string {
  if (!/\.[cm]?[jt]sx?$/.test(path)) return text
  const spans: [number, number][] = []
  const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) spans.push([node.getStart(tree), node.end])
    ts.forEachChild(node, visit)
  }
  visit(tree)
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, text)
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) spans.push([scanner.getTokenPos(), scanner.getTextPos()])
  }
  let end = 0, result = ''
  for (const [start, stop] of spans.sort(([a], [b]) => a - b)) {
    if (start < end) continue
    result += text.slice(end, start).replace(/[^\n]/g, ' ') + text.slice(start, stop)
    end = stop
  }
  return result + text.slice(end).replace(/[^\n]/g, ' ')
}
// Only SVG path data and explicitly named viewBox numeric literals can contain
// adjacent decimal coordinates that resemble IPv4. Keep every other span intact.
function withoutSvgNumbers(text: string): string {
  const blank = (value: string) => value.replace(/[^\n]/g, ' ')
  return text.replace(/(["'`])[Mm][\d\s.,+eEMmLlHhVvCcSsQqTtAaZz-]+\1/g, blank)
    .replace(/\bviewBox\s*[:=]\s*(["'`])[\d\s.,+-]+\1/g, blank)
}
function assertText(path: string, text: string, policy: ScanPolicy, depth = 0, sourceSyntax = depth === 0): void {
  const hostText = sourceSyntax ? hostLiteralText(path, text) : text
  const hostLines = hostText.split('\n'), ipLines = withoutSvgNumbers(text).split('\n')
  for (const [index, line] of text.split('\n').entries()) {
    if (customerTerms.test(line) && !policy.terms.some(review => matchesLine(review, path, line, index))) throw new Error(`customer/owner content: ${path}`)
    const emailText = line.replaceAll('patches/sonner@2.0.7.patch', '').replaceAll('patches/@radix-ui%2Freact-select@2.2.6.patch', '').replaceAll('patches/wrangler@4.126.0.patch', '').replaceAll('patches/@radix-ui/react-select@2.2.6.patch', '')
    for (const candidate of emailCandidates(emailText)) if (!allowedEmail.test(candidate) && !policy.emails?.some(review => review.value === candidate && matchesLine(review, path, line, index))) throw new Error(`unapproved email: ${path}: ${candidate}`)
    // IDs are forbidden everywhere, not only recognized configuration formats.
    for (const match of line.matchAll(hash)) if (match[0] !== '0'.repeat(32) && !policy.ids.some(review => review.value === match[0] && matchesLine(review, path, line, index))) throw new Error(`32-hex identifier: ${path}`)
    const checkHost = (value: string) => {
      const authority = value.replace(/\$\{[^}]*\}?/g, '').split(/[?#]/)[0].split('@').at(-1)!.toLowerCase()
      const host = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0]
      if (/^(?:localhost|127\.\d+\.\d+\.\d+|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+|\[::1\])$|(?:^|\.)(?:test|invalid|example)$|^(?:[^.]+\.)*example\.(?:com|net|org)$/.test(host)) return
      if (policy.hosts?.some(review => review.value === host && review.reason)) return
      if (policy.hostLiterals?.some(review => review.value === host && matchesLine(review, path, line, index))) return
      throw new Error(`private/unreviewed host: ${path}: ${host}`)
    }
    // Start only at a scheme-token boundary: never retry each suffix of a long
    // scheme-like run. Database and socket transports share the same host policy.
    for (const match of line.matchAll(/(?<![a-z\d+.-])[a-z][a-z\d+.-]*:\/\/([^\s/"'`<>\\)]+)/gi)) {
      // Interpolated authorities contain no literal host. Literal inputs are scanned separately.
      if (match[1].startsWith('${') || match[1].startsWith('[${')) continue
      checkHost(match[1])
    }
    // Bare hosts are scoped to network suffixes (including private-use internal/local).
    // Other suffixes are checked in URI authorities; dotted code identifiers are not DNS.
    const bare = /(?<![\w.-])(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+(?:internal|local|com|org|net|dev|io|app|edu|gov|co|cz)(?![\w.-])/gi
    for (const match of hostLines[index].matchAll(bare)) checkHost(match[0])
    for (const match of line.matchAll(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g)) {
      if (!match[0].split('.').every(part => Number(part) <= 255)) continue
      const privateAddress = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(match[0])
      if (privateAddress || hostLines[index].slice(match.index, match.index + match[0].length) === match[0] && ipLines[index].slice(match.index, match.index + match[0].length) === match[0]) checkHost(match[0])
    }
    // Tokenize complete IPv6 candidates, including compressed/mapped addresses
    // and zone IDs. Exclude regex group syntax (?::...) and CSS pseudo-elements.
    for (const match of hostLines[index].matchAll(/(?<![\w:])(?:[a-f\d]*:){2,}[a-f\d:.]*(?:%[a-z\d_.~-]+)?(?![\w:-])/gi)) {
      if (match[0] === ':'.repeat(2) && hostLines[index].slice(match.index - 2, match.index) === '(?') continue
      if (isIP(match[0].split('%')[0]) === 6) checkHost(`[${match[0]}]`)
    }
  }
  // Format characters can split otherwise forbidden terms. Rescan a normalized
  // copy; exact-line exemptions survive only on lines that did not change.
  const stripped = text.replace(/\p{Cf}/gu, '')
  if (stripped !== text) {
    assertText(path, stripped, unchangedLinePolicy(policy, text, stripped), depth, sourceSyntax)
  }
  if (depth >= 4) {
    if (/data:|(?:%[\da-f]{2})|\\(?:u\{|[ux])[\da-f]/i.test(text) || /^[a-z\d+/]{12,}={0,2}$/i.test(text.trim())) throw new Error(`encoding depth exceeded: ${path}`)
    return
  }
  for (const [index, line] of text.split('\n').entries()) for (const [, metadata, payload] of line.matchAll(/data:([^,\s"'`<>]*),([^\s"'`<>\\)]+)/gi)) {
    if (/\.[cm]?[jt]sx?$/.test(path) && payload.startsWith('${')) continue // Dynamic source template, not an encoded asset; literal inputs are scanned separately.
    if (policy.encoded?.some(review => review.payload === payload && matchesLine(review, path, line, index))) continue
    let bytes: Buffer
    try {
      if (/;base64$/i.test(metadata)) {
        bytes = Buffer.from(payload, 'base64')
        if (!/^[a-z\d+/]*={0,2}$/i.test(payload) || bytes.toString('base64').replace(/=+$/, '') !== payload.replace(/=+$/, '')) throw new Error('Invalid base64')
      } else bytes = Buffer.from(decodeURIComponent(payload))
    } catch { throw new Error(`unscannable encoded asset: ${path}`) }
    assertBytes(path, bytes, { ...policy, terms: [], ids: [], emails: [], hostLiterals: [], encoded: [] }, depth + 1)
  }
  // String-literal escapes and percent encoding are rescanned by every detector.
  const unescaped = text.replace(/\\u\{([\da-f]+)\}|\\u([\da-f]{4})|\\x([\da-f]{2})/gi, (_, point, unicode, byte) => {
    const code = parseInt(point ?? unicode ?? byte, 16)
    if (code > 0x10ffff) throw new Error(`invalid Unicode escape: ${path}`)
    return String.fromCodePoint(code)
  }).replace(/(?:%[\da-f]{2})+/gi, part => { try { return decodeURIComponent(part) } catch { return part } })
  if (unescaped !== text) {
    assertText(path, unescaped, unchangedLinePolicy(policy, text, unescaped), depth + 1, sourceSyntax)
  }
  // Tokens need no quotes or data URI wrapper. Canonical round-trip validation
  // prevents Buffer's permissive decoder from accepting malformed base64.
  for (const match of text.matchAll(/(?<![a-z\d+/=])[a-z\d+/]+={0,2}(?![a-z\d+/=])/gi)) {
    const payload = match[0], bytes = Buffer.from(payload, 'base64'), decoded = bytes.toString('utf8')
    if (bytes.toString('base64').replace(/=+$/, '') !== payload.replace(/=+$/, '')) continue
    if (Buffer.from(decoded).equals(bytes)) assertText(path, decoded, { ...policy, terms: [], ids: [], emails: [], hostLiterals: [], encoded: [] }, depth + 1)
    else if (!/^[a-f\d]+$/i.test(payload) && /["'`]/.test(text[match.index - 1] ?? '') && (payload.length >= 128 || payload.length >= 32 && payload.endsWith('='))) throw new Error(`binary base64 asset requires explicit review: ${path}`)
  }
}
export function assertBytes(path: string, bytes: Buffer, policy: ScanPolicy, depth = 0): void {
  if (customerTerms.test(path) && !policy.nameDigests.includes(reviewDigest(path))) throw new Error(`customer/owner filename: ${path}`)
  const text = bytes.toString('utf8')
  if (bytes.includes(0) || !Buffer.from(text).equals(bytes)) throw new Error(`binary/encoded asset requires explicit review: ${path}`)
  const namePolicy = { ...policy, terms: policy.nameDigests.includes(reviewDigest(path)) ? [{ pathDigest: reviewDigest(path), lineDigest: reviewDigest(path), lineNumber: 1, reason: 'Exact reviewed vendor filename' }] : [] }
  if (depth === 0) assertText(path, path, namePolicy)
  assertText(path, text, policy, depth)
}
export function scanTree(root: string, policy: ScanPolicy): { files: number; bytes: number } {
  let files = 0, bytes = 0
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (name === '.git' || name === 'node_modules') continue
      const path = join(directory, name), stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`symlink in export scan: ${relative(root, path)}`)
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile()) {
        const data = readFileSync(path)
        assertBytes(relative(root, path), data, policy)
        files++; bytes += data.length
      } else throw new Error(`unsupported export entry: ${path}`)
    }
  }
  walk(root)
  return { files, bytes }
}
export function scanGitleaks(root: string, history: boolean): void {
  const args = ['detect', '--source', root, '--no-banner', '--redact', '--ignore-gitleaks-allow', '--exit-code', '1', ...(history ? ['--log-opts=--all'] : ['--no-git'])]
  execFileSync('gitleaks', args, { cwd: root, env: Object.fromEntries(Object.entries({ ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' }).filter(([key]) => !key.startsWith('GITLEAKS_') && (!key.startsWith('GIT_') || ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_NO_REPLACE_OBJECTS'].includes(key)))), stdio: 'pipe', timeout: 120000 })
  console.log(`gitleaks ${history ? 'fresh history' : 'tree'}: passed`)
}
export function scanArchives(directory: string, policy: ScanPolicy): void {
  const archives = readdirSync(directory).filter(name => name.endsWith('.tgz')).sort()
  if (archives.length !== 3) throw new Error(`Expected exactly 3 archives, got ${archives.length}`)
  const names = new Set<string>()
  for (const archive of archives) {
    assertBytes(archive, Buffer.alloc(0), policy)
    const stage = registerTempDir(mkdtempSync(join(tmpdir(), 'sdk-export-archive-')))
    try {
      const file = join(directory, archive)
      const paths = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n')
      const types = execFileSync('tar', ['-tvzf', file], { encoding: 'utf8' }).trim().split('\n')
      const normalized = paths.map(path => path.replace(/\/$/, ''))
      if (paths.length !== types.length || new Set(normalized).size !== paths.length ||
        types.some(line => !['-', 'd'].includes(line[0])) ||
        paths.some(path => !path.startsWith('package/') || /[\x00-\x1f\x7f\\]/.test(path) || path.split('/').some(part => part === '..' || part === '.')) ||
        normalized.some(path => path.split('/').some(part => !part))) throw new Error('Unsafe archive entry')
      execFileSync('tar', ['-xzf', file, '-C', stage])
      const pkg = join(stage, 'package')
      const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
      const name = manifest.name.replace('@workbasehq/', '')
      if (!['core', 'plugins', 'mcp'].includes(name) || names.has(name)) throw new Error('Unexpected/duplicate packed SDK package')
      names.add(name)
      for (const path of paths.filter(path => !path.endsWith('/'))) {
        const rel = path.slice('package/'.length)
        const canonical = name === 'plugins' && rel === 'console/assets/NOTICE' ? 'packages/plugins/console/NOTICE' : `packages/${name}/${rel}`
        assertBytes(canonical, readFileSync(join(pkg, rel)), policy)
      }
      scanGitleaks(stage, false)
    } finally { cleanupTempDir(stage) }
  }
  console.log('Export archive scan: exactly 3 packages; customer/owner, email, IDs, URLs, encoded assets and secrets passed')
}
