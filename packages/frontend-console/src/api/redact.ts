/** Identifiers remain useful; credential-shaped metadata must never be displayed. */
export function isCredentialShaped(value: string, context: 'value' | 'identifier' = 'value'): boolean {
  if (context === 'identifier') return false
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return false
  return /bearer\s|(?:sk|wb)_[a-z0-9]|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(value)
    || /(?:^|[^a-z0-9_-])[a-z0-9_-]{32,}(?:$|[^a-z0-9_-])/i.test(value)
    || /(?:^|[^a-z0-9_-])[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+(?:$|[^a-z0-9_-])/i.test(value)
}
export function isCredentialKey(key: string): boolean {
  return /password|token|secret|credential|authorization|cookie|salt|email|key/i.test(key)
}
