import { beforeEach, expect, it } from 'vitest'
import config from '../../../core/test/fixtures/sample/config'
import { runtime, setup } from '@workbasehq/test-support/helpers'
import { KernelRegistry } from '@workbasehq/core/kernel/registry'
import { invitationMail } from '../src/mail'

beforeEach(async () => { await setup() })

it.each<{ locale: 'en' | 'cs'; role: string; enumLabels?: Record<string, Record<string, string>>; label: string }>([
  { locale: 'en' as const, role: 'viewer', enumLabels: undefined, label: 'Viewer' },
  { locale: 'cs' as const, role: 'viewer', enumLabels: undefined, label: 'Čtenář' },
  { locale: 'en' as const, role: 'viewer', enumLabels: { en: { value_viewer: 'Custom & role' } }, label: 'Custom & role' },
  { locale: 'cs' as const, role: 'viewer', enumLabels: { cs: { value_viewer: 'Custom & role' } }, label: 'Custom & role' },
  { locale: 'en' as const, role: 'custom_role', enumLabels: undefined, label: 'custom_role' },
  { locale: 'cs' as const, role: 'custom_role', enumLabels: undefined, label: 'custom_role' },
])('renders configured, core or raw role labels: $locale $role $label', async ({ locale, role, enumLabels, label }) => {
  const kernel = new KernelRegistry({ ...config, locale, enumLabels })
  const mail = await invitationMail(runtime(), kernel.config, 'fixed-mail', 'org-a', 'recipient@example.test',
    `http://localhost/invitation?token=${'a'.repeat(64)}`, {
      inviterId: 'owner-a', role, kind: 'invite', expiresAt: '2026-11-04T12:00:00Z',
    })
  const { bindings } = mail.intent('2026-11-04T12:00:00Z')
  expect(bindings![6]).toContain(`${locale === 'en' ? 'Your role' : 'Vaše role'}: ${label}.`)
  expect(bindings![7]).toContain(label.replaceAll('&', '&amp;'))
  expect(bindings![7]).toContain(`<html lang="${locale}">`)
})
