import { expect, it } from 'vitest'
import { normalizeListConfig } from '@workbasehq/core/config'
import config, { workerList } from '../examples/list-v2-workers'
import { KernelRegistry } from '../src/kernel/registry'
import { consoleModel } from '../src/console-model'
import { loadActorProjection } from '../src/policies'
import { scopeOperations } from '../src/scope-operations'
import type { Scope } from '../src/types'

it('loads the public Workers example through shipped validators without mutating authoring input', () => {
  const list = config.ui!.entities.workers.list!
  expect(list.columns!.map(column => column.field)).toEqual(['name', 'team_id', 'location_id', 'phone', 'status', 'created_at'])
  expect(list.filter!.status).toEqual({ kind: 'enum', placement: 'panel', operators: ['in'] })
  expect(list.views!.find(view => view.id === 'invited')!.where).toEqual({})
  expect(normalizeListConfig(config, 'workers', list)).toEqual(list)
  expect(workerList.columns[1]).toBe('team_id')
})

it('projects usable canonical list hints and the gated access control from the example', async () => {
  const scope: Scope = { role: 'owner', organizationId: 'example', correlationId: 'example', actor: { type: 'user', id: 'owner' } }
  scopeOperations.set(scope, { operations: null })
  await loadActorProjection(config, scope, async <T>() => ({ id: 'owner', user_id: 'owner', organization_id: 'example', role: 'owner' }) as T)
  const model = consoleModel(new KernelRegistry(config), scope)
  expect(model.contractVersion).toBe(2)
  expect(model.model.entities.workers.list!.rowAccess).toEqual({ column: true, placement: 'panel' })
  expect(model.model.entities.workers.list!.views!.map(view => view.id)).toEqual(['all', 'active', 'inactive', 'invited'])
})
