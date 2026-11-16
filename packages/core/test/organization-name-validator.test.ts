import { expect, it } from 'vitest'
import { organizationNameCases } from '../../test-support/src/organization-name-cases'
import { validateOrganizationName, organizationNameSchema } from '../src/organization-name'

it.each(organizationNameCases)('pure validator and Zod schema: $label', c => {
  expect(validateOrganizationName(c.input)).toEqual(c.reason ? { ok: false, reason: c.reason } : { ok: true, value: c.value })
  const parsed = organizationNameSchema.safeParse(c.input)
  expect(parsed.success).toBe(!c.reason)
  if (parsed.success) expect(parsed.data).toBe(c.value)
  else expect(parsed.error.issues).toMatchObject([{ message: c.reason, params: { reason: c.reason } }])
})
