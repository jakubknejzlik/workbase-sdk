import metadata from '../../package.json' with { type: 'json' }
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Protocol } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { schemas, descriptions, mutations, type ToolName } from './schemas.ts'
import { createApi, loadEnvironment, ToolError } from './client.ts'
export function createServer(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch) {
  const configuration = loadEnvironment(env)
  const api = createApi(configuration, request)
  const readOnly = configuration.WORKBASE_READ_ONLY === 'true'
  const server = new Server({ name: 'workbase-data', version: metadata.version }, { capabilities: { tools: {} },
    instructions: 'Workbase organization data over the authorized REST API. Use describe_schema and whoami to discover fields and permissions. Row invitations use live entity and invite permissions. Workflow cancel and resume are unavailable. Permission denials cannot be overridden by prompts.' })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.entries(schemas).filter(([name]) => !readOnly || !mutations.has(name as ToolName)).map(([name, schema]) => ({
    name, description: descriptions[name as ToolName], inputSchema: z.toJSONSchema(schema) as Tool['inputSchema'],
    annotations: { readOnlyHint: !mutations.has(name as ToolName), destructiveHint: name === 'delete_record', openWorldHint: false },
  })) }))
  const callSchema = CallToolRequestSchema.extend({ params: CallToolRequestSchema.shape.params.extend({ arguments: z.unknown().optional() }) })
  Protocol.prototype.setRequestHandler.call(server, callSchema, async (request, extra) => {
    let result: Record<string, unknown>; let isError = false
    const name = request.params.name as ToolName
    try {
      if (!Object.hasOwn(schemas, name)) throw new ToolError('unknown_tool', 404)
      if (readOnly && mutations.has(name)) throw new ToolError('read_only', 403)
      if (name === 'query') {
        // No second grammar or authorization path: invalid documents also reach /query.
        result = await api.call(name, request.params.arguments, extra.signal)
      } else {
        const parsed = schemas[name].safeParse(request.params.arguments === undefined ? {} : request.params.arguments)
        if (!parsed.success) throw new ToolError('validation_error', 400)
        result = { ok: true, data: await api.call(name, parsed.data, extra.signal) }
      }
    } catch (error) {
      isError = true
      result = name === 'query' ? (error instanceof ToolError && error.envelope ? error.envelope : { error: error instanceof ToolError ? error.code : 'internal_error' }) : { ok: false, code: error instanceof ToolError ? error.code : 'internal_error', status: error instanceof ToolError ? error.status : 500 }
    }
    // Query data is the HTTP projection verbatim, including caller-owned literal values.
    // Other tools retain their established credential-redaction contract.
    if (name !== 'query') result = api.redact(result)
    return CallToolResultSchema.parse({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError })
  })
  return server
}
