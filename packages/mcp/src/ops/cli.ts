import { createApi, loadEnvironment, ToolError } from './client.ts'
import { schemas } from './schemas.ts'

export async function run(args: string[], env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch) {
  let api: ReturnType<typeof createApi> | undefined
  try {
    if (args.length !== 3 || args[0] !== 'bootstrap-instance-owner' || args[1] !== '--owner-email') throw new ToolError('invalid_arguments', 400)
    const parsed = schemas.bootstrap_instance_owner.safeParse({ ownerEmail: args[2] })
    if (!parsed.success) throw new ToolError('validation_error', 400)
    api = createApi(loadEnvironment(env), request)
    const result = await api.call('bootstrap_instance_owner', parsed.data)
    return { exitCode: 0, result: api.redact({ ok: true, data: result }) }
  } catch (error) {
    const result = { ok: false, code: error instanceof ToolError ? error.code : 'internal_error', status: error instanceof ToolError ? error.status : 500 }
    return { exitCode: 1, result: api ? api.redact(result) : result }
  }
}
