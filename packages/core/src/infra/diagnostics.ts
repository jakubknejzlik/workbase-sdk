export { MigrationDiagnostic, internalMigrationMessage } from '../migrations/diagnostics'

/** Redact literal and JSON-escaped values, including secrets in otherwise safe fields. */
export function redactCliOutput(text: string, env: NodeJS.ProcessEnv): string {
  const secrets = Object.entries(env).filter(([name, value]) => value && /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL/i.test(name))
    .flatMap(([, value]) => [value!, JSON.stringify(value!).slice(1, -1)])
  for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, '[redacted]')
  return text
}
