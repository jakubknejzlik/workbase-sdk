import { FeedbackError } from './schemas.ts'

// Conservative pilot refusal, not a general confidentiality classifier. Operators
// must review summaries; ambiguous source material needs a public-safe rewrite.
// One list drives outbound refusal and inbound redaction for known formats.
const credentialPatterns = [
  /github_pat_[\w]+|gh[pousr]_[\w]+/i,
  /bearer\s+\S+/i,
  /sk-[a-zA-Z0-9_-]{12,}/i,
  /\bxox[abposr]-[a-zA-Z0-9-]+/i,
  /\bnpm_[a-zA-Z0-9]+/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/i,
  /-----BEGIN [\w ]*PRIVATE KEY(?:-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$))?/i,
  /eyJ[\w-]+\.[\w-]+\.[\w-]+/i,
  /(?:password|secret|api[_-]?key|access[_-]?token|token|credential|session|authorization|cookie)["']?\s*[:=]\s*["']?\S+/i,
]
const sensitive = /(?:slack\.com|slack:\/\/|(?:\+\d[\d ()-]{7,}\d|\(\d{3}\)\s*\d{3}[- ]\d{4})|\b(?:\d{1,3}\.){3}\d{1,3}\b|(?:raw|private)\s+(?:logs?|data)|stack\s*trace|customer\s+(?:data|name|email)|personal\s+(?:data|name|email)|attachments?\s*[:=]|(?:\bat\s+\S+\([^\n]+:\d+:\d+\))|[a-zA-Z0-9+/]{100,}={0,2})/i
const emails = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-zA-Z0-9.-]{1,253}\.[a-zA-Z]{2,63}/g
const urls = /https?:\/\/[^\s<>"\\)]+/gi
function unsafe(text: string, token: string) {
  if (text.includes(token) || credentialPatterns.some(pattern => pattern.test(text)) || sensitive.test(text)) return true
  if ([...text.matchAll(emails)].some(m => !m[0].toLowerCase().endsWith('@example.test'))) return true
  return [...text.matchAll(urls)].some(m => !/^https:\/\/github\.com\/[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+\/(?:issues|pull|releases)\//.test(m[0]) || /\.(?:png|jpe?g|pdf|zip|txt|log)(?:[?#]|$)/i.test(m[0]))
}
export function assertPublic(value: unknown, token: string) {
  const visit = (v: unknown): void => {
    if (typeof v === 'string' && unsafe(v, token)) throw new FeedbackError('unsafe_public_data')
    if (Array.isArray(v)) v.forEach(visit)
    else if (v && typeof v === 'object') Object.values(v).forEach(visit)
  }
  visit(value)
  if (JSON.stringify(value).length > 48000) throw new FeedbackError('public_data_too_large')
}
export function redactText(value: string, token: string, limit = 8000) {
  // Remove the known credential over the full bounded API body before clipping;
  // earlier replacements can shift a later credential across the output edge.
  // Bound the remaining prose regex work, with lookahead before final truncation.
  const bounded = value.replaceAll(token, '[REDACTED]').slice(0, limit + 8192)
  return credentialPatterns.reduce((text, pattern) => text.replace(new RegExp(pattern.source, 'gi'), '[REDACTED]'), bounded)
    .replace(/\+\d[\d ()-]{7,}\d|\(\d{3}\)\s*\d{3}[- ]\d{4}|\b(?:\d{1,3}\.){3}\d{1,3}\b|[a-zA-Z0-9+/]{100,}={0,2}/g, '[REDACTED]')
    .replace(emails, match => match.toLowerCase().endsWith('@example.test') ? match : '[REDACTED]')
    .replace(urls, match => /^https:\/\/github\.com\//.test(match) ? match : '[REDACTED URL]')
    .replace(/^.*(?:(?:raw|private)\s+(?:logs?|data)|customer\s+(?:data|name|email)|personal\s+(?:data|name|email)|stack\s*trace).*$/gim, '[REDACTED PRIVATE CONTENT]').slice(0, limit)
}
export function redact<T>(value: T, token: string): T {
  const visit = (v: unknown): unknown => typeof v === 'string' ? redactText(v, token) : Array.isArray(v) ? v.map(visit) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)])) : v
  return visit(value) as T
}
export const renderPublic = (value: unknown) => JSON.stringify(value, null, 2).replaceAll('@', '@\u200b')
