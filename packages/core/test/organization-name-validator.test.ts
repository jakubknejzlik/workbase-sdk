import { expect, it } from 'vitest'
import { organizationNameCases, organizationNameTypeCases } from '../../test-support/src/organization-name-cases'
import { validateOrganizationName, organizationNameSchema, organizationNameApiSchema } from '../src/organization-name'

it.each(organizationNameCases)('pure validator and Zod schema: $label', c => {
  expect(validateOrganizationName(c.input)).toEqual(c.reason ? { ok: false, reason: c.reason } : { ok: true, value: c.value })
  const parsed = organizationNameSchema.safeParse(c.input)
  expect(parsed.success).toBe(!c.reason)
  if (parsed.success) expect(parsed.data).toBe(c.value)
  else expect(parsed.error.issues).toMatchObject([{ message: c.reason, params: { reason: c.reason } }])
})

it.each(organizationNameTypeCases)('schema name type: $label', c => {
  const parsed = organizationNameSchema.safeParse(c.input)
  expect(parsed.success).toBe(false)
  if (!parsed.success) expect(parsed.error.issues).toMatchObject([{ message: c.reason }])
})

it.each([...organizationNameCases, ...organizationNameTypeCases])('API schema: $label', c => {
  if (c.reason) expect(() => organizationNameApiSchema.parse(c.input)).toThrow(expect.objectContaining({
    status: 400, code: 'invalid_organization_name', detail: { field: 'name', reason: c.reason },
  }))
  else expect(organizationNameApiSchema.parse(c.input)).toBe(c.value)
})
