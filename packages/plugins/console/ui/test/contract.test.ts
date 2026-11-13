import { expect, test } from 'vitest'
import { buildPath, entityDetailPage, param, parseParams } from '../src/index'

test('data params, required recordParam and exact buildPath bindings', () => {
  const page = entityDetailPage('worker', { title: 'worker.detail', recordParam: 'workerId' })
  expect(page.params).toEqual({ workerId: { kind: 'id', entity: 'worker' } })
  expect(buildPath('/workers/$workerId', { workerId: 'a/b' })).toBe('/workers/a%2Fb')
  expect(() => buildPath('/workers/$workerId', {})).toThrow('params')
  expect(() => buildPath('/workers/$workerId', { workerId: 'a', id: 'b' })).toThrow('params')
  expect(parseParams({ q: param.string({ default: '' }), n: param.int({ min: 1 }) }, { n: '2' })).toEqual({ q: '', n: 2 })
  expect(() => parseParams({ n: param.int({ min: 1 }) }, { n: '2oops' })).toThrow()
})

// Consumer type imports retain defineEntity's literal field names.
import type worker from '../../../../core/test/fixtures/config-era/schema/worker'
import { layout } from '../src/index'
layout<typeof worker>(['name'])
// @ts-expect-error unknown field must fail without typing through config
layout<typeof worker>(['not_a_field'])
// @ts-expect-error detail pages never assume an id parameter
entityDetailPage('worker', { title: 'worker.detail' })
