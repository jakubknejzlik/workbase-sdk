export interface InvitationEmailInput {
  /** A reminder is an explicit manual resend, never a scheduled notification. */
  kind: 'invite' | 'reminder'
  inviterDisplayName: string
  /** Omit for an instance with no Organizations plugin. */
  organizationName?: string
  roleLabel: string
  /** Server-calculated expiry under the fixed seven-day invitation policy. */
  expiresAt: Date
  /** Instance IANA timezone, e.g. Europe/Prague. Never uses the host timezone. */
  timeZone: string
  acceptUrl: string
  /** Trusted instance configuration, supplied independently of acceptUrl. */
  configuredOrigin: string
  /** The instance supplies the invitation language. */
  language?: 'en' | 'cs'
  /** Explicit local development transport; production still requires HTTPS. */
  allowLocalHttp?: boolean
}

export interface RenderedInvitationEmail {
  subject: string
  preheader: string
  html: string
  text: string
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!)

function displayValue(value: string, field: string): string {
  // These values also occur in a mail subject. Do not allow header/line injection.
  if (!value.trim() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    throw new TypeError(`Invalid invitation email ${field}`)
  }
  return value.trim()
}

function httpsUrl(value: string, allowLocalHttp = false): URL {
  const local = allowLocalHttp && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/i.test(value)
  if (value !== value.trim() || /[\u0000-\u0020\u007f\\]/u.test(value) || (!/^https:\/\//i.test(value) && !local)) {
    throw new TypeError('Invitation email URLs must be absolute HTTPS URLs')
  }
  const url = new URL(value)
  if ((url.protocol !== 'https:' && !local) || url.username || url.password) {
    throw new TypeError('Invitation email URLs must use HTTPS without credentials')
  }
  return url
}

/**
 * Pure Members-owned renderer: no transport, storage, clock or configuration reads.
 * The caller resolves authorized display metadata and the seven-day expiry first.
 * The exact acceptance URL is preserved in both bodies after origin validation.
 */
export function renderInvitationEmail(input: InvitationEmailInput): RenderedInvitationEmail {
  const language = input.language ?? 'en'
  if (language !== 'en' && language !== 'cs') throw new TypeError('Unsupported invitation email language')
  if (input.kind !== 'invite' && input.kind !== 'reminder') throw new TypeError('Unsupported invitation email kind')
  const inviter = displayValue(input.inviterDisplayName, 'inviterDisplayName')
  const organization = input.organizationName === undefined ? undefined : displayValue(input.organizationName, 'organizationName')
  const role = displayValue(input.roleLabel, 'roleLabel')
  const origin = httpsUrl(input.configuredOrigin, input.allowLocalHttp)
  const accept = httpsUrl(input.acceptUrl, input.allowLocalHttp)
  if (origin.href !== `${origin.origin}/` || accept.origin !== origin.origin) {
    throw new TypeError('Invitation acceptance URL must match the configured HTTPS origin')
  }
  if (!Number.isFinite(input.expiresAt.getTime())) throw new TypeError('Invalid invitation email expiry')
  // Intl defaults to the host timezone when given undefined; require an explicit one.
  if (!input.timeZone?.trim()) throw new TypeError('Invitation email requires an instance timezone')
  const expiry = new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'cs-CZ', {
    timeZone: input.timeZone, year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).format(input.expiresAt) + ` (${input.timeZone})`
  const reminder = input.kind === 'reminder'
  const destination = language === 'en'
    ? organization ? `the organization ${organization} on Workbase` : 'Workbase'
    : organization ? `organizace ${organization} ve Workbase` : 'Workbase'
  const invitation = language === 'en'
    ? `${inviter} invites you to ${destination}`
    : `${inviter} vás zve do ${destination}`
  const subject = `${reminder ? language === 'en' ? 'Reminder: ' : 'Připomenutí: ' : ''}${invitation}`
  const copy = language === 'en' ? {
    heading: reminder ? 'Reminder: Your Workbase invitation' : 'Your Workbase invitation',
    preheader: reminder ? `Reminder: Your invitation from ${inviter} to ${destination} is waiting.` : `An invitation from ${inviter} to ${destination}.`,
    greeting: 'Hello,',
    intro: reminder ? `This is a reminder that ${inviter} invites you to ${destination}.` : `${invitation}.`,
    role: `Your role: ${role}.`,
    instructions: 'Use the button below to review and accept your invitation:',
    cta: 'Accept invitation',
    fallback: 'Or use this link:',
    expiry: `This invitation is valid for seven days and expires on ${expiry}.`,
    ignore: 'If you were not expecting this invitation, you can ignore this email.',
    attribution: 'This email was sent by Workbase.',
  } : {
    heading: reminder ? 'Připomenutí: Vaše pozvánka do Workbase' : 'Vaše pozvánka do Workbase',
    preheader: reminder ? `Připomenutí: Čeká na vás pozvánka od ${inviter} do ${destination}.` : `Pozvánka od ${inviter} do ${destination}.`,
    greeting: 'Dobrý den,',
    intro: reminder ? `Připomínáme, že ${inviter} vás zve do ${destination}.` : `${invitation}.`,
    role: `Vaše role: ${role}.`,
    instructions: 'Kliknutím na tlačítko si můžete pozvánku prohlédnout a přijmout:',
    cta: 'Přijmout pozvánku',
    fallback: 'Nebo použijte tento odkaz:',
    expiry: `Tato pozvánka platí sedm dní a vyprší ${expiry}.`,
    ignore: 'Pokud jste tuto pozvánku neočekávali, můžete tento e-mail ignorovat.',
    attribution: 'Tento e-mail byl odeslán z aplikace Workbase.',
  }
  const paragraph = (value: string): string => `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#1a1a2e;">${escapeHtml(value)}</p>`
  const url = escapeHtml(input.acceptUrl)
  const html = `<!DOCTYPE html>
<html lang="${language}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#f8f9fc;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(copy.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8f9fc;"><tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">
<tr><td align="center" style="padding:24px;border-bottom:3px solid #00e6a0;font-size:24px;font-weight:bold;color:#0a0a5e;">Workbase</td></tr>
<tr><td style="padding:32px;">
<h1 style="margin:0 0 24px;font-size:22px;line-height:30px;text-align:center;color:#0a0a5e;">${escapeHtml(copy.heading)}</h1>
${[copy.greeting, copy.intro, copy.role, copy.instructions].map(paragraph).join('\n')}
<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:12px auto 28px;"><tr><td align="center" bgcolor="#00e6a0" style="background-color:#00e6a0;border-radius:6px;mso-padding-alt:14px 32px;"><a href="${url}" style="display:inline-block;padding:14px 32px;color:#0a0a5e;font-size:16px;line-height:24px;font-weight:bold;text-decoration:none;">${escapeHtml(copy.cta)}</a></td></tr></table>
${paragraph(copy.fallback)}
<p style="margin:0 0 20px;word-break:break-all;overflow-wrap:anywhere;"><a href="${url}" style="color:#0a0a5e;font-size:13px;line-height:20px;text-decoration:underline;">${url}</a></p>
${paragraph(copy.expiry)}
${paragraph(copy.ignore)}
</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #e5e7eb;font-size:12px;line-height:20px;text-align:center;color:#6b7280;">${escapeHtml(copy.attribution)}</td></tr>
</table></td></tr></table>
</body></html>`
  const text = ['Workbase', copy.preheader, copy.heading, copy.greeting, copy.intro, copy.role,
    copy.instructions, copy.cta, copy.fallback, input.acceptUrl, copy.expiry, copy.ignore, copy.attribution].join('\n\n')
  return { subject, preheader: copy.preheader, html, text }
}
