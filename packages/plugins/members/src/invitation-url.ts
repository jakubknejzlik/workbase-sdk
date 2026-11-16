import type { RuntimeEnv } from '../../../core/src/types'
import { hasInvitationMailboxProof, invitationMailToken, invitationTokenSchema } from './invitation-token'

declare const verified: unique symbol
export type VerifiedInvitationAcceptUrl<P extends 'email' | 'copy' = 'email'> = string & { readonly [verified]: P }
export class InvitationLinkError extends Error {
  constructor(readonly code: 'invitation_origin_required' | 'invitation_link_invalid') { super(code) }
}

/** Configuration chooses the credential destination, never a request host. */
export function invitationOrigin(env: RuntimeEnv, localFallback?: string): string {
  const configured = env.AUTH_BASE_URL ?? env.IDENTITY?.baseURL
  try {
    const url = new URL(configured ?? localFallback ?? '')
    const local = (!env.STAGE || env.STAGE === 'local') && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((!configured && !local) || (url.protocol !== 'https:' && !local) || url.username || url.password
      || (!!configured && url.href !== `${url.origin}/`)) throw new Error()
    return url.origin
  } catch { throw new InvitationLinkError('invitation_origin_required') }
}

/** Verify the complete constructed value before handing it to any template. */
export async function verifyInvitationAcceptUrl<P extends 'email' | 'copy'>(env: RuntimeEnv, value: string, purpose: P, localFallback?: string): Promise<VerifiedInvitationAcceptUrl<P>> {
  try {
    const url = new URL(value)
    const token = url.searchParams.get('token')
    if (url.origin !== invitationOrigin(env, localFallback) || url.pathname !== '/invitations/accept' || url.username || url.password || url.hash
      || url.href !== value || [...url.searchParams.keys()].join(',') !== 'token' || !invitationTokenSchema.safeParse(token).success
      || (purpose === 'email' ? !await hasInvitationMailboxProof(env, token!) : token!.includes('.'))) throw new Error()
    return value as VerifiedInvitationAcceptUrl<P>
  } catch { throw new InvitationLinkError('invitation_link_invalid') }
}

/** Both purposes use this builder; only e-mail receives the mailbox proof. */
export async function buildInvitationAcceptUrl<P extends 'email' | 'copy'>(env: RuntimeEnv, input: { selector: string; purpose: P; localFallback?: string }): Promise<VerifiedInvitationAcceptUrl<P>> {
  if (!/^[a-f0-9]{64}$/.test(input.selector)) throw new InvitationLinkError('invitation_link_invalid')
  const url = new URL('/invitations/accept', invitationOrigin(env, input.localFallback))
  url.searchParams.set('token', input.purpose === 'email' ? await invitationMailToken(env, input.selector) : input.selector)
  return verifyInvitationAcceptUrl(env, url.href, input.purpose, input.localFallback)
}
