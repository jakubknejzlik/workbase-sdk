// Defense in depth for local logs; values are used only for redaction, never output.
const sensitive = Object.entries(process.env)
  .filter(([key, value]) => /secret|token|password|credential|api.?key|private.?terms/i.test(key) && value && value.length >= 6)
  .map(([, value]) => value)
exports.redact = value => {
  let result = String(value)
  for (const secret of sensitive) result = result.split(secret).join('[REDACTED]')
  return result
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:secret|password|token|cookie|authorization)["']?\s*[:=]\s*)[^\r\n,}]+/gi, '$1[REDACTED]')
}
