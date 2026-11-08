import { expect, it } from 'vitest'
import { request, json } from '@workbasehq/test-support/helpers'
import { setup as setupPolicyGraph } from './fixtures/policy-graph/setup'
import { env } from 'cloudflare:workers'

it('audit_query_mutation_response_masks_hidden_foreign_key', async () => {
  const app = await setupPolicyGraph()
  const read = await request(app, '/api/jobs/job-colleague', 'GET', undefined, 'reviewer')
  const readBody = await json(read)
  const patched = await request(app, '/api/jobs/job-colleague', 'PATCH', { version: 1, title: 'harmless edit' }, 'reviewer')
  const patchedBody = await json(patched)
  console.log('AUDIT_FK_MASK', JSON.stringify({ getStatus: read.status, getReport: readBody.report_id, patchStatus: patched.status, patchReport: patchedBody.report_id }))
  expect(readBody.report_id).toBeNull()
  expect(patched.status).toBe(200)
  expect(patchedBody.report_id).toBeNull()
})

it('create responses mask hidden references and preserve visible references', async () => {
  const app = await setupPolicyGraph()
  const created = await request(app, '/api/jobs', 'POST', {
    title: 'colleague job', reviewer_user_id: 'reviewer-colleague', record_id: 'record-colleague', report_id: 'report-colleague',
  }, 'reviewer')
  expect(created.status).toBe(201)
  const body = await json(created)
  expect(body.report_id).toBeNull()
  expect(body.record_id).toBe('record-colleague')
  expect(body.reviewer_user_id).toBe('reviewer-colleague')
  expect(await env.DB.prepare('SELECT report_id FROM jobs WHERE id=?').bind(body.id).first('report_id')).toBe('report-colleague')
})

it('create replay masks references using current target visibility', async () => {
  const app = await setupPolicyGraph()
  const body = { title: 'replayed job', reviewer_user_id: 'reviewer-colleague', report_id: 'report-own' }
  const create = () => app.request('http://localhost/api/jobs', {
    method: 'POST', headers: { Authorization: 'Bearer synthetic-reviewer', 'X-Organization-Id': 'org-a', 'Content-Type': 'application/json', 'Idempotency-Key': 'fk-visibility-replay' },
    body: JSON.stringify(body),
  })
  const first = await create()
  expect(first.status).toBe(201)
  const original = await json(first)
  expect(original.report_id).toBe('report-own')
  const changed = await request(app, '/api/jobs/job-own', 'PATCH', { version: 1, reviewer_user_id: 'reviewer-colleague' }, 'administrator')
  expect(changed.status).toBe(200)
  const replay = await create()
  expect(replay.status).toBe(201)
  expect(await json(replay)).toEqual({ ...original, report_id: null })
})
