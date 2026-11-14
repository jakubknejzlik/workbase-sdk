import { z } from 'zod'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

// Copied with the bridge into the consumer. No producer runtime imports.
export const BRIDGE_VERSION = 1
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const version = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
export const inputPath = z.string().regex(/^(?:package\.json|bun\.lock|runtime\.ts|access\.ts|schema\.lock\.json|schema\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.ts|config(?:\.[a-z0-9_-]+)?\.(?:ts|json)|migrations\/[0-9]{4}_[a-zA-Z0-9_-]+\.sql)$/)
export const inputHashesSchema = z.record(inputPath, sha256Schema)
export const identitySchema = z.strictObject({
  runId: z.uuid(), instanceId: z.string().regex(/^[a-z][a-z0-9_]*$/),
  targetVersion: version, baseRevision: z.number().int().positive(),
  baseFingerprint: sha256Schema, baseDependencyDigest: sha256Schema,
  bridgeVersion: z.literal(BRIDGE_VERSION), bridgeDigest: sha256Schema,
})
const markerSchema = z.strictObject({ path: inputPath, sha256: sha256Schema })
export const stageSchema = z.strictObject({ marker: markerSchema, replaySha256: sha256Schema })
export const requestSchema = z.strictObject({
  action: z.enum(['prepare', 'verify']), identity: identitySchema,
  inputHashes: inputHashesSchema, stage: stageSchema.optional(),
}).refine(value => (value.action === 'verify') === !!value.stage, 'Only verification has a bound stage')
export const replayFailureSchema = z.strictObject({
  identity: identitySchema, inputHashes: inputHashesSchema,
  diagnostic: z.strictObject({ file: z.string().min(1).max(512), migration: z.string().min(1).max(256), sqlError: z.string().min(1).max(2048) }),
})
const packageSchema = z.strictObject({
  name: z.enum(['@workbasehq/core', '@workbasehq/plugins', '@workbasehq/mcp']), version,
  directory: z.string().min(1),
})
export const preparedSchema = z.strictObject({
  kind: z.literal('prepared'), identity: identitySchema, inputHashes: inputHashesSchema, stage: stageSchema,
})
export const resultSchema = z.strictObject({
  kind: z.literal('verified'), identity: identitySchema, inputHashes: inputHashesSchema, stage: stageSchema,
  coreVersion: version, packages: z.array(packageSchema).length(3), resolutions: z.record(z.string(), z.string()),
  schema: z.strictObject({ status: z.literal('pass'), expected: sha256Schema, applied: sha256Schema }),
  plugins: z.strictObject({ expected: sha256Schema, applied: sha256Schema }),
  marker: z.strictObject({ version, revision: z.number().int().positive() }),
})
export type UpgradeRequest = z.infer<typeof requestSchema>
export type UpgradeIdentity = z.infer<typeof identitySchema>
export type UpgradeStage = z.infer<typeof stageSchema>
export type UpgradeResult = z.infer<typeof resultSchema>
export const digestBytes = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
export const bridgeFiles = ['sdk-upgrade-worker.ts', 'sdk-upgrade-protocol.ts', 'migration-replay.ts'] as const
export async function bridgeDigest(directory: string) {
  const files = await Promise.all(bridgeFiles.map(async path => [path, digestBytes(await readFile(join(directory, path)))]))
  return digestBytes(JSON.stringify(files))
}
export const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
/** Both processes independently resolve the same installed consumer exports. */
export async function consumerModules(root: string) {
  const require = createRequire(join(root, 'package.json'))
  const packages: UpgradeResult['packages'] = []
  const resolutions: Record<string, string> = {}
  for (const name of ['@workbasehq/core', '@workbasehq/plugins', '@workbasehq/mcp'] as const) {
    const directory = join(root, 'node_modules', name)
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new Error('SDK package must be inside consumer without links')
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    if (manifest.name !== name) throw new Error('SDK package identity mismatch')
    packages.push({ name, version: manifest.version, directory })
    for (const key of Object.keys(manifest.exports)) {
      const specifier = name + (key === '.' ? '' : key.slice(1))
      const path = await realpath(require.resolve(specifier))
      if (!inside(directory, path)) throw new Error(`SDK resolution outside consumer: ${specifier}`)
      resolutions[specifier] = path
    }
  }
  const targetMcp = createRequire(join(root, 'node_modules/@workbasehq/mcp/package.json'))
  for (const specifier of ['wrangler/package.json', 'tsx']) {
    const path = await realpath(targetMcp.resolve(specifier))
    if (!inside(join(root, 'node_modules'), path)) throw new Error(`Tool resolution outside consumer: ${specifier}`)
    resolutions[specifier] = path
  }
  const wrangler = join(dirname(resolutions['wrangler/package.json']), 'bin/wrangler.js')
  if (await realpath(wrangler) !== wrangler) throw new Error('Wrangler link is not allowed')
  resolutions.wrangler = wrangler
  return { packages, resolutions }
}

const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const x = Object.entries(a).sort(([a], [b]) => a.localeCompare(b))
  const y = Object.entries(b).sort(([a], [b]) => a.localeCompare(b))
  return x.length === y.length && x.every(([key, value], index) => key === y[index][0] && equal(value, y[index][1]))
}
export function assertBound(actual: unknown, expected: unknown, label: string) {
  if (!equal(actual, expected)) throw new Error(`SDK bridge ${label} differs from parent expectations`)
}
/** Shape alone is never authorization: all identities and hashes are parent held. */
export function acceptUpgradeResult(raw: unknown, request: UpgradeRequest, packages: UpgradeResult['packages'], resolutions: UpgradeResult['resolutions']): UpgradeResult {
  const result = resultSchema.parse(raw)
  assertBound(result.identity, request.identity, 'identity')
  assertBound(result.inputHashes, request.inputHashes, 'input hashes')
  assertBound(result.stage, request.stage, 'stage')
  assertBound(result.packages, packages, 'packages')
  assertBound(result.resolutions, resolutions, 'resolutions')
  if (result.coreVersion !== request.identity.targetVersion || result.marker.version !== request.identity.targetVersion
    || result.marker.revision !== request.identity.baseRevision || result.schema.expected !== result.schema.applied
    || result.plugins.expected !== result.plugins.applied) throw new Error('SDK bridge verification outcomes differ from parent expectations')
  return result
}
