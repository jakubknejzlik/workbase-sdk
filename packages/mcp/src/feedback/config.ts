import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { FeedbackError, id } from './schemas.ts'

const login = z.string().max(100).regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\[bot\])?$/)
const path = z.string().min(1).max(4096).refine(isAbsolute)
export const configSchema = z.strictObject({
  owner: login, repository: z.string().max(100).regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/).refine(v => v !== '..'),
  label: z.string().min(1).max(50).regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/),
  replierLogins: z.array(login).min(1).max(20), agentId: id, stateDirectory: path, credential: z.strictObject({ tokenFile: path }),
})
export type Configuration = z.infer<typeof configSchema>
export function loadConfiguration(env: NodeJS.ProcessEnv): Configuration {
  try { return configSchema.parse(JSON.parse(env.WORKBASE_FEEDBACK_TARGET || '')) } catch { throw new FeedbackError('invalid_operator_configuration') }
}
// TODO #325: unify with the shared operator credential provider after it merges.
// Never accepts a token/path from a tool call, persists a token, or propagates IO errors.
export async function tokenFromFile(config: Configuration) {
  let handle
  try {
    handle = await open(config.credential.tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 4096) throw new Error()
    const token = (await handle.readFile('utf8')).trim()
    if (!/^[a-zA-Z0-9_.-]{8,4096}$/.test(token)) throw new Error()
    return token
  } catch { throw new FeedbackError('credential_unavailable', 503) }
  finally { await handle?.close() }
}
