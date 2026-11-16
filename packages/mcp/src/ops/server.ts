import { organizationNameReasons, type OrganizationNameReason } from '@workbasehq/core/organization-name'
import metadata from '../../package.json' with { type: 'json' }
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Protocol } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { schemas, descriptions, type ToolName } from './schemas.ts'
import { createApi, loadEnvironment, ToolError } from './client.ts'

export function createServer(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch) {
  const configuration = loadEnvironment(env)
  const api = createApi(configuration, request)
  const available = (name: string) => Object.hasOwn(schemas, name) && (name !== 'read_dev_mail' || Boolean(configuration.WORKBASE_DEV_MAILBOX_URL))
  const server = new Server({ name: 'workbase-ops', version: metadata.version }, { capabilities: { tools: {} },
    instructions: 'Operator-only Workbase onboarding. Sign in and verify the owner before provision_organization, or bootstrap_instance_owner for Members without Organizations. read_dev_mail intentionally exposes development credentials through the separate dev/test mailbox sidecar when configured. Authority and destination come only from operator environment configuration.' })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.entries(schemas).filter(([name]) => available(name)).map(([name, schema]) => ({
    name, description: descriptions[name as ToolName], inputSchema: z.toJSONSchema(schema, { io: 'input' }) as Tool['inputSchema'],
    annotations: { readOnlyHint: name === 'read_dev_mail', destructiveHint: false, openWorldHint: false },
  })) }))
  const callSchema = CallToolRequestSchema.extend({ params: CallToolRequestSchema.shape.params.extend({ arguments: z.unknown().optional() }) })
  Protocol.prototype.setRequestHandler.call(server, callSchema, async (request, extra) => {
    let result: Record<string, unknown>; let isError = false
    try {
      const name = request.params.name as ToolName
      if (!available(name)) throw new ToolError('unknown_tool', 404)
      const parsed = schemas[name].safeParse(request.params.arguments === undefined ? {} : request.params.arguments)
      if (!parsed.success) {
        const reason = parsed.error.issues.find(issue => issue.path.length === 1 && issue.path[0] === 'name')?.message
        if (name === 'provision_organization' && organizationNameReasons.includes(reason as OrganizationNameReason)) {
          throw new ToolError('invalid_organization_name', 400, { field: 'name', reason: reason as OrganizationNameReason })
        }
        throw new ToolError('validation_error', 400)
      }
      result = { ok: true, data: await api.call(name, parsed.data, extra.signal) }
    } catch (error) {
      isError = true
      result = { ok: false, code: error instanceof ToolError ? error.code : 'internal_error', status: error instanceof ToolError ? error.status : 500, ...(error instanceof ToolError && error.detail ? { detail: error.detail } : {}) }
    }
    result = api.redact(result)
    return CallToolResultSchema.parse({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError })
  })
  return server
}
