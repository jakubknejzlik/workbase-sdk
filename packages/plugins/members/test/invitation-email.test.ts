import { describe, expect, it } from 'vitest'
import { renderInvitationEmail, type InvitationEmailInput } from '../src/emails/invitation-email'

const base: InvitationEmailInput = {
  kind: 'invite', inviterDisplayName: 'Alex Example', organizationName: 'Sample Organization',
  roleLabel: 'Contributor', expiresAt: new Date('2026-10-28T14:05:06Z'), timeZone: 'Europe/Prague',
  acceptUrl: 'https://console.example.test/invitation?token=synthetic&source=email',
  configuredOrigin: 'https://console.example.test', language: 'en',
}
const variants = (['en', 'cs'] as const).flatMap(language =>
  (['invite', 'reminder'] as const).map(kind => ({ language, kind })))

function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  })[entity]!)
}
const visibleText = (html: string): string => decodeHtml(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

describe('Members invitation email', () => {
  it.each(variants)('renders $kind in $language with equivalent key facts in HTML and text', variant => {
    const result = renderInvitationEmail({ ...base, ...variant })
    const english = variant.language === 'en'
    const reminder = variant.kind === 'reminder'
    expect(result.subject).toBe(`${reminder ? english ? 'Reminder: ' : 'Připomenutí: ' : ''}Alex Example ${english ? 'invites you to the organization Sample Organization on Workbase' : 'vás zve do organizace Sample Organization ve Workbase'}`)
    expect(result.preheader).toBe(`${reminder ? english ? 'Reminder: Your invitation from ' : 'Připomenutí: Čeká na vás pozvánka od ' : english ? 'An invitation from ' : 'Pozvánka od '}Alex Example ${english ? 'to the organization Sample Organization on Workbase' : 'do organizace Sample Organization ve Workbase'}${reminder && english ? ' is waiting.' : '.'}`)
    const expiryDate = english ? '28 October 2026' : '28. října 2026'
    const htmlText = visibleText(result.html)
    for (const fact of [base.inviterDisplayName, base.organizationName!, base.roleLabel, base.acceptUrl,
      expiryDate, '15:05:06', 'GMT+01:00', '(Europe/Prague)',
      english ? 'valid for seven days' : 'platí sedm dní',
      english ? 'Accept invitation' : 'Přijmout pozvánku',
      english ? 'you can ignore this email' : 'můžete tento e-mail ignorovat',
      english ? 'This email was sent by Workbase.' : 'Tento e-mail byl odeslán z aplikace Workbase.']) {
      expect(result.text).toContain(fact)
      expect(htmlText).toContain(fact)
    }
    // Every plain-text block also occurs in the HTML, including reminder introduction.
    for (const block of result.text.split('\n\n')) expect(htmlText).toContain(block)
    expect(result.html).toContain(`<html lang="${variant.language}">`)
    expect(result.html).toContain('bgcolor="#00e6a0"')
    expect(result.html).toContain('mso-hide:all;')
    expect(result.html).not.toMatch(/<script\b|<img\b|<link\b|<style\b|url\(/i)
    const hrefs = [...result.html.matchAll(/href="([^"]*)"/g)].map(match => decodeHtml(match[1]))
    expect(hrefs).toEqual([base.acceptUrl, base.acceptUrl])
    for (const output of Object.values(result)) {
      expect(output).not.toMatch(/private-brand|workspaces?|pracovn(?:í|ího|ím|ích|ími)\s+prostor/iu)
    }
  })

  it.each(variants)('supports single-tenant $kind in $language without an organization', variant => {
    const result = renderInvitationEmail({ ...base, ...variant, organizationName: undefined })
    expect(result.subject).toContain(base.inviterDisplayName)
    expect(result.subject).toContain(variant.language === 'en' ? 'to Workbase' : 'do Workbase')
    for (const value of Object.values(result)) {
      expect(value).not.toMatch(/Sample Organization|undefined|null|organization|organizace/)
    }
  })

  it.each(['en', 'cs'] as const)('uses a distinct manual-reminder subject, preheader and introduction in %s', language => {
    const invite = renderInvitationEmail({ ...base, language })
    const reminder = renderInvitationEmail({ ...base, language, kind: 'reminder' })
    expect(reminder.subject).toBe(`${language === 'en' ? 'Reminder: ' : 'Připomenutí: '}${invite.subject}`)
    expect(reminder.preheader).not.toBe(invite.preheader)
    const intro = language === 'en' ? 'This is a reminder that Alex Example' : 'Připomínáme, že Alex Example'
    expect(reminder.text).toContain(intro)
    expect(visibleText(reminder.html)).toContain(intro)
    expect(invite.text).not.toContain(intro)
  })

  it('defaults to English without reading instance configuration', () => {
    expect(renderInvitationEmail({ ...base, language: undefined })).toEqual(renderInvitationEmail({ ...base, language: 'en' }))
  })

  it.each(variants)('escapes all display strings for $kind in $language without changing plain text', variant => {
    const attack = `\"><img src=x onerror='alert(1)'> & <script>bad()</script>`
    const values = {
      inviterDisplayName: `Inviter ${attack}`, organizationName: `Organization ${attack}`, roleLabel: `Role ${attack}`,
    }
    const result = renderInvitationEmail({ ...base, ...variant, ...values })
    for (const value of Object.values(values)) {
      expect(result.html).not.toContain(value)
      expect(result.text).toContain(value)
      expect(visibleText(result.html)).toContain(value)
    }
    expect(result.subject).toContain(values.inviterDisplayName)
    expect(result.subject).toContain(values.organizationName)
    expect(result.html).toContain('&quot;&gt;&lt;img src=x onerror=&#39;alert(1)&#39;&gt; &amp; &lt;script&gt;')
    expect(result.html).not.toMatch(/<(?:img|script)\b/i)
  })

  it('escapes URL quotes and ampersands in attributes and readable fallback without altering the link', () => {
    const acceptUrl = `${base.acceptUrl}&label="quoted"'value'<tag>`
    const result = renderInvitationEmail({ ...base, acceptUrl })
    expect(result.html).toContain('&amp;label=&quot;quoted&quot;&#39;value&#39;&lt;tag&gt;')
    expect([...result.html.matchAll(/href="([^"]*)"/g)].map(match => decodeHtml(match[1]))).toEqual([acceptUrl, acceptUrl])
    expect(visibleText(result.html)).toContain(acceptUrl)
    expect(result.text).toContain(acceptUrl)
  })

  it.each([
    'http://console.example.test/invitation', 'javascript:alert(1)', 'data:text/html,bad',
    '//console.example.test/invitation', '/invitation', 'https://evil.example.test/invitation',
    'https://console.example.test.evil.test/invitation', 'https://console.example.test:444/invitation',
    'https://console.example.test@evil.example.test/invitation', 'https://user:password@console.example.test/invitation',
    'https://console.example.test\\@evil.example.test/invitation', ' https://console.example.test/invitation',
    'https://console.example.test/invitation\nInjected:header', 'https:console.example.test/invitation',
  ])('rejects unsafe or foreign acceptance URL %j', acceptUrl => {
    expect(() => renderInvitationEmail({ ...base, acceptUrl })).toThrow()
  })

  it.each([
    'http://console.example.test', 'https://evil.example.test', 'https://console.example.test/path',
    'https://console.example.test?redirect=evil', 'https://console.example.test#fragment',
    'https://console.example.test?', 'https://console.example.test#',
    'https://user@console.example.test', '',
  ])('rejects invalid or mismatched configured origin %j', configuredOrigin => {
    expect(() => renderInvitationEmail({ ...base, configuredOrigin })).toThrow()
  })

  it('accepts a configured HTTPS origin with a trailing slash and normalized default port', () => {
    expect(renderInvitationEmail({ ...base, configuredOrigin: 'https://console.example.test:443/' })).toEqual(renderInvitationEmail(base))
  })

  it.each(['inviterDisplayName', 'organizationName', 'roleLabel'] as const)('rejects empty values and header injection in %s', field => {
    for (const value of [' ', 'Name\r\nBcc: injected@example.test', 'Name\nInjected', 'Name\u0000', 'Name\u2028Injected']) {
      expect(() => renderInvitationEmail({ ...base, [field]: value })).toThrow(/Invalid invitation email/)
    }
  })

  it.each(['en', 'cs'] as const)('formats exact instants across both Prague DST transitions in %s', language => {
    const dates = [
      ['2026-03-29T00:30:00Z', '01:30:00', 'GMT+01:00', language === 'en' ? '29 March 2026' : '29. března 2026'],
      ['2026-03-29T01:30:00Z', '03:30:00', 'GMT+02:00', language === 'en' ? '29 March 2026' : '29. března 2026'],
      ['2026-10-25T00:30:00Z', '02:30:00', 'GMT+02:00', language === 'en' ? '25 October 2026' : '25. října 2026'],
      ['2026-10-25T01:30:00Z', '02:30:00', 'GMT+01:00', language === 'en' ? '25 October 2026' : '25. října 2026'],
      ['2026-12-31T23:30:00Z', '00:30:00', 'GMT+01:00', language === 'en' ? '1 January 2027' : '1. ledna 2027'],
    ]
    for (const [instant, time, offset, date] of dates) {
      for (const kind of ['invite', 'reminder'] as const) {
        const expiresAt = new Date(instant)
        const result = renderInvitationEmail({ ...base, language, kind, expiresAt })
        for (const fact of [date, time, offset, '(Europe/Prague)']) {
          expect(result.text).toContain(fact)
          expect(visibleText(result.html)).toContain(fact)
        }
        expect(expiresAt.toISOString()).toBe(instant.replace('Z', '.000Z'))
      }
    }
  })

  it('uses the supplied instance timezone rather than a fixed Prague offset or the host default', () => {
    const result = renderInvitationEmail({ ...base, timeZone: 'America/New_York' })
    expect(result.text).toContain('10:05:06 GMT-04:00 (America/New_York)')
  })

  it.each(['', ' ', 'invalid/timezone'])('rejects absent or invalid timezone %j', timeZone => {
    expect(() => renderInvitationEmail({ ...base, timeZone })).toThrow()
  })

  it('rejects an invalid expiry', () => {
    expect(() => renderInvitationEmail({ ...base, expiresAt: new Date('invalid') })).toThrow(/expiry/)
  })

  it('fails closed for unsupported runtime language and kind values', () => {
    expect(() => renderInvitationEmail({ ...base, language: 'de' as 'en' })).toThrow(/language/)
    expect(() => renderInvitationEmail({ ...base, kind: 'scheduled' as 'invite' })).toThrow(/kind/)
  })

  it('is deterministic and leaves inputs unchanged', () => {
    const input = Object.freeze({ ...base })
    const expiry = input.expiresAt.getTime()
    expect(renderInvitationEmail(input)).toEqual(renderInvitationEmail(input))
    expect(input.expiresAt.getTime()).toBe(expiry)
  })
})

it('allows HTTP only for explicit local development with a matching loopback origin', () => {
  const input = { ...base, configuredOrigin: 'http://localhost:19540', acceptUrl: 'http://localhost:19540/invitations/accept?token=synthetic' }
  expect(() => renderInvitationEmail(input)).toThrow(/HTTPS/)
  expect(renderInvitationEmail({ ...input, allowLocalHttp: true }).text).toContain(input.acceptUrl)
})
it.each(['http://example.test', 'http://localhost.example.test', 'http://127.0.0.2', 'http://localhost@evil.test'])('local development never permits non-loopback origin %s', origin => {
  expect(() => renderInvitationEmail({ ...base, configuredOrigin: origin, acceptUrl: `${origin}/invitation`, allowLocalHttp: true })).toThrow(/HTTPS/)
})

it.each(variants)('synthetic HTML/text snapshot: $kind $language', variant => {
  expect(renderInvitationEmail({ ...base, ...variant })).toMatchSnapshot()
})
