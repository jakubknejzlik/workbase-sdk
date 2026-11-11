import assert from 'node:assert/strict'
import type { Fixture } from './fixture.ts'
const allTools = ['describe_schema', 'query', 'list_records', 'get_record', 'create_record', 'update_record', 'delete_record', 'run_command', 'start_workflow', 'get_workflow', 'list_workflows', 'read_audit', 'whoami', 'row_access', 'invite_from_row', 'resend_row_invitation', 'cancel_row_invitation']
const workflowName = 'bookings/reserve'
const commandArgs = { name: 'jobs/transition', input: { jobId: 'seed-job', to: 'scheduled' } }
const workflowArgs = { name: workflowName, input: { slotId: 'seed-slot', clientId: 'seed-client' } }
export const cases: [string, (f: Fixture) => Promise<void>][] = [
  ['D1 stdio tools/list matches documented set and strict schemas', async f => {
    const client = await f.connect(); const tools = (await client.listTools()).tools
    assert.deepEqual(tools.map(t => t.name), allTools)
    assert.ok(tools.every(t => t.inputSchema.additionalProperties === false && t.description?.includes('Permission:')))
    const schema = await f.tool(client, 'describe_schema')
    assert.equal(schema.data.health.instance, 'sample'); assert.equal(schema.data.schema.entities.clients.fields.name.type, 'string')
    assert.ok(schema.data.schema.commands.some((c: any) => c.name === 'jobs/transition'))
    assert.ok(schema.data.schema.workflows.some((c: any) => c.name === workflowName))
  }],
  ['Q1 stdio query byte parity with HTTP across two roles, cursor, filters, includes and errors', async f => {
    for (const token of [f.dispatcher.token, f.viewer.token]) {
      const client = await f.connect(token)
      const queries = [
        { entity: 'clients', limit: 1 },
        { entity: 'clients', select: ['id', 'name'], where: { name: { contains: 'Seed' } }, orderBy: [{ field: 'name', dir: 'desc' }], limit: 10 },
        { entity: 'jobs', include: { client: { select: ['id', 'name'] } }, limit: 10 },
        { entity: 'clients', limit: 101 }, { entity: 'missing', limit: 1 },
        { entity: 'clients', where: { PRIVATE_FIELD: { eq: 'PRIVATE_VALUE' } }, limit: 1 },
      ]
      for (const query of queries) {
        const http = await f.call('/query', 'POST', query, token)
        const mcp = await client.callTool({ name: 'query', arguments: query })
        assert.deepEqual(mcp.content, [{ type: 'text', text: await http.text() }])
        assert.equal(mcp.isError, !http.ok)
      }
      const first = await f.tool(client, 'query', { entity: 'clients', limit: 1 })
      if (first.next_cursor) {
        const query = { entity: 'clients', limit: 1, cursor: first.next_cursor }
        const http = await f.call('/query', 'POST', query, token)
        assert.deepEqual((await client.callTool({ name: 'query', arguments: query })).content, [{ type: 'text', text: await http.text() }])
      }
    }
    for (const [token, org, status] of [[f.revoked.token, f.org, 401], [f.expired.token, f.org, 401], [f.dispatcher.token, f.otherOrg, 403]] as const) {
      const client = await f.connect(token, org)
      const query = { entity: 'clients', limit: 1 }
      const http = await f.call('/query', 'POST', query, token, org)
      assert.equal(http.status, status)
      assert.deepEqual((await client.callTool({ name: 'query', arguments: query })).content, [{ type: 'text', text: await http.text() }])
    }
    const relationToken = await f.issue('dispatcher', ['jobs.read'])
    const relationClient = await f.connect(relationToken.token)
    const relationQuery = { entity: 'jobs', limit: 1, include: { client: {} } }
    const relationHttp = await f.call('/query', 'POST', relationQuery, relationToken.token)
    assert.equal(relationHttp.status, 403)
    const relationText = await relationHttp.text()
    assert.equal(JSON.parse(relationText).error, 'relation_forbidden')
    assert.deepEqual((await relationClient.callTool({ name: 'query', arguments: relationQuery })).content, [{ type: 'text', text: relationText }])
    const restricted = await f.connect(f.restricted.token)
    const query = { entity: 'jobs', limit: 1 }
    const http = await f.call('/query', 'POST', query, f.restricted.token)
    assert.equal(http.status, 403)
    assert.deepEqual((await restricted.callTool({ name: 'query', arguments: query })).content, [{ type: 'text', text: await http.text() }])
  }],
  ['D2 read-only hides and refuses every mutating tool', async f => {
    const client = await f.connect(f.dispatcher.token, f.org, true)
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), allTools.filter(name => !['create_record', 'update_record', 'delete_record', 'run_command', 'start_workflow', 'invite_from_row', 'resend_row_invitation', 'cancel_row_invitation'].includes(name)))
    for (const name of ['create_record', 'update_record', 'delete_record', 'run_command', 'start_workflow', 'invite_from_row', 'resend_row_invitation', 'cancel_row_invitation']) assert.deepEqual(await f.tool(client, name), { ok: false, code: 'read_only', status: 403 })
  }],
  ['D3 schema validation errors are structured and reveal no rejected input', async f => {
    const client = await f.connect()
    for (const args of [{}, { entity: 'clients', id: 1 }, { entity: 'clients', id: 'seed-client', role: 'owner' }]) assert.deepEqual(await f.tool(client, 'get_record', args), { ok: false, code: 'validation_error', status: 400 })
  }],
  ['D4 dispatcher happy path identity CRUD atomic command workflow completion and owner audit', async f => {
    const client = await f.connect()
    const me = await f.tool(client, 'whoami'); assert.equal(me.data.actor.type, 'agent'); assert.equal(me.data.role, 'dispatcher'); assert.equal(me.data.organization_id, f.org); assert.equal(me.data.operations, null)
    assert.equal((await f.tool(client, 'list_records', { entity: 'clients', limit: 1 })).ok, true)
    const created = await f.tool(client, 'create_record', { entity: 'clients', data: { name: 'HTTP MCP client' }, idempotencyKey: 'http-client' }); assert.equal(created.ok, true)
    const id = created.data.id
    assert.deepEqual((await f.tool(client, 'get_record', { entity: 'clients', id })).data, created.data)
    const updated = await f.tool(client, 'update_record', { entity: 'clients', id, data: { name: 'Updated HTTP MCP client' }, version: 1 }); assert.equal(updated.data.version, 2)
    assert.deepEqual(await f.tool(client, 'update_record', { entity: 'clients', id, data: { name: 'stale' }, version: 1 }), { ok: false, code: 'version_conflict', status: 409 })
    const command = await f.tool(client, 'run_command', { ...commandArgs, idempotencyKey: 'http-command' }); assert.equal(command.ok, true)
    assert.deepEqual(await f.tool(client, 'run_command', { ...commandArgs, idempotencyKey: 'http-command' }), command)
    const workflow = await f.tool(client, 'start_workflow', { ...workflowArgs, idempotencyKey: 'http-workflow' }); assert.equal(workflow.ok, true)
    assert.deepEqual(await f.tool(client, 'start_workflow', { ...workflowArgs, idempotencyKey: 'http-workflow' }), workflow)
    let status = ''
    for (let i = 0; i < 8; i++) { await f.tick(); status = (await f.tool(client, 'get_workflow', { id: workflow.data.id })).data.status; if (status === 'completed') break }
    assert.equal(status, 'completed')
    assert.ok((await f.tool(client, 'list_workflows', { status: 'completed' })).data.data.some((run: any) => run.id === workflow.data.id))
    assert.deepEqual(await f.tool(client, 'read_audit'), { ok: false, code: 'owner_required', status: 403 })
    await f.relay(); const ownerClient = await f.connect(f.owner.token)
    const audit = await f.tool(ownerClient, 'read_audit', { entity: 'clients', entityId: id, limit: 90 })
    assert.deepEqual(audit.data.data.map((event: any) => event.operation).sort(), ['clients.created', 'clients.updated'])
    const workflows = await f.tool(ownerClient, 'read_audit', { entity: 'workflows', entityId: workflow.data.id, limit: 90 })
    assert.ok(workflows.data.data.some((event: any) => event.operation === 'workflow.completed'))
    assert.equal((await f.tool(client, 'delete_record', { entity: 'clients', id })).ok, true)
  }],
  ['D5 concurrent idempotent create commits exactly one row and outbox event; mismatches reject', async f => {
    const client = await f.connect()
    for (let batch = 0; batch < 100; batch++) {
      const args = { entity: 'clients', data: { name: `Idempotent MCP client ${batch}` }, idempotencyKey: `concurrent-create-${batch}` }
      const results = await Promise.all(Array.from({ length: 5 }, () => f.tool(client, 'create_record', args)))
      assert.ok(results.every(result => result.ok === true), JSON.stringify({ batch, results })); assert.ok(results.every(result => result.data.id === results[0].data.id))
      assert.equal(await f.db.prepare('SELECT count(*) AS n FROM clients WHERE name=?').bind(args.data.name).first('n'), 1)
      assert.equal(await f.db.prepare('SELECT count(*) AS n FROM idempotency_keys WHERE organization_id=? AND key=?').bind(f.org, args.idempotencyKey).first('n'), 1)
      assert.equal(await f.db.prepare("SELECT count(*) AS n FROM audit_outbox WHERE json_extract(payload,'$.entity_id')=?").bind(results[0].data.id).first('n'), 1)
      assert.deepEqual(await f.tool(client, 'create_record', { ...args, data: { name: 'mismatch' } }), { ok: false, code: 'idempotency_payload_mismatch', status: 422 })
    }
    console.log('D5_COUNTS', JSON.stringify({ batches: 100, concurrentCreates: 500, rows: 100, receipts: 100, outboxEvents: 100, mismatches: 100 }))
  }],
  ['D6 create replay rechecks role allowlist revocation and organization boundaries', async f => {
    const token = await f.issue('dispatcher', ['clients.create', 'clients.read'])
    const client = await f.connect(token.token)
    const args = { entity: 'clients', data: { name: 'Replay authorization client' }, idempotencyKey: 'live-create' }
    const created = await f.tool(client, 'create_record', args); assert.equal(created.ok, true)
    const viewer = await f.connect(f.viewer.token), restricted = await f.connect(f.restricted.token), foreign = await f.connect(token.token, f.otherOrg)
    const before = await f.snapshot()
    assert.deepEqual(await f.tool(viewer, 'create_record', args), { ok: false, code: 'permission_denied', status: 403 })
    assert.deepEqual(await f.tool(restricted, 'create_record', args), { ok: false, code: 'operation_forbidden', status: 403 })
    assert.deepEqual(await f.tool(foreign, 'create_record', args), { ok: false, code: 'organization_forbidden', status: 403 })
    assert.deepEqual(await f.snapshot(), before)
    assert.equal((await f.call(`/orgs/${f.org}/tokens/${token.id}`, 'DELETE')).status, 204)
    const revoked = await f.snapshot()
    assert.deepEqual(await f.tool(client, 'create_record', args), { ok: false, code: 'unauthenticated', status: 401 })
    assert.deepEqual(await f.snapshot(), revoked)
    assert.equal((await f.tool(await f.connect(), 'delete_record', { entity: 'clients', id: created.data.id })).ok, true)
  }],
  ['D7 keyed create audit failure rolls back record and replay receipt', async f => {
    const client = await f.connect(), before = await f.snapshot()
    await f.db.prepare("CREATE TRIGGER data_mcp_fail_audit BEFORE INSERT ON audit_outbox WHEN json_extract(NEW.payload,'$.changes.name.after')='Audit rollback client' BEGIN SELECT RAISE(ABORT,'data_mcp_test_failure'); END").run()
    try {
      assert.deepEqual(await f.tool(client, 'create_record', { entity: 'clients', data: { name: 'Audit rollback client' }, idempotencyKey: 'audit-failure' }), { ok: false, code: 'constraint_conflict', status: 409 })
      assert.deepEqual(await f.snapshot(), before)
    } finally { await f.db.prepare('DROP TRIGGER data_mcp_fail_audit').run() }
  }],
  ...(['create_record', 'update_record', 'delete_record', 'run_command', 'start_workflow'] as const).map((name): [string, (f: Fixture) => Promise<void>] => [`P viewer cannot ${name}; no domain/audit/key/token writes`, async f => {
    const client = await f.connect(f.viewer.token), before = await f.snapshot()
    const args = { create_record: { entity: 'clients', data: { name: 'DENIED' } }, update_record: { entity: 'clients', id: 'seed-client', data: { name: 'DENIED' }, version: 1 }, delete_record: { entity: 'clients', id: 'seed-client' }, run_command: commandArgs, start_workflow: workflowArgs }[name]
    assert.deepEqual(await f.tool(client, name, args), { ok: false, code: 'permission_denied', status: 403 })
    assert.deepEqual(await f.snapshot(), before)
  }]),
  ['P workflow missing from operation allowlist is denied with operation_forbidden', async f => {
    const client = await f.connect(f.restricted.token), before = await f.snapshot()
    assert.deepEqual((await f.tool(client, 'whoami')).data.operations, ['clients.read'])
    assert.deepEqual(await f.tool(client, 'start_workflow', workflowArgs), { ok: false, code: 'operation_forbidden', status: 403 }); assert.deepEqual(await f.snapshot(), before)
  }],
  ['P foreign X-Organization-Id selector is denied with organization_forbidden', async f => {
    const client = await f.connect(f.dispatcher.token, f.otherOrg), before = await f.snapshot()
    for (const [name, args] of [['list_records', { entity: 'clients' }], ['create_record', { entity: 'clients', data: { name: 'FOREIGN' } }], ['whoami', {}]] as const) assert.deepEqual(await f.tool(client, name, args), { ok: false, code: 'organization_forbidden', status: 403 })
    assert.deepEqual(await f.snapshot(), before)
  }],
  ...(['revoked', 'expired'] as const).map((kind): [string, (f: Fixture) => Promise<void>] => [`P ${kind} token returns 401 unauthenticated and writes nothing`, async f => {
    const client = await f.connect(f[kind].token), before = await f.snapshot()
    assert.deepEqual(await f.tool(client, 'create_record', { entity: 'clients', data: { name: 'DENIED' } }), { ok: false, code: 'unauthenticated', status: 401 }); assert.deepEqual(await f.snapshot(), before)
  }]),
  ['P generic entity tools cannot reach tokens members or traversal paths', async f => {
    const client = await f.connect(), before = await f.snapshot()
    for (const entity of ['tokens', 'members', 'access_tokens', '../orgs', '%2e%2e%2forgs', '__proto__']) {
      const result = await f.tool(client, 'create_record', { entity, data: { name: 'owner', role: 'owner' } }); assert.ok([400, 404].includes(result.status))
    }
    assert.deepEqual(await f.snapshot(), before)
  }],
  ['P generic workflow tools cannot reach owner cancel resume or command paths', async f => {
    const client = await f.connect(), before = await f.snapshot()
    for (const name of ['fake/cancel', 'fake/resume', '../orgs', 'bookings/../../orgs']) {
      const result = await f.tool(client, 'start_workflow', { name, input: {} }); assert.ok([400, 404].includes(result.status))
    }
    const command = await f.tool(client, 'run_command', { name: 'orgs/tokens', input: { role: 'owner' } }); assert.equal(command.ok, false)
    assert.deepEqual(await f.snapshot(), before)
  }],
  ['P oversized limit returns structured 400; API independently rejects it', async f => {
    const client = await f.connect(), before = await f.snapshot()
    assert.deepEqual(await f.tool(client, 'list_records', { entity: 'clients', limit: 100000 }), { ok: false, code: 'validation_error', status: 400 })
    const response = await f.call('/api/clients?limit=100000', 'GET', undefined, f.dispatcher.token); assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'invalid_limit' }); assert.deepEqual(await f.snapshot(), before)
  }],
]
