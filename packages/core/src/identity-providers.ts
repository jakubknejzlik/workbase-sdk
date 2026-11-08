import { z } from 'zod'
export const emailSchema = z.email().transform(value => value.toLowerCase())
