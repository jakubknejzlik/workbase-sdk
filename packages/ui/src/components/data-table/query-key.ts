/** Shared prefix for list/hydration fetches and successful-write invalidation. */
export const createDataTableQueryKey = (...parts: unknown[]) => ['data-table', ...parts] as const
