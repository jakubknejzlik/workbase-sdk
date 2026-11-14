export function register(file: string, pid: number | undefined): void
export function stopGroups(file: string, graceMs?: number, killMs?: number): Promise<void>
export function stopGroupsSync(file: string, graceMs?: number, killMs?: number): void
