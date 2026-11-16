import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import { createApp, type RuntimeEnv } from '@workbasehq/core'
import { workerInvitationConfig } from './worker-invitation-config'

let app: ReturnType<typeof createApp> | undefined
let failNext = true
const messages: { to: string; text: string; html: string }[] = []
// A transport fake, not an outbox reader: only actual EMAIL.send calls land here.
const EMAIL = { async send(message: { to: string; text: string; html: string }) {
  if (failNext) { failNext = false; throw new Error('synthetic provider failure') }
  messages.push(message)
} }
export default { async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
  if (new URL(request.url).pathname === '/__test/mail' && request.headers.get('Authorization') === 'Bearer worker-local-control') {
    return Response.json({ messages }, { headers: { 'Cache-Control': 'no-store' } })
  }
  app ??= createApp(workerInvitationConfig, { ...env, EMAIL: EMAIL as unknown as SendEmail, EMAIL_FROM: 'noreply@example.test' })
  return app.fetch(request, env, ctx)
} }
