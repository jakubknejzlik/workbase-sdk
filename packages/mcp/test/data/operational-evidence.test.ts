import { expect, test, vi } from 'vitest'
import { queryClient } from './query-client'

test('read_operations forwards only bounded filters with the selected organization and stays read-only', async () => {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ data: [{ source: 'webhook', error_code: 'delivery_failed', attempts: 5 }], next_offset: 2 }))
  const { client, close } = await queryClient(request, 'synthetic-evidence-token', 'org-a')
  try {
    const tools = await client.listTools()
    expect(tools.tools.find(tool => tool.name === 'read_operations')?.annotations?.readOnlyHint).toBe(true)
    const result = await client.callTool({ name: 'read_operations', arguments: { source: 'webhook', limit: 2, offset: 0 } })
    expect(result.isError).not.toBe(true)
    expect(request.mock.calls[0][0]).toBe('http://localhost/audit/operations?source=webhook&limit=2&offset=0')
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer synthetic-evidence-token', 'X-Organization-Id': 'org-a' } })
    for (const args of [{ organization_id: 'org-b' }, { limit: 101 }, { offset: -1 }, { source: 'security_log' }]) {
      expect((await client.callTool({ name: 'read_operations', arguments: args })).isError).toBe(true)
    }
    expect(request).toHaveBeenCalledTimes(1)
  } finally { await close() }
})
test('read_operations preserves API permission denial and redacts reflected credentials', async () => {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: 'token_operation_forbidden' }, { status: 403 }))
  const { client, close } = await queryClient(request, 'synthetic-evidence-token')
  try {
    const result = await client.callTool({ name: 'read_operations', arguments: {} })
    expect(result.structuredContent).toEqual({ ok: false, code: 'token_operation_forbidden', status: 403 })
    expect(JSON.stringify(result)).not.toContain('synthetic-evidence-token')
  } finally { await close() }
})
