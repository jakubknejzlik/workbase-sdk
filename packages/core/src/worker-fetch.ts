import type { RuntimeEnv } from './types'
import { publicConsoleResponse } from './console'
import { timed, timeRequest } from './request-timing'

type Worker = { fetch(request: Request, env: RuntimeEnv, ctx?: ExecutionContext): Response | Promise<Response> }
/** Keep public assets independent of deferred config/auth/plugin initialization. */
export function workerFetch(load: () => Promise<Worker>) {
  return (request: Request, env: RuntimeEnv, ctx?: ExecutionContext) => timeRequest(async () => {
    const response = await timed('handler', () => publicConsoleResponse(request, env))
    if (response) return response
    const worker = await timed('bootstrap', load)
    return worker.fetch(request, env, ctx)
  })
}
