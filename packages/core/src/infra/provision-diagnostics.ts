import { redactCliOutput } from './diagnostics'

const codes = [
  'provision_invalid_stage', 'provision_invalid_prefix', 'provision_invalid_handler',
  'provision_invalid_config_path', 'provision_invalid_migrations_dir', 'provision_invalid_assets_dir',
  'provision_invalid_auth_secret', 'provision_invalid_auth_base_url', 'provision_invalid_public_hostname',
  'provision_missing_public_origin', 'provision_legacy_domain', 'provision_legacy_domain_env',
  'provision_invalid_email', 'provision_invalid_webhook', 'provision_invalid_account_id',
  'provision_invalid_dev_mailbox_stage', 'provision_invalid_dev_mailbox_token',
  'provision_config_load_failed', 'provision_invalid_config', 'provision_inputs_unreadable',
  'provision_console_metadata_invalid', 'provision_console_sha_mismatch',
  'provision_requires_sst', 'provision_requires_command', 'provision_failed',
] as const
export type ProvisionDiagnosticCode = typeof codes[number]

const diagnostics = new WeakMap<object, { code: ProvisionDiagnosticCode; message: string }>()

/** Branded diagnostics; config loader messages redact deployment/environment secrets. */
export class ProvisionDiagnostic extends Error {
  readonly code: ProvisionDiagnosticCode
  constructor(code: ProvisionDiagnosticCode, detail?: { message: string; secrets: string[] }) {
    const safeCode = codes.includes(code) ? code : 'provision_failed'
    let message: string = safeCode
    if (safeCode === 'provision_invalid_public_hostname') message += ': publicHostname must be a lowercase ASCII bare hostname'
    if (safeCode === 'provision_missing_public_origin') message += ': set publicHostname or authBaseUrl (WORKBASE_PUBLIC_HOSTNAME or AUTH_BASE_URL in the standalone template)'
    if (safeCode === 'provision_legacy_domain') message += ': domain was removed; use publicHostname instead'
    if (safeCode === 'provision_legacy_domain_env') message += ': WORKBASE_DOMAIN was removed; use WORKBASE_PUBLIC_HOSTNAME instead'
    if (safeCode === 'provision_console_metadata_invalid') message += ': console build-meta.json is missing or invalid; run build:console before provisioning'
    if (safeCode === 'provision_console_sha_mismatch') message += ': console SHA does not match the HTML stamp and emitted artifacts; run build:console before provisioning'
    if (safeCode === 'provision_config_load_failed' && detail) {
      const secrets = Object.fromEntries(detail.secrets.map((value, index) => [`SECRET_${index}`, value]))
      const cause = redactCliOutput(detail.message, { ...process.env, ...secrets })
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@')
        .replace(/Bearer\s+[^\s'";,]+/gi, 'Bearer [redacted]')
        .replace(/[\r\n\x00-\x1f\x7f]+/g, ' ').slice(0, 2000)
      message += `: ${cause}`
    }
    super(message)
    this.name = 'ProvisionDiagnostic'
    this.code = safeCode
    diagnostics.set(this, { code: safeCode, message })
  }
}

export function provisionErrorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null ? diagnostics.get(error)?.message ?? 'provision_failed' : 'provision_failed'
}

export function provisionFailure(error: unknown): ProvisionDiagnostic {
  const saved = typeof error === 'object' && error !== null ? diagnostics.get(error) : undefined
  const failure = new ProvisionDiagnostic(saved?.code ?? 'provision_failed')
  if (saved) { failure.message = saved.message; diagnostics.set(failure, saved) }
  return failure
}
