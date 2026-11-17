/** Shared diagnostic data; safe to import without the build-time loader. */
export interface SourceLocation { file: string; line: number; column: number }
export type SourceMap = Record<string, SourceLocation>
