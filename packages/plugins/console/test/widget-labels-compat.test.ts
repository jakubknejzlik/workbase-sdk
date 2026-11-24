import { expect, it } from 'vitest'
import { createApp } from '@workbasehq/core/app'
import type { ConsoleModelContract } from '@workbasehq/core/console-contract'
import { request, runtime, setup } from '@workbasehq/test-support/helpers'
import { neutralConfig } from '../../../frontend-console/e2e/runtime/widget-labels-0.4.0-config'

// This fixture is byte-identical to e2e/runtime/config.ts at ea5f478 (0.4.0).
it.each([false, true])('starts and projects the unchanged 0.4.0 dashboard (EN-only: %s)', async englishOnly => {
  const config = neutralConfig()
  expect(config.enumLabels).toBeUndefined()
  if (englishOnly) config.enumLabels = { en: { 'Specimen count': 'Localized specimen count' } }
  await setup(config)
  const app = createApp(config, runtime())
  expect((await request(app, '/health')).status).toBe(200)
  const response = await request(app, '/o/org-a/console-model')
  expect(response.status).toBe(200)
  const body = await response.json() as ConsoleModelContract
  expect(body.console?.pages.find(page => page.id === 'neutral.summary')?.widgets?.map(widget => widget.label)).toEqual(['Specimen count', 'Recent specimens'])
  expect(body.model.enumLabels).toEqual(englishOnly ? config.enumLabels : undefined)
})
