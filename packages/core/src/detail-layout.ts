import { z } from 'zod'
import type { ConsoleDetailSection } from './console-contract'

export const detailSectionsSchema = z.array(z.union([
  z.strictObject({ fields: z.literal('info') }),
  z.strictObject({ row: z.array(z.string().min(1)).min(1).max(3) }),
]))

/** Shared by canonical model UI and explicit Console display contributions. */
export function validateDetailLayout(entity: string, relations: Record<string, { many?: boolean }>, sections?: ConsoleDetailSection[]) {
  const seen = new Set<string>()
  for (const section of sections ?? []) for (const key of section.row ?? ['info']) {
    if (key !== 'info' && !relations[key]?.many) throw new Error(`Unknown UI detail layout card: ${entity}.${key}`)
    if (seen.has(key)) throw new Error(`Duplicate UI detail layout card: ${entity}.${key}`)
    seen.add(key)
  }
}
