import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

/** Follow console:build's local import graph without executing the build or its imports.
 * Subprocess inputs (route generator, Vite, public assets, terminology scans and
 * snapshot JSON reads) are all under packages/, already covered by sdkSource.
 */
export function consoleBuildInputs(directory: string): string[] {
  const root = realpathSync(directory), files = new Set<string>()
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile).config
  const options: ts.CompilerOptions = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    resolveJsonModule: true, allowJs: true, ...ts.convertCompilerOptionsFromJson(config?.compilerOptions ?? {}, root).options }
  const cache = ts.createModuleResolutionCache(root, name => ts.sys.useCaseSensitiveFileNames ? name : name.toLowerCase(), options)
  const visit = (path: string) => {
    const file = realpathSync(path), name = relative(root, file)
    if (name.startsWith('../') || name.split('/').some(part => ['node_modules', '.wrangler', 'dist'].includes(part)) || files.has(name)) return
    files.add(name)
    if (name.endsWith('.json')) return
    for (const imported of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
      const target = ts.resolveModuleName(imported.fileName, file, options, ts.sys, cache).resolvedModule
      if (target) visit(target.resolvedFileName)
    }
  }
  const entry = join(root, 'scripts/build-console.ts')
  if (existsSync(entry)) visit(entry)
  // generate(true) also reads this gallery JSON via readFile(new URL(...)),
  // rather than an import; its snapshots and other readFile inputs are in packages/.
  if (existsSync(join(root, 'ui-audit/entities.json'))) files.add('ui-audit/entities.json')
  return [...files].sort()
}
