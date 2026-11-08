import type { ComponentResourceOptions, Input, Output, Resource } from '@pulumi/pulumi'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { ProvisionDiagnostic } from './provision-diagnostics'

/** Load SST's built-in command provider, never a consumer's optional peer. Pulumi
 * shares process-wide state, but protobuf messages must use the monitor's SDK. */
export function sstCommand(platform: string): typeof import('@pulumi/command') {
  try {
    const require = createRequire(join(platform, 'package.json'))
    const entry = require.resolve('@pulumi/command')
    // Fail before loading a provider with a nested, incompatible Pulumi runtime.
    if (createRequire(entry).resolve('@pulumi/pulumi') !== require.resolve('@pulumi/pulumi')) throw new Error('duplicate_pulumi')
    return require('@pulumi/command')
  } catch { throw new ProvisionDiagnostic('provision_requires_command') }
}

// SST's infrastructure constructors are injected by its config bundler; they are
// not exports of the npm `sst` runtime. Keep this small structural boundary here so
// installed consumers do not need this repository's generated .sst declarations.
// infra/provision-contract.ts checks it against the pinned SST/provider types.
export interface NativeBinding {
  name: Input<string>
  type: Input<string>
  text?: Input<string | undefined>
  id?: Input<string | undefined>
  namespaceId?: Input<string | undefined>
  queueName?: Input<string | undefined>
  service?: Input<string | undefined>
  allowedSenderAddresses?: Input<Input<string>[] | undefined>
}
export interface NativeWorkerArgs {
  scriptName?: Input<string | undefined>
  keepBindings?: Input<Input<string>[] | undefined>
  bindings?: Input<Input<NativeBinding>[] | undefined>
  observability?: Input<{
    enabled?: Input<boolean | undefined>
    headSamplingRate?: Input<number | undefined>
    logs?: Input<{ enabled?: Input<boolean | undefined>; invocationLogs?: Input<boolean | undefined>; persist?: Input<boolean | undefined> } | undefined>
  } | undefined>
}
type Transform<T> = (args: T, opts: ComponentResourceOptions) => undefined
export type DatabaseResource = Resource & { databaseId: Output<string>; nodes: { database: Resource } }
export type KvResource = Resource & { namespaceId: Output<string> }
export type QueueResource = Resource & { id: Output<string>; nodes: { queue: Resource & { queueName: Output<string> } } }
export type WorkerResource = Resource & { url: Output<string | undefined>; nodes: { worker: Resource & { scriptName: Output<string> } } }
export type CronResource = Resource & { scriptName: Output<string>; schedules: Output<{ cron: string }[] | undefined> }

export interface SstRuntime {
  cloudflare: {
    D1: new (name: string, args: { accountId: string; transform: { database: Transform<{ name?: Input<string> }> } }, opts: ComponentResourceOptions) => DatabaseResource
    Kv: new (name: string, args: { accountId: string; transform: { namespace: Transform<{ title?: Input<string> }> } }, opts: ComponentResourceOptions) => KvResource
    Queue: new (name: string, args: { accountId: string; transform: { queue: Transform<{ queueName?: Input<string> }> } }, opts: ComponentResourceOptions) => QueueResource
    Worker: new (name: string, args: {
      accountId: string
      handler: string
      domain?: string
      url: boolean
      dev: false
      assets?: { directory: string; htmlHandling: 'none'; notFoundHandling: 'none'; runWorkerFirst: true }
      compatibility: { date: string; flags: string[] }
      environment: Record<string, string>
      transform: { worker: Transform<NativeWorkerArgs> }
    }, opts: ComponentResourceOptions) => WorkerResource
  }
}

export interface CloudflareRuntime {
  QueueConsumer: new (name: string, args: {
    accountId: string; queueId: Input<string>; scriptName: Input<string>; type: 'worker'; deadLetterQueue: Input<string>
    settings: { batchSize: number; maxWaitTimeMs: number; maxRetries: number }
  }, opts: ComponentResourceOptions) => Resource
  WorkersCronTrigger: new (name: string, args: {
    accountId: string; scriptName: Input<string>; schedules: { cron: string }[]
  }, opts: ComponentResourceOptions) => CronResource
}
