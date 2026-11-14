import { z } from 'zod'
import doc from './worker-access/openapi.json'

/** Independent JSON Schema interpreter in workerd; includes local component refs. */
export function responseContract(path: keyof typeof doc.paths, method = 'get', status = '200') {
  const schema = (doc.paths[path] as any)[method].responses[status].content['application/json'].schema
  const input = JSON.parse(JSON.stringify({ ...schema, $defs: doc.components.schemas }).replaceAll('#/components/schemas/', '#/$defs/'))
  return z.fromJSONSchema(input)
}
