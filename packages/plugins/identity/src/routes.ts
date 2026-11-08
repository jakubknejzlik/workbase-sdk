import type { App, RuntimeEnv } from '../../../core/src/types'
import type { InstanceConfig } from '@workbasehq/core/config'
import { kernelFor } from '@workbasehq/core/kernel/registry'
import { ApiError } from '../../../core/src/errors'
import { profileNamesSchema } from './profile'
export function profileRoutes(app: App, config: InstanceConfig, env: RuntimeEnv) {
  const kernel = kernelFor(config)
  app.get('/me/profile', async c => {
    c.header('Cache-Control', 'no-store')
    const actor = await kernel.requireActor(c.req.raw, env)
    if (actor.actor.type !== 'user' || !actor.user) throw new ApiError(403, 'user_required')
    return c.json(await kernel.identity.readProfile(env.DB, config, actor.user.id))
  })
  app.patch('/me/profile', async c => {
    c.header('Cache-Control', 'no-store')
    const actor = await kernel.requireActor(c.req.raw, env)
    if (actor.actor.type !== 'user' || !actor.user) throw new ApiError(403, 'user_required')
    const names = profileNamesSchema.parse(await c.req.json())
    return c.json(await kernel.identity.updateProfile(env, config, actor.user.id, names))
  })
}
