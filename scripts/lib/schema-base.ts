export function schemaBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : env.CI ? 'HEAD' : 'origin/main'
}
