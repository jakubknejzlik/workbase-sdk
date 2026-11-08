const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
const bytes = (value: string) => Uint8Array.from(value.match(/.{2}/g) ?? [], n => parseInt(n, 16))
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)))
export const randomSalt = () => hex(crypto.getRandomValues(new Uint8Array(16)))
export const sha256 = async (value: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
export async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: bytes(salt), iterations: 100000, hash: 'SHA-256' }, key, 256)))
}
export function equalHash(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export function ulid(now = Date.now()) {
  let time = now; let id = ''
  for (let i = 0; i < 10; i++) { id = alphabet[time % 32] + id; time = Math.floor(time / 32) }
  for (const b of crypto.getRandomValues(new Uint8Array(16))) id += alphabet[b & 31]
  return id
}

export async function signWebhook(secret: string, payload: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))))
}

/** Same SHA-256/base64url hash used for Better Auth magic-link verification rows. */
export async function magicLinkTokenHash(token: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  return btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
