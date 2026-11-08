/// <reference path="./.sst/platform/config.d.ts" />
export default $config({
  app(input) {
    return {
      name: '{{INSTANCE_SELECTOR}}',
      home: 'cloudflare',
      providers: { cloudflare: '6.19.0' },
      removal: input.stage === 'production' ? 'retain' : 'remove',
      protect: input.stage === 'production',
    }
  },
  async run() {
    const { provision } = await import('@workbasehq/core/infra/provision')
    const { consoleAssetsDir } = await import('@workbasehq/plugins/console/assets')
    const required = (key: string) => {
      const value = process.env[key]
      if (!value) throw new Error(`Set ${key} before running SST`)
      return value
    }
    const domain = process.env.WORKBASE_DOMAIN?.replaceAll('{stage}', $app.stage)
    const deployed = await provision({
      configPath: './config.ts', handler: './src/index.ts', migrationsDir: './migrations',
      resourcePrefix: required('WORKBASE_RESOURCE_PREFIX'), stage: $app.stage,
      authSecret: required('BETTER_AUTH_SECRET'), authBaseUrl: required('AUTH_BASE_URL').replaceAll('{stage}', $app.stage),
      assetsDir: consoleAssetsDir(),
      ...(domain ? { domain } : {}),
      email: { from: required('EMAIL_FROM') },
    })
    return { url: deployed.url, databaseId: deployed.databaseId }
  },
})
