import { constants } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { noLink } from '../paths.ts'
import { hash } from '../planning.ts'
import { WorkflowError } from '../schemas.ts'
import type { RuntimeModel } from './runtime-source.ts'

export interface CompositionRequirement {
  plugin: string
  requirement: string
  satisfied: boolean
  severity: 'error' | 'warning'
  message: string
}

/** Static observations only: never execute consumer entrypoints or provisioning code. */
export async function compositionRequirements(root: string, model: RuntimeModel) {
  const guards: Record<string, string | null> = {}
  const read = async (path: string) => {
    await noLink(dirname(join(root, path)), true)
    await noLink(join(root, path), true)
    try {
      const source = await readFile(join(root, path), { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW })
      guards[path] = hash(source)
      return source
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      guards[path] = null
      return ''
    }
  }
  const requirements: CompositionRequirement[] = []
  const has = (name: string) => model.plugins.some(plugin => plugin.plugin === name)
  if (has('audit') || has('mail-outbox') || has('local-auth')) {
    const source = await read('wrangler.jsonc')
    const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', source)
    const config = parsed.error ? undefined : parsed.config
    const bound = (entries: unknown, binding: string) => Array.isArray(entries) && entries.some(entry => entry?.binding === binding)
    if (has('audit')) {
      requirements.push({ plugin: 'audit', requirement: 'AUDIT_KV', satisfied: bound(config?.kv_namespaces, 'AUDIT_KV'), severity: 'error',
        message: 'Declare AUDIT_KV in wrangler.jsonc kv_namespaces; audit reads require this binding.' })
      requirements.push({ plugin: 'audit', requirement: 'EVENTS_QUEUE', satisfied: bound(config?.queues?.producers, 'EVENTS_QUEUE'), severity: 'warning',
        message: 'EVENTS_QUEUE enables asynchronous delivery; without it audit delivery runs synchronously.' })
    }
    if (has('mail-outbox')) requirements.push({ plugin: 'mail-outbox', requirement: 'EMAIL', satisfied: bound(config?.send_email, 'EMAIL'), severity: 'warning',
      message: 'EMAIL enables external delivery; without it messages remain in email_outbox for the local mailbox.' })
    if (has('local-auth')) {
      // The canonical template entrypoint is inspected even when no Wrangler file exists.
      const entry = await read('src/index.ts')
      const file = ts.createSourceFile('src/index.ts', entry, ts.ScriptTarget.Latest, true)
      const satisfied = file.statements.some(statement => ts.isImportDeclaration(statement) && !statement.importClause
        && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === '@workbasehq/plugins/local-auth/better-auth-als-preseed')
      requirements.push({ plugin: 'local-auth', requirement: 'better-auth-als-preseed', satisfied, severity: 'warning',
        message: 'Import @workbasehq/plugins/local-auth/better-auth-als-preseed in src/index.ts before loading auth to guard against aborted-request initialization hangs.' })
    }
  }
  return { requirements, guards }
}

export function assertCompositionRequirements(requirements: CompositionRequirement[]) {
  if (requirements.some(requirement => !requirement.satisfied && requirement.severity === 'error')) {
    throw new WorkflowError('composition_requirements_unsatisfied', 'Required runtime bindings are missing; provision them before validating this composition', 422, { requirements })
  }
}
