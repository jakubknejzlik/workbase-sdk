import sample from './sample/config'
import { createApp } from '../../src/app'
import type { RuntimeEnv } from '../../src/types'

// A standalone bundle, never imported into the Vitest runner. Each configured
// service runs this in its own workerd isolate, sharing only the D1/KV bindings.
let isolateId: string | undefined
let requests = 0
export default {
  async fetch(request: Request, env: RuntimeEnv) {
    isolateId ??= crypto.randomUUID()
    const response = await createApp(sample, { ...env, IDENTITY: { baseURL: 'http://localhost', secret: 'synthetic-workbase-test-secret-at-least-32', localPassword: true } }).fetch(request)
    response.headers.set('X-Evidence-Isolate', isolateId)
    response.headers.set('X-Evidence-Requests', String(++requests))
    return response
  },
}
