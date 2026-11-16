import { z } from 'zod'
import { ApiError } from './errors'

export const organizationNameReasons = ['required', 'not_string', 'empty', 'too_long', 'control_character', 'line_separator', 'hidden_character', 'nonstandard_space', 'invalid_character', 'url_not_allowed'] as const
export type OrganizationNameReason = typeof organizationNameReasons[number]
export type OrganizationNameResult = { ok: true; value: string } | { ok: false; reason: OrganizationNameReason }

/** #122: normalize first; length is measured in Unicode code points. */
export function validateOrganizationName(input: string): OrganizationNameResult {
  // Only ordinary spaces may be trimmed; forbidden boundary characters must survive validation.
  const value = input.replace(/^ +| +$/g, '').normalize('NFC')
  if (!value) return { ok: false, reason: 'empty' }
  if ([...value].length > 200) return { ok: false, reason: 'too_long' }
  if (/\p{Cc}/u.test(value)) return { ok: false, reason: 'control_character' }
  if (/[\p{Zl}\p{Zp}]/u.test(value)) return { ok: false, reason: 'line_separator' }
  if (/\p{Cf}/u.test(value)) return { ok: false, reason: 'hidden_character' }
  if ([...value].some(char => char !== ' ' && /\p{Zs}/u.test(char))) return { ok: false, reason: 'nonstandard_space' }
  if (/[\p{Cn}\p{Co}\p{Cs}]/u.test(value)) return { ok: false, reason: 'invalid_character' }
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(value)) return { ok: false, reason: 'url_not_allowed' }
  return { ok: true, value }
}

export const organizationNameSchema = z.string({ error: issue => issue.input === undefined ? 'required' : 'not_string' }).transform((input, ctx) => {
  const result = validateOrganizationName(input)
  if (result.ok) return result.value
  ctx.addIssue({ code: 'custom', message: result.reason, params: { reason: result.reason } })
  return z.NEVER
})

/** HTTP inputs and core write guards share the same field-level ApiError. */
export const organizationNameApiSchema = organizationNameSchema.catch(ctx => {
  const reason = ctx.error.issues[0]?.message
  throw new ApiError(400, 'invalid_organization_name', undefined, { field: 'name', reason })
})
export const requireOrganizationName = (input: string): string => organizationNameApiSchema.parse(input)
