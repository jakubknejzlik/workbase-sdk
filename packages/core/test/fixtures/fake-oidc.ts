import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { createHash } from 'node:crypto'
export const FAKE_ISSUER = 'http://127.0.0.1:8878'
export interface FakeUser { sub: string; email: string; verified?: boolean }
/** Local, one-use authorization-code issuer. All issued ID tokens are signed by jose.
 * The HTTP harness exposes fetch() on 8878; workerd tests route the HTTP fetch transport to this in-process issuer.
 */
export async function fakeOIDC(issuer = FAKE_ISSUER, appOrigin: string | readonly string[] = 'http://localhost') {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
  const badKey = await generateKeyPair('ES256')
  const jwks = { keys: [{ ...await exportJWK(publicKey), kid: 'local-test', alg: 'ES256', use: 'sig' }] }
  const discovery = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['ES256'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'] }
  const codes = new Map<string, { challenge: string; redirect: string; idToken: string }>()
  const exchanges: { code: string; verifier: string; challenge: string }[] = []
  let user: FakeUser = { sub: 'external-1', email: 'external@example.test' }
  let tokenOverrides: Record<string, unknown> = {}
  async function authorize(url: URL) {
    if (url.searchParams.get('client_id') !== 'test-client' || url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256' || !url.searchParams.get('nonce') || !url.searchParams.get('state')) return new Response('invalid authorize', { status: 400 })
    const redirect = url.searchParams.get('redirect_uri')!
    const registeredOrigins = typeof appOrigin === 'string' ? [appOrigin] : appOrigin
    if (!registeredOrigins.some(origin => redirect === `${origin}/auth/callback/oidc`)) return new Response('invalid redirect', { status: 400 })
    const idToken = await new SignJWT({ email: user.email, email_verified: user.verified ?? true, name: 'Synthetic OIDC user', nonce: url.searchParams.get('nonce'), ...tokenOverrides })
      .setProtectedHeader({ alg: 'ES256', kid: 'local-test' }).setIssuer(String(tokenOverrides.iss ?? issuer)).setAudience(String(tokenOverrides.aud ?? 'test-client')).setSubject(user.sub).setIssuedAt().setExpirationTime((tokenOverrides.exp ?? '5m') as string | number).sign(tokenOverrides.badSignature ? badKey.privateKey : privateKey)
    const code = crypto.randomUUID()
    codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect, idToken })
    const callback = new URL(redirect)
    callback.searchParams.set('code', code); callback.searchParams.set('state', url.searchParams.get('state')!); callback.searchParams.set('iss', issuer)
    return Response.redirect(callback.toString(), 302)
  }
  function token(body: string) {
    const params = new URLSearchParams(body); const code = params.get('code')!; const pending = codes.get(code); codes.delete(code)
    const verifier = params.get('code_verifier') ?? ''
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    if (!pending || params.get('grant_type') !== 'authorization_code' || params.get('client_id') !== 'test-client' || params.get('client_secret') !== 'test-secret' || params.get('redirect_uri') !== pending.redirect || challenge !== pending.challenge) return { status: 400, body: { error: 'invalid_grant' } }
    exchanges.push({ code, verifier, challenge })
    return { status: 200, body: { access_token: 'local-access-token', token_type: 'Bearer', expires_in: 300, id_token: pending.idToken } }
  }
  return {
    issuer, jwks, discovery, exchanges, token,
    setUser(value: FakeUser) { user = value },
    overrideClaims(value: Record<string, unknown>) { tokenOverrides = value },
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname === '/.well-known/openid-configuration') return Response.json(discovery)
      if (url.pathname === '/jwks') return Response.json(jwks)
      if (url.pathname === '/authorize') return authorize(url)
      if (url.pathname === '/token' && request.method === 'POST') { const result = token(await new Response(await request.arrayBuffer()).text()); return Response.json(result.body, { status: result.status }) }
      return new Response('not found', { status: 404 })
    },
  }
}
