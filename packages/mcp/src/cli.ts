import { resolve } from 'node:path'
import { fail } from './schemas.ts'

export function parseArgs(args: string[], cwd = process.cwd()) {
  if (args[0] === 'init') {
    const values: Record<string, string> = {}
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i], value = args[i + 1]
      if (!['--root', '--id', '--target'].includes(key) || key in values || !value || value.startsWith('--')) fail('invalid_arguments', 'Usage: init --root <dir> --id <id> --target cloudflare-github')
      values[key] = value
    }
    if (!values['--id'] || values['--target'] !== 'cloudflare-github') fail('invalid_arguments', 'Usage: init --root <dir> --id <id> --target cloudflare-github')
    return { command: 'init' as const, root: resolve(cwd, values['--root'] ?? '.'), id: values['--id'], target: 'cloudflare-github' as const, agentTest: false }
  }
  let root = cwd
  let agentTest = false
  let hasRoot = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent-test' && !agentTest) agentTest = true
    else if (args[i] === '--root' && !hasRoot && args[i + 1] && !args[i + 1].startsWith('--')) {
      root = resolve(cwd, args[++i]); hasRoot = true
    } else fail('invalid_arguments', 'Supported arguments: --root <dir> and --agent-test')
  }
  return { root: resolve(cwd, root), agentTest }
}
