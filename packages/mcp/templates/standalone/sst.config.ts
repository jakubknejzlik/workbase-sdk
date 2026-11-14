// SST injects these at deployment time; local checks need no provider download.
declare const $app: { stage: string }
declare function $config<T>(config: T): T
export default $config({
  app(input: { stage: string }) {
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
    const emailFrom = process.env.EMAIL_FROM
    const mailboxToken = process.env.WORKBASE_DEV_MAILBOX_TOKEN
    if (emailFrom && mailboxToken) throw new Error('EMAIL_FROM cannot be combined with WORKBASE_DEV_MAILBOX_TOKEN')
    if (mailboxToken && !['dev', 'test'].includes($app.stage)) throw new Error('WORKBASE_DEV_MAILBOX_TOKEN requires dev or test stage')
    const domain = process.env.WORKBASE_DOMAIN?.replaceAll('{stage}', $app.stage)
    const deployed = await provision({
      configPath: './runtime.ts', handler: './src/index.ts', migrationsDir: './migrations',
      resourcePrefix: required('WORKBASE_RESOURCE_PREFIX'), stage: $app.stage,
      authSecret: required('BETTER_AUTH_SECRET'), authBaseUrl: required('AUTH_BASE_URL').replaceAll('{stage}', $app.stage),
      assetsDir: consoleAssetsDir(),
      ...(domain ? { domain } : {}),
      opsToken: required('WORKBASE_OPS_TOKEN'),
      ...(mailboxToken ? { devMailbox: { token: mailboxToken } } : { email: { from: required('EMAIL_FROM') } }),
    })
    return { url: deployed.url, databaseId: deployed.databaseId,
      ...(deployed.devMailboxUrl ? { devMailboxUrl: deployed.devMailboxUrl } : {}) }
  },
})
