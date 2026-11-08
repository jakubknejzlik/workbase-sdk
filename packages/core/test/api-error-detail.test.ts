import { expect, expectTypeOf, it } from 'vitest'
import { ApiError } from '../src/errors'

it('ApiError accepts generic readonly detail metadata', () => {
  expectTypeOf<ApiError['detail']>().toEqualTypeOf<Readonly<Record<string, unknown>> | undefined>()
  const detail: Readonly<Record<string, unknown>> = { reason: 'synthetic', nested: { retry: true } }
  expect(new ApiError(400, 'validation_error', undefined, detail).detail).toBe(detail)
})
