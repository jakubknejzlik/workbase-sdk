import '@workbasehq/plugins/local-auth/better-auth-als-preseed'
import { createApp, type RuntimeEnv } from '@workbasehq/core'
import { bootstrap } from '@workbasehq/test-support/bootstrap'
import { workerAccessFixture } from '../../../../../core/test/fixtures/worker-access'
const config = workerAccessFixture()
let app: ReturnType<typeof createApp> | undefined
let publicOrigin: string | undefined
let bootDelay = 0, serverSHA = 'a'.repeat(40)
export default { async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
  const url = new URL(request.url)
  if (bootDelay && (url.pathname === '/me' || url.pathname.endsWith('/capabilities'))) await new Promise(resolve => setTimeout(resolve, bootDelay))
  if (url.pathname === '/build.json') return Response.json({ sha: serverSHA })
  if (url.pathname.startsWith('/__test/') && request.headers.get('X-Test-Control') === 'synthetic-ui-control') {
    if (url.pathname === '/__test/seed') {
      const candidate = request.headers.get('X-Test-Origin') ?? ''
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(candidate)) return new Response('Invalid test origin', { status: 400 })
      publicOrigin = candidate
      await bootstrap(env.DB, config)
      await env.DB.exec("INSERT INTO organizations VALUES ('org-a','A'),('org-b','B')")
      for (const role of ['admin', 'staff', 'candidate']) {
        const now = new Date().toISOString()
        await env.DB.prepare('INSERT INTO users (id,email,password_hash,salt,organization_id,name,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(role, role + '@example.test', 'x', 'x', 'org-a', role, role === 'admin' ? 'admin' : 'staff', now, now).run()
        await env.DB.prepare('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES (?,?,?,1,?,?)').bind(role, role, role + '@example.test', now, now).run()
        await env.DB.prepare('INSERT INTO identity_profiles (user_id,first_name,last_name,updated_at) VALUES (?,?,?,?)').bind(role, role, 'Example', now).run()
        await env.DB.prepare("INSERT INTO identities VALUES (?,'local','local',?,?)").bind(role, role, now).run()
        await env.DB.prepare('INSERT INTO memberships VALUES (?,?,?)').bind(role, 'org-a', role === 'admin' ? 'admin' : 'staff').run()
      }
      for (const [id, name] of [['own', 'Staff self'], ['other', 'Foreign bytes']]) await env.DB.prepare('INSERT INTO worker (id,organization_id,name,user,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(id, 'org-a', name, id === 'own' ? 'staff' : null, 'now', 'now').run()
    } else if (url.pathname === '/__test/invitation') {
      const id = url.searchParams.get('id')
      if (request.method === 'POST') {
        if (url.searchParams.get('state') === 'expired') await env.DB.prepare("UPDATE invitations SET expires_at='2000-01-01' WHERE id=?").bind(id).run()
        if (url.searchParams.get('state') === 'revoked') await env.DB.prepare("UPDATE invitations SET revoked_at='2026-01-01' WHERE id=?").bind(id).run()
      }
      return Response.json(await env.DB.prepare('SELECT bound_user_id,accepted_at,(SELECT count(*) FROM memberships m JOIN "user" u ON u.id=m.user_id WHERE lower(u.email)=lower(invitations.email)) AS members FROM invitations WHERE id=?').bind(id).first())
    } else if (url.pathname === '/__test/mail') {
      return Response.json({ link: await env.DB.prepare('SELECT body FROM email_outbox WHERE recipient=? ORDER BY created_at DESC LIMIT 1').bind(url.searchParams.get('email')).first('body') })
    } else if (url.pathname === '/__test/boot-delay') bootDelay = url.searchParams.get('ms') === '1500' ? 1500 : 0
    else if (url.pathname === '/__test/build') serverSHA = /^[0-9a-f]{40}$/.test(url.searchParams.get('sha') ?? '') ? url.searchParams.get('sha')! : 'a'.repeat(40)
    else if (url.pathname === '/__test/demote') await env.DB.exec("UPDATE memberships SET role='staff' WHERE user_id='admin'")
    else if (url.pathname === '/__test/promote') await env.DB.exec("UPDATE memberships SET role='admin' WHERE user_id='admin'")
    return Response.json({ ok: true })
  }
  // Vite proxies the same-origin browser API to this isolated test Worker.
  if (!publicOrigin) return new Response('Seed first', { status: 503 })
  const runtime = { ...env, IDENTITY: { baseURL: publicOrigin, secret: 'synthetic-access-secret-at-least-32' } }
  const headers = new Headers(request.headers); headers.set('Host', new URL(publicOrigin).host)
  const original = new Request<unknown, CfProperties>(publicOrigin + url.pathname + url.search, new Request(request, { headers }))
  app ??= createApp(config, runtime)
  return app.fetch(original, runtime, ctx)
} }
