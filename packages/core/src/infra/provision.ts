import type { ComponentResourceOptions, Input, Output } from '@pulumi/pulumi'
import type { local } from '@pulumi/command'
import { createProvisionPlan, type ProvisionOptions } from './provision-plan'
import { ProvisionDiagnostic, provisionFailure } from './provision-diagnostics'
import { sstCommand } from './sst-runtime'
import type { CloudflareRuntime, DatabaseResource, KvResource, NativeBinding, QueueResource, SstRuntime, WorkerResource, CronResource } from './sst-runtime'

export { createProvisionPlan, validateProvisionOptions, type ProvisionOptions, type ProvisionPlan } from './provision-plan'
export { ProvisionDiagnostic, provisionErrorMessage, type ProvisionDiagnosticCode } from './provision-diagnostics'

// These names are supplied by SST's run-time config bundler, including in npm
// dependencies. Type-only declarations disappear before SST injects its imports.
declare const sst: SstRuntime
declare const cloudflare: CloudflareRuntime
declare const $util: Pick<typeof import('@pulumi/pulumi'), 'output' | 'secret'>
declare const $cli: { paths: { platform: string } }

export interface ProvisionResult {
  stage: string
  url: Output<string | undefined>
  workerName: Output<string>
  databaseId: Output<string>
  eventsQueueName: Output<string>
  deadLetterQueueName: Output<string>
  resources: {
    database: DatabaseResource; audit: KvResource; events: QueueResource; deadLetter: QueueResource
    migrations: local.Command; worker: WorkerResource; consumer: import('@pulumi/pulumi').Resource; cron: CronResource
  }
}

/** Single-instance SST Cloudflare provisioning. Call inside sst.config.ts run().
 * No resources are registered until all local inputs and expected schema are prepared. */
export async function provision(options: ProvisionOptions): Promise<ProvisionResult> {
  const plan = await createProvisionPlan(options)
  if (typeof sst === 'undefined' || typeof cloudflare === 'undefined' || typeof $util === 'undefined' || typeof $cli === 'undefined') throw new ProvisionDiagnostic('provision_requires_sst')
  const accountId = options.accountId ?? process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID
  if (!accountId || !/^[a-f0-9]{32}$/.test(accountId)) throw new ProvisionDiagnostic('provision_invalid_account_id')
  const command = sstCommand($cli.paths.platform)
  try {
    const protect = options.protect ?? options.stage === 'production'
    const protection = { protect, retainOnDelete: protect }
    const db = new sst.cloudflare.D1(`${plan.id}DB`, { accountId, transform: { database: (args, opts) => {
      args.name = plan.names.database; Object.assign(opts, protection)
    } } }, protection)
    const audit = new sst.cloudflare.Kv(`${plan.id}Audit`, { accountId, transform: { namespace: (args, opts) => {
      args.title = plan.names.audit; Object.assign(opts, protection)
    } } }, protection)
    const queue = (suffix: string, name: string) => new sst.cloudflare.Queue(`${plan.id}${suffix}`, { accountId, transform: { queue: (args, opts) => {
      args.queueName = name; Object.assign(opts, protection)
    } } }, protection)
    const events = queue('Events', plan.names.events), deadLetter = queue('EventsDLQ', plan.names.deadLetter)
    // Command replaces on trigger changes; protection would block production migrations.
    const migrations = new command.local.Command(`${plan.id}Migrate`, {
      create: plan.migration.command, update: plan.migration.command,
      dir: plan.root, addPreviousOutputInEnv: false,
      environment: {
        WB_NODE_BINARY: process.execPath, WB_MIGRATION_BIN: plan.migration.bin,
        WB_DATABASE_ID: db.databaseId, WB_MIGRATIONS_DIRECTORY: plan.migrationsDir,
        WB_CONFIG_MODULE: plan.configPath, CLOUDFLARE_DEFAULT_ACCOUNT_ID: accountId,
      },
      triggers: [...plan.migration.triggers, ...(options.migrationTriggers ?? [])],
    }, { protect: false, dependsOn: [db, db.nodes.database] })

    function secret(value: Input<string>, auth = false) {
      return $util.secret($util.output(value).apply(text => {
        if (auth && (typeof text !== 'string' || text.length < 32)) throw new ProvisionDiagnostic('provision_invalid_auth_secret')
        return text
      }))
    }
    const bindings: NativeBinding[] = [
      { name: 'DB', type: 'd1', id: db.databaseId },
      { name: 'AUDIT_KV', type: 'kv_namespace', namespaceId: audit.namespaceId },
      { name: 'EVENTS_QUEUE', type: 'queue', queueName: events.nodes.queue.queueName },
      { name: 'BETTER_AUTH_SECRET', type: 'secret_text', text: secret(options.authSecret, true) },
      ...(options.internalToken ? [{ name: 'INTERNAL_TOKEN', type: 'secret_text', text: secret(options.internalToken) }] : []),
      ...(options.opsToken ? [{ name: 'OPS_TOKEN', type: 'secret_text', text: secret(options.opsToken) }] : []),
      ...(options.webhook ? [
        { name: 'WEBHOOK_URL', type: 'secret_text', text: secret(options.webhook.url) },
        { name: 'WEBHOOK_ALLOWED_HOSTS', type: 'secret_text', text: secret(options.webhook.allowedHosts) },
        ...(options.webhook.service ? [{ name: 'WEBHOOK_SERVICE', type: 'service', service: options.webhook.service }] : []),
      ] : []),
      ...(options.email ? [{ name: 'EMAIL', type: 'send_email', allowedSenderAddresses: [options.email.from] }] : []),
    ]
    const worker = new sst.cloudflare.Worker(`${plan.id}Worker`, {
      accountId, handler: plan.handler, domain: options.domain, url: true, dev: false,
      ...(plan.assetsDir ? { assets: { directory: plan.assetsDir, htmlHandling: 'none' as const, notFoundHandling: 'none' as const, runWorkerFirst: true as const } } : {}),
      compatibility: { date: '2026-08-01', flags: ['nodejs_compat'] },
      environment: plan.environment,
      transform: { worker: (args, opts: ComponentResourceOptions) => {
        args.scriptName = plan.names.worker
        args.keepBindings = []
        // Auth query strings contain credentials: retain explicit application logs only.
        args.observability = { enabled: true, headSamplingRate: 1, logs: { enabled: true, invocationLogs: false, persist: true } }
        args.bindings = $util.output({ existing: args.bindings, added: bindings }).apply(({ existing, added }) => [...(existing ?? []), ...added])
        Object.assign(opts, protection)
        // Fence the actual script upload as well as its enclosing SST component.
        opts.dependsOn = [migrations]
      } },
    }, { ...protection, dependsOn: [migrations] })
    const consumer = new cloudflare.QueueConsumer(`${plan.id}EventsConsumer`, {
      accountId, queueId: events.id, scriptName: worker.nodes.worker.scriptName,
      type: 'worker', deadLetterQueue: deadLetter.nodes.queue.queueName,
      settings: { batchSize: 10, maxWaitTimeMs: 1000, maxRetries: 5 },
    }, { ...protection, dependsOn: [worker, events, deadLetter] })
    const cron = new cloudflare.WorkersCronTrigger(`${plan.id}RelayCron`, {
      accountId, scriptName: worker.nodes.worker.scriptName, schedules: [{ cron: '*/5 * * * *' }],
    }, { ...protection, dependsOn: [worker] })
    return {
      stage: plan.stage, url: worker.url, workerName: worker.nodes.worker.scriptName, databaseId: db.databaseId,
      eventsQueueName: events.nodes.queue.queueName, deadLetterQueueName: deadLetter.nodes.queue.queueName,
      resources: { database: db, audit, events, deadLetter, migrations, worker, consumer, cron },
    }
  } catch (error) { throw provisionFailure(error) }
}
