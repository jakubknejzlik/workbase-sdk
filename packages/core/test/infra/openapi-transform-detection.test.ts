import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { createApp } from '../../src/app'
import { publicCommands } from '../../src/public-projection'
import { publicSchema } from '../../src/public-schema'
import { KernelRegistry } from '../../src/kernel/registry'
import { workerAccessFixture } from '../fixtures/worker-access'

function probe(input: z.ZodType) {
  const config = new KernelRegistry(workerAccessFixture()).config
  config.commands = ['probe']
  const options = { commands: new Map([['probe', { name: 'probe', input, permission: { entity: 'worker', operation: 'update' } } as any]]) }
  return {
    legacy: () => JSON.stringify(publicCommands(config, options)),
    current: () => JSON.stringify(publicSchema(config, options).commands),
    response: () => createApp(config, {
      DB: { prepare() { throw new Error('unexpected DB access') } },
      BETTER_AUTH_SECRET: 'synthetic-access-secret-at-least-32', AUTH_BASE_URL: 'https://neutral.example.test',
    } as any, options).request('https://neutral.example.test/schema'),
  }
}

const commands = async (response: Response) => (await response.json() as any).commands.filter((command: any) => command.name === 'probe')

it('verify4 enum brand: preserves baseline bytes for enum data named _zod, literal values and record keys', async () => {
  for (const value of [z.enum(['_zod', 'b']), z.literal(['_zod', 'b']), z.record(z.enum(['_zod', 'b']), z.string())]) {
    const test = probe(z.object({ value }))
    const expected = test.legacy()
    const response = await test.response()
    expect(response.status).toBe(200)
    expect(JSON.stringify(await commands(response))).toBe(expected)
    expect(test.current()).toBe(expected)
  }
})

it('verify4 enum getter: never reads enum entries in a transform-free pipe input', async () => {
  let calls = 0, armed = false
  const enumeration: z.ZodType = z.enum({ get A() { calls++; if (armed) throw new Error('ENUM_GETTER_MUST_NOT_RUN'); return 'a' as const } })
  const value = enumeration.pipe(z.string())
  const input = z.object({ value })
  expect(input.parse({ value: 'a' })).toEqual({ value: 'a' })
  armed = true; calls = 0
  const test = probe(input), expected = test.legacy()
  expect(calls).toBe(0)
  const response = await test.response()
  expect(response.status).toBe(200)
  expect(JSON.stringify(await commands(response))).toBe(expected)
  expect(test.current()).toBe(expected)
  expect(calls).toBe(0)
})

const transformed = () => z.string().transform(value => value.toUpperCase())
const containers: [string, (tx: ReturnType<typeof transformed>, factory: () => string) => z.ZodType][] = [
  ['transform', () => z.transform(() => 'value')],
  ['optional', tx => tx.optional()], ['nullable', tx => tx.nullable()],
  ['default', (tx, factory) => tx.default(factory)], ['prefault', (tx, factory) => tx.prefault(factory)],
  ['nonoptional', tx => tx.optional().nonoptional()], ['success', tx => z.success(tx)],
  ['catch', (tx, factory) => tx.catch(factory)], ['readonly', tx => tx.readonly()], ['promise', tx => z.promise(tx)],
  ['array', tx => z.array(tx)], ['object.shape', tx => z.object({ value: tx })],
  ['object.catchall', tx => z.object({}).catchall(tx)],
  ['union.first', tx => z.union([tx, z.number()])], ['union.last', tx => z.union([z.number(), tx])],
  ['discriminated union', tx => z.discriminatedUnion('kind', [z.object({ kind: z.literal('a') }), z.object({ kind: z.literal('b'), value: tx })])],
  ['xor', tx => z.xor([z.number(), tx])],
  ['intersection.left', tx => z.intersection(tx, z.string())], ['intersection.right', tx => z.intersection(z.string(), tx)],
  ['tuple.first', tx => z.tuple([tx, z.string()])], ['tuple.last', tx => z.tuple([z.string(), tx])],
  ['tuple.rest', tx => z.tuple([]).rest(tx)],
  ['record.key', tx => z.record(tx, z.string())], ['record.value', tx => z.record(z.string(), tx)],
  ['map.key', tx => z.map(tx, z.string())], ['map.value', tx => z.map(z.string(), tx)], ['set', tx => z.set(tx)],
  ['pipe.in only', tx => tx.pipe(z.string())], ['pipe.out', tx => z.string().pipe(tx)],
  ['preprocess', () => z.preprocess(value => value, z.string())],
  ['function.input', tx => z.union([z.string(), z.function({ input: [tx], output: z.string() })])],
  ['function.output', tx => z.union([z.string(), z.function({ input: [], output: tx })])],
  ['lazy', tx => z.lazy(() => tx)],
]
it.each(containers)('projects a transform in %s without evaluating default factories', async (_name, wrap) => {
  let calls = 0
  const factory = () => { calls++; throw new Error('FACTORY_MUST_NOT_RUN') }
  // The container is in pipe.in so even non-JSON types have a representable output.
  // Only detecting its transform can prevent conversion of the sibling factory.
  const input = z.object({ value: wrap(transformed(), factory).pipe(z.string()), label: z.string().default(factory) })
  const test = probe(input)
  const expected = JSON.parse(test.current())
  expect(expected[0].inputSchema.properties.value).toEqual({ type: 'string' })
  const response = await test.response()
  expect(response.status).toBe(200)
  expect(await commands(response)).toEqual(expected)
  expect(calls).toBe(0)
})

it('keeps annotated wrappers, stringbool and codec on the legacy path with identical bytes and factory counts', async () => {
  let calls = 0
  for (const value of [
    z.string().describe('Public label').optional(),
    z.string().describe('Public label').default('value').meta({ title: 'Public title' }),
    z.string().describe('Private input').pipe(z.string().describe('Public output')).meta({ title: 'Public pipe' }),
    z.stringbool(), z.codec(z.string(), z.number(), { decode: Number, encode: String }),
  ]) {
    const test = probe(z.object({ value, label: z.string().default(() => { calls++; return 'value' }) }))
    calls = 0
    const expected = test.legacy(), baselineCalls = calls
    expect(baselineCalls).toBeGreaterThan(0)
    calls = 0
    expect(test.current()).toBe(expected)
    expect(calls).toBe(baselineCalls)
    calls = 0
    const response = await test.response()
    expect(response.status).toBe(200)
    expect(JSON.stringify(await commands(response))).toBe(expected)
    expect(calls).toBe(baselineCalls)
  }
})

it('preserves the baseline throw and factory count for a transform-free throwing default', async () => {
  let calls = 0
  const test = probe(z.object({ value: z.string().default(() => { calls++; throw new Error('BASELINE_FACTORY') }) }))
  expect(test.legacy).toThrow('BASELINE_FACTORY')
  const baselineCalls = calls
  expect(baselineCalls).toBeGreaterThan(0)
  calls = 0
  expect(test.current).toThrow('BASELINE_FACTORY')
  expect(calls).toBe(baselineCalls)
  calls = 0
  expect((await test.response()).status).toBe(500)
  expect(calls).toBe(baselineCalls)
})

it.each(['shape', 'lazy'])('treats a throwing %s under pipe.in as having no children', async kind => {
  let calls = 0
  const fail = (): z.ZodType => { calls++; throw new Error('UNRESOLVABLE_CHILD') }
  const inner: z.ZodType = kind === 'shape' ? z.object({ get value() { return fail() } }) : z.lazy(fail)
  const test = probe(z.object({ value: inner.pipe(z.string()) }))
  const expected = test.legacy()
  expect(calls).toBe(0)
  expect(test.current()).toBe(expected)
  expect(calls).toBe(1)
  calls = 0
  const response = await test.response()
  expect(response.status).toBe(200)
  expect(JSON.stringify(await commands(response))).toBe(expected)
  // Zod's lazy cache retains the failed resolution; a throwing shape retries.
  expect(calls).toBe(kind === 'lazy' ? 0 : 1)
})

it('ignores value keys, non-schema children, extra def fields, custom types and property checks', async () => {
  let calls = 0
  const leaf = z.string()
  for (const key of ['entries', 'values', 'defaultValue', 'catchValue', 'fn', 'getter', 'checks']) {
    Object.defineProperty(leaf._zod.def, key, { get() { calls++; throw new Error('VALUE_KEY_MUST_NOT_RUN') } })
  }
  const array = z.array(z.string())
  Object.defineProperty(array._zod.def, 'element', { get() { calls++; throw new Error('CHILD_ACCESSOR_MUST_NOT_RUN') } })
  const unknown = z.string()
  Object.assign(unknown._zod.def, { type: 'future_type', innerType: transformed() })
  const extra = z.string()
  Object.assign(extra._zod.def, { extra: transformed() })
  const invalid = z.array(z.string())
  Object.assign(invalid._zod.def, { element: { _zod: 'ordinary data' } })
  const leaves: z.ZodType[] = [leaf, array, unknown, extra, invalid, z.custom(), z.string().check(z.property('length', z.number().transform(value => value)))]
  for (const inner of leaves) {
    let factories = 0
    const test = probe(z.object({ value: inner.pipe(z.string()), label: z.string().default(() => { factories++; return 'value' }) }))
    const expected = test.legacy(), baselineFactories = factories
    expect(baselineFactories).toBeGreaterThan(0)
    factories = 0
    expect(test.current()).toBe(expected)
    expect(factories).toBe(baselineFactories)
    factories = 0
    expect((await test.response()).status).toBe(200)
    expect(factories).toBe(baselineFactories)
  }
  // A property check on the converted node must also retain legacy bytes.
  const checked = probe(z.string().describe('Public label').check(z.property('length', z.number().transform(value => value))))
  expect(checked.current()).toBe(checked.legacy())
  expect(calls).toBe(0)
})

it('terminates for recursive, mutually recursive, self-lazy and reused schema graphs', async () => {
  const recursive: z.ZodType = z.object({ name: z.string(), children: z.array(z.lazy(() => recursive)).optional() })
  const left: z.ZodType = z.object({ right: z.lazy(() => right).optional() })
  const right: z.ZodType = z.object({ left: z.lazy(() => left).optional() })
  const self: z.ZodType = z.lazy(() => self)
  const shared = z.object({ value: z.string().describe('Public value') })
  const reused = z.object({ left: shared, right: shared })
  for (const value of [recursive, left, self, reused]) {
    const plain = probe(z.object({ value: value.pipe(z.string()) }))
    expect(plain.current()).toBe(plain.legacy())
    expect((await plain.response()).status).toBe(200)
    let calls = 0
    const withTransform = probe(z.object({ value: z.union([value, transformed()]).pipe(z.string()), label: z.string().default(() => { calls++; throw new Error('FACTORY_MUST_NOT_RUN') }) }))
    expect(() => withTransform.current()).not.toThrow()
    expect((await withTransform.response()).status).toBe(200)
    expect(calls).toBe(0)
  }
  for (const value of [recursive, left, reused]) {
    const plain = probe(value)
    expect(plain.current()).toBe(plain.legacy())
    expect((await plain.response()).status).toBe(200)
  }
})

it('pins all 40 def.type members to the installed Zod so upgrades require a detector review', () => {
  const types = [
    'string', 'number', 'int', 'boolean', 'bigint', 'symbol', 'null', 'undefined', 'void', 'never', 'any', 'unknown', 'date',
    'object', 'record', 'file', 'array', 'tuple', 'union', 'intersection', 'map', 'set', 'enum', 'literal', 'nullable', 'optional',
    'nonoptional', 'success', 'transform', 'default', 'prefault', 'catch', 'nan', 'pipe', 'readonly', 'template_literal', 'promise', 'lazy', 'function', 'custom',
  ] as const
  expectTypeOf<z.core.$ZodTypeDef['type']>().toEqualTypeOf<(typeof types)[number]>()
  const require = createRequire(import.meta.url)
  const declarations = readFileSync(join(dirname(require.resolve('zod/v4/core')), 'schemas.d.ts'), 'utf8')
  const declared = declarations.match(/interface \$ZodTypeDef\s*\{\s*type:\s*([^;]+);/)![1]
  const installedTypes = Array.from(declared.matchAll(/"([^"]+)"/g), match => match[1])
  expect(new Set(types).size).toBe(40)
  expect(installedTypes.sort()).toEqual([...types].sort())
})
