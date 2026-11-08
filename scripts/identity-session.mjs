// Local D1 mail sink only. Never print the link, cookie or issued Bearer.
import assert from 'node:assert/strict'

export async function magicSession(base, db, email, request = fetch) {
  const started = await request(`${base}/auth/sign-in/magic-link`, { method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, callbackURL: '/me' }) })
  assert.equal(started.status, 200, 'Magic-link request succeeds')
  const link = await db.prepare("SELECT body FROM email_outbox WHERE recipient=? AND subject='Workbase sign-in' ORDER BY rowid DESC LIMIT 1").bind(email).first('body')
  assert.ok(link, 'Magic link delivered to local sink')
  assert.equal(new URL(link).origin, base, 'Local sink link uses the configured origin')
  const verified = await request(link, { redirect: 'manual' })
  assert.equal(verified.status, 302, 'Magic-link verification succeeds')
  const token = verified.headers.get('set-auth-token')
  assert.ok(token, 'Better Auth issued a Bearer')
  const cookie = verified.headers.getSetCookie().find(value => value.startsWith('__Host-workbase.session='))
  assert.ok(cookie && ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/'].every(attribute => cookie.includes(attribute)), 'Protected session cookie issued')
  assert.equal(await db.prepare('SELECT count(*) AS n FROM sessions').first('n'), 0, 'No legacy sessions seeded or issued')
  // The bearer plugin emits the signed cookie value; D1 stores its opaque token part.
  const opaque = decodeURIComponent(token).split('.')[0]
  assert.equal(await db.prepare('SELECT count(*) AS n FROM "session" WHERE token=?').bind(opaque).first('n'), 1, 'Bearer belongs to Better Auth')
  return token
}
