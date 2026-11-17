import { isIP } from 'node:net'
import { ProvisionDiagnostic } from './provision-diagnostics'

export interface PublicOriginOptions {
  publicHostname?: string
  authBaseUrl?: string
}

export interface ProvisionWarning {
  code: 'provision_auth_origin_overridden' | 'provision_auth_fallback_ignored'
  message: string
}

export interface ResolvedPublicOrigin {
  publicOrigin: string
  /** Present only when a Cloudflare Custom Domain should be attached. */
  publicHostname?: string
  warnings: ProvisionWarning[]
}

function hostname(value: string): string {
  if (typeof value !== 'string' || !value || /[^a-z0-9.-]/.test(value)) {
    throw new ProvisionDiagnostic('provision_invalid_public_hostname')
  }
  const labels = value.split('.')
  if (value.length > 253 || labels.length < 2 || labels.some(label =>
    label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new ProvisionDiagnostic('provision_invalid_public_hostname')
  }
  try {
    // Also reject URL-parser IP shorthands (127.1, numeric/hex IPv4) and invalid punycode.
    const parsed = new URL(`https://${value}`).hostname
    if (parsed !== value || isIP(parsed)) throw 0
  } catch { throw new ProvisionDiagnostic('provision_invalid_public_hostname') }
  return value
}

function httpsOrigin(value: string): string {
  try {
    if (typeof value !== 'string' || /[\s\\]/.test(value)) throw 0
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw 0
    return url.origin
  } catch { throw new ProvisionDiagnostic('provision_invalid_auth_base_url') }
}

/** Pure resolution, with fixed diagnostics/warnings that never echo caller input. */
export function resolvePublicOrigin(options: PublicOriginOptions): ResolvedPublicOrigin {
  if ('domain' in options) throw new ProvisionDiagnostic('provision_legacy_domain')
  if (options.publicHostname !== undefined) {
    const publicHostname = hostname(options.publicHostname)
    const publicOrigin = `https://${publicHostname}`
    const warnings: ProvisionWarning[] = []
    if (options.authBaseUrl !== undefined) {
      let fallback: string | undefined
      try { fallback = httpsOrigin(options.authBaseUrl) }
      catch {
        warnings.push({ code: 'provision_auth_fallback_ignored', message: 'AUTH_BASE_URL is invalid and was ignored; publicHostname supplies the public origin' })
      }
      if (fallback !== undefined && fallback !== publicOrigin) {
        warnings.push({ code: 'provision_auth_origin_overridden', message: 'AUTH_BASE_URL differs from the publicHostname origin; publicHostname takes precedence' })
      }
    }
    return { publicOrigin, publicHostname, warnings }
  }
  if (options.authBaseUrl === undefined) throw new ProvisionDiagnostic('provision_missing_public_origin')
  return { publicOrigin: httpsOrigin(options.authBaseUrl), warnings: [] }
}
