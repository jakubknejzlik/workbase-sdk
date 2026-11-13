import { registerTempDir, cleanupTempDir } from './lib/test-temp-dir.mjs'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { builtinModules } from 'node:module'
import ts from 'typescript'
import { assertCoreEnumLabels } from './check-core-enum-labels'
import { sdkWorkspaceDirectories } from './lib/sdk-workspaces'
import { assertSdkPackageNames, sdkPackageNames } from './sdk-provenance'
import { consolePublicContent, checkConsolePublic } from './check-console-public'

export { instanceNames } from './lib/public-vocabulary'
import { instanceNames } from './lib/public-vocabulary'
export function checkSdkBoundary(root: string, sourceOnly = false, vocabulary: RegExp = instanceNames) {
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)])
  const failures: string[] = []
  function uiPeers(manifest: { exports?: Record<string, unknown>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }, where: string) {
    if (!manifest.exports?.['./console/ui/vite']) return
    for (const name of ['vite', '@tanstack/router-generator', 'es-module-lexer']) {
      if (!manifest.peerDependencies?.[name] || manifest.peerDependenciesMeta?.[name]?.optional !== true) failures.push(`UI build dependency must be an optional peer: ${where}: ${name}`)
    }
  }
  for (const directory of sdkWorkspaceDirectories(root)) {
    const path = join(directory, 'package.json')
    if (!existsSync(path)) continue
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    uiPeers(manifest, relative(root, path))
    if (!sdkPackageNames.map(name => `@workbasehq/${name}`).includes(manifest.name) && manifest.private !== true) failures.push(`non-SDK workspace must be private: ${relative(root, path)}`)
  }
  for (const path of files(join(root, 'packages/core/src'))) {
    const source = readFileSync(path, 'utf8')
    if (/(?:\.\.\/)+plugins\//.test(source) || /['"]@workbasehq\/plugins(?:\/|['"])/.test(source)) failures.push(`core dependency direction: ${relative(root, path)}`)
  }
  function inventory(directory: string, manifest: { dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; devDependencies?: Record<string, string> }, template = false) {
    const declared = { ...manifest.dependencies, ...manifest.peerDependencies, ...(template ? manifest.devDependencies : {}) }
    // Templates run in generated projects with their own development tooling.
    for (const path of files(directory).filter(path => /\.[cm]?[jt]sx?$/.test(path) && !relative(directory, path).startsWith('templates/'))) {
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
      const imports: string[] = []
      const add = (node: ts.Node | undefined) => { if (node && ts.isStringLiteralLike(node)) imports.push(node.text) }
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier)
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal)
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || /^(require|require\.resolve)$/.test(node.expression.getText(source)))) add(node.arguments[0])
        ts.forEachChild(node, visit)
      }
      visit(source)
      for (const specifier of imports) {
        if (specifier.startsWith('node:') || specifier.startsWith('cloudflare:') || builtinModules.includes(specifier)) continue
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(path), specifier)
          if (!target.startsWith(directory + '/')) {
            // Sibling scope packages retain their npm layout (plugins -> core).
            const match = relative(directory, target).match(/^\.\.\/core\//)
            if (!match || !declared['@workbasehq/core']) failures.push(`undeclared relative dependency: ${path}: ${specifier}`)
          } else if (![target, target + '.ts', target + '.tsx', join(target, 'index.ts')].some(candidate => existsSync(candidate) && statSync(candidate).isFile())) failures.push(`missing packed source: ${path}: ${specifier}`)
          continue
        }
        const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
        if (!declared[name]) failures.push(`undeclared runtime dependency: ${relative(directory, path)}: ${name}`)
      }
    }
  }
  const archives = existsSync(join(root, 'dist-sdk')) ? readdirSync(join(root, 'dist-sdk')).filter(name => name.endsWith('.tgz')).sort() : []
  if (!sourceOnly || archives.length) {
    if (archives.length !== sdkPackageNames.length) failures.push(`expected exactly ${sdkPackageNames.length} SDK tarballs, found ${archives.length}`)
    const packedNames: string[] = []
    const scratch = registerTempDir(mkdtempSync(join(tmpdir(), 'workbase-boundary-')))
    try {
      for (const archive of archives) {
        const destination = join(scratch, archive)
        execFileSync('mkdir', ['-p', destination])
        const tarball = join(root, 'dist-sdk', archive)
        const paths = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n')
        for (const path of paths) if (/(^|\/)(?:test|tests|__tests__|fixtures|instances|examples|apps)(\/|$)|(^|\/)\.env[^/]*(\/|$)/.test(path)) failures.push(`forbidden packed path: ${archive}: ${path}`)
        execFileSync('tar', ['-xzf', tarball, '-C', destination])
        const directory = join(destination, 'package')
        const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
        uiPeers(manifest, archive)
        packedNames.push(manifest.name)
        if (manifest.name === '@workbasehq/core') {
          try { assertCoreEnumLabels(JSON.parse(readFileSync(join(directory, 'src/query/enum-labels.json'), 'utf8'))) }
          catch (error) { failures.push(`core enum catalog: ${archive}: ${error instanceof Error ? error.message : error}`) }
        }
        if (Object.hasOwn(manifest, 'private')) failures.push(`private field: ${archive}`)
        if (/workspace:/.test(JSON.stringify(manifest))) failures.push(`workspace specifier: ${archive}`)
        if (manifest.name === '@workbasehq/plugins') {
          try { console.log(checkConsolePublic(join(directory, 'console/assets'))) }
          catch (error) { failures.push(`console assets: ${archive}: ${error instanceof Error ? error.message : error}`) }
        }
        for (const path of files(directory)) {
          const name = relative(directory, path)
          const content = readFileSync(path, 'utf8')
          const scanned = name === 'console/assets/NOTICE' ? consolePublicContent('NOTICE', content) : content
          if (/(?:[/\\]|["'`])(?:instances|examples|apps)[/\\]/iu.test(scanned)) failures.push(`private workspace path: ${archive}: ${name}`)
          if (vocabulary.test(name) || vocabulary.test(scanned)) failures.push(`instance data: ${archive}: ${name}`)
        }
        // Templates are inert guide data with their own dependency manifests.
        for (const path of files(directory).filter(path => path.endsWith('/package.json'))) {
          inventory(dirname(path), JSON.parse(readFileSync(path, 'utf8')), relative(directory, path).startsWith('templates/'))
        }
      }
      try { assertSdkPackageNames(packedNames) }
      catch (error) { failures.push(error instanceof Error ? error.message : String(error)) }
    } finally { cleanupTempDir(scratch) }
  }
  if (failures.length) {
    console.error(`SDK boundary failed:\n${failures.map(failure => `- ${failure}`).join('\n')}`)
    return 1
  }
  console.log(`SDK boundary: core → plugins imports 0; ${archives.length}/${sdkPackageNames.length} tarballs checked; instance scan empty; runtime import inventory passed${archives.length ? '' : ' (pack gate runs after packing)'}`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = checkSdkBoundary(resolve(dirname(fileURLToPath(import.meta.url)), '..'), process.argv.includes('--source'))
}
