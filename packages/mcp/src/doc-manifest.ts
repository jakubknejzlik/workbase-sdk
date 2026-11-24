/** Names are the public enum and the release copier's single allowlist. */
export const docNames = ['getting-started.md', 'mcp-composition.md', 'migration-0.4.0.md', 'onboarding.md'] as const
export type DocName = typeof docNames[number]
/** Fixed package-relative destinations: caller strings are never resolved as paths. */
export const docFiles: Record<DocName, string> = {
  'getting-started.md': 'docs/getting-started.md',
  'mcp-composition.md': 'docs/mcp-composition.md',
  'migration-0.4.0.md': 'docs/migration-0.4.0.md',
  'onboarding.md': 'docs/onboarding.md',
}
