import ts from 'typescript'
import { resolve, sep } from 'node:path'

// SST's generated type surface imports vendor .ts implementations. skipLibCheck
// skips declarations only, so report application/SDK errors and count SST errors separately.
const loaded = ts.readConfigFile('tsconfig.json', ts.sys.readFile)
if (loaded.error) throw Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'))
const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, process.cwd())
const program = ts.createProgram(parsed.fileNames, parsed.options)
const all = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
const vendor = resolve('.sst/platform') + sep
const diagnostics = all.filter(d => !d.file || !resolve(d.file.fileName).startsWith(vendor))
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => '\n',
  }))
  process.exitCode = 1
} else console.log(`Instance typecheck passed (strict; ${all.length - diagnostics.length} SST vendor-source diagnostics excluded)`)
