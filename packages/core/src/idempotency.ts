import { sha256 } from './crypto'
// Canonical JSON makes property ordering irrelevant, including nested operation inputs.
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
export async function requestHash(command: string, input: unknown) {
  return sha256(JSON.stringify(canonical({ command, input })))
}
