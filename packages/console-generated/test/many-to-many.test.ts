import { expect, it, vi } from 'vitest'
import { memberships, syncMemberships } from '../src/many-to-many'
import type { Model, Relation } from '../src/read'
const model = { limits: { root: 1 } } as Model
const relation: Relation = { entity: 'joins', field: 'entry', cardinality: '1:n', through: { entity: 'choices', field: 'choice', createCommand: 'joins/create', deleteCommand: 'joins/delete' } }
const join = { id: 'join', entry: 'one', choice: 'category' }
it('A3 follows all cursors and accepts a complete empty membership set', async () => {
  const read = vi.fn().mockResolvedValueOnce({ data: [join], next_cursor: 'next' }).mockResolvedValueOnce({ data: [{ ...join, id: 'other', choice: 'other' }], next_cursor: null })
  expect(await memberships(model, relation, 'one', read)).toEqual([join, { ...join, id: 'other', choice: 'other' }])
  expect(read.mock.calls[1][0].cursor).toBe('next')
  expect(await memberships(model, relation, 'one', async () => ({ data: [], next_cursor: null }))).toEqual([])
})
it.each([
  { data: [join] },
  { data: [join], next_cursor: '' },
  { data: [{ id: 'join', entry: 'one' }], next_cursor: null },
  { data: [{ ...join, entry: 'another-record' }], next_cursor: null },
  { next_cursor: null },
])('A3/A8 incomplete membership response %j cannot remove joins', async page => {
  const read = vi.fn().mockResolvedValue(page), write = vi.fn()
  await expect(syncMemberships(model, relation, 'one', [], read, write)).rejects.toThrow('incomplete_membership_read')
  expect(write).not.toHaveBeenCalled()
})
it('A3/A8 a failed later page or cyclic cursor never turns a partial read into an empty desired set', async () => {
  for (const failure of ['error', 'cycle']) {
    const read = vi.fn().mockResolvedValueOnce({ data: [join], next_cursor: 'next' }), write = vi.fn()
    if (failure === 'error') read.mockRejectedValueOnce(new Error('unavailable'))
    else read.mockResolvedValueOnce({ data: [], next_cursor: 'next' })
    await expect(syncMemberships(model, relation, 'one', [], read, write)).rejects.toThrow()
    expect(write).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(2)
  }
})
