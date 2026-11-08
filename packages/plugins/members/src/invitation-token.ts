import { z } from 'zod'
import type { RuntimeEnv } from '../../../core/src/types'
import { equalHash, signWebhook } from '@workbasehq/core/crypto'

export const invitationTokenSchema = z.string().regex(/^[a-f0-9]{64}(?:\.[a-f0-9]{64})?$/)
export const invitationSelector = (token: string) => token.split('.')[0]
const secret = (env: RuntimeEnv) => env.IDENTITY?.secret ?? env.BETTER_AUTH_SECRET
const message = (token: string) => `workbase.invitation.mailbox.v1\0${token}`

/** Only the mail transport receives this proof; management/copy-link responses never do. */
export async function invitationMailToken(env: RuntimeEnv, token: string) {
  const key = secret(env)
  return key ? `${token}.${await signWebhook(key, message(token))}` : token
}

export async function hasInvitationMailboxProof(env: RuntimeEnv, token: string) {
  const [selector, proof] = token.split('.')
  const key = secret(env)
  return !!key && !!proof && equalHash(proof, await signWebhook(key, message(selector)))
}
