export class ApiError extends Error {
  constructor(public status: number, public code: string, public hint?: string, public detail?: Readonly<Record<string, unknown>>) { super(code) }
}
