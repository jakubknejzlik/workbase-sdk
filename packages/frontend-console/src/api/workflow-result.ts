import { isCredentialKey, isCredentialShaped } from './redact'
/** Results are operation-owned objects, never a reason to display credentials. */
export function redactWorkflowResult(value: unknown, redacted: string): unknown {
  if (Array.isArray(value)) return value.map(item => redactWorkflowResult(item, redacted))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !isCredentialKey(key)).map(([key, item]) => [key, redactWorkflowResult(item, redacted)]))
  if (typeof value === 'string' && isCredentialShaped(value)) return redacted
  return value
}
