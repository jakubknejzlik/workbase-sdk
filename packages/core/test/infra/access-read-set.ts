import { isDeepStrictEqual } from 'node:util'

// Test-only provenance: record consumers, never the serializer. Paths retain Map
// keys and array positions; object identity is stable within each input path.
export interface Read {
  path: string[]
  kind: 'get' | 'has' | 'keys'
  value: unknown
  scenario: string
}
export class ReadSet {
  readonly reads = new Map<string, Read>()
  scenario = 'setup'
  private readonly proxies = new WeakMap<object, Map<string, object>>()
  private record(path: string[], kind: Read['kind'], value: unknown) {
    const key = JSON.stringify([path, kind])
    if (!this.reads.has(key)) this.reads.set(key, { path, kind, value, scenario: this.scenario })
  }
  wrap<T extends object>(input: T, path: string[]): T {
    const key = JSON.stringify(path)
    const cached = this.proxies.get(input)?.get(key)
    if (cached) return cached as T
    const child = (value: unknown, at: string[]): any => value && typeof value === 'object' ? this.wrap(value, at) : value
    // Shadow array containers so nested proxies do not violate the
    // non-configurable-property invariant. Values still come from the raw input.
    const shadow = Array.isArray(input) ? [...input] : input
    const proxy = new Proxy(shadow, {
      get: (target, property, receiver) => {
        if (target instanceof Map) {
          if (property === 'size') { this.record(path, 'keys', [...target.keys()]); return target.size }
          if (property === 'get') return (name: string) => {
            const value = target.get(name); this.record([...path, name], 'get', value)
            return child(value, [...path, name])
          }
          if (property === 'has') return (name: string) => {
            this.record([...path, name], 'has', target.has(name)); return target.has(name)
          }
          if (['keys', 'values', 'entries'].includes(String(property)) || property === Symbol.iterator) {
            this.record(path, 'keys', [...target.keys()])
            return function* () {
              // Native Map iterators need the raw receiver, but yielded values must
              // remain instrumented. Record membership even for an empty registry.
              const entries = [...target.entries()]
              for (const [name, value] of entries) {
                if (property === 'keys') yield name
                else if (property === 'values') yield child(value, [...path, name])
                else yield [name, child(value, [...path, name])]
              }
            }
          }
          throw new Error(`Unsupported recorded Map method: ${String(property)}`)
        }
        const value: any = Reflect.get(target, property, receiver)
        // Language protocols and inherited Array methods are not declarative
        // inputs. Their element/length/has reads still go through this Proxy.
        if ([Symbol.iterator, Symbol.toStringTag, Symbol.unscopables].includes(property as symbol) || Array.isArray(target) && !Object.hasOwn(target, property) && typeof value === 'function') return value
        this.record([...path, String(property)], 'get', value)
        // ts-query expressions are library objects, represented by their complete
        // wire value at this boundary. Do not proxy private caches/method receivers.
        if (value && typeof value === 'object' && typeof value.serialize === 'function') return value
        return child(value, [...path, String(property)])
      },
      has: (target, property) => {
        if (typeof property === 'string') this.record([...path, property], 'has', Reflect.has(target, property))
        return Reflect.has(target, property)
      },
      ownKeys: target => {
        this.record(path, 'keys', Object.keys(target))
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor: (target, property) => {
        if (typeof property === 'string') this.record([...path, property], 'has', Object.hasOwn(target, property))
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    })
    const paths = this.proxies.get(input) ?? new Map<string, object>()
    paths.set(key, proxy); this.proxies.set(input, paths)
    return proxy as T
  }
  map<T>(input: ReadonlyMap<string, T>, path: string[]): ReadonlyMap<string, T> {
    return this.wrap(input, path)
  }
}

export interface Coverage { value: unknown; location: string }
export type Mapping = (read: Read) => Coverage | undefined
export type Exception = (read: Read) => string | undefined
const wire = (value: any): any => value && typeof value.serialize === 'function' ? value.serialize() : value
export function assertReadSetCovered(reads: Iterable<Read>, mapping: Mapping, exception: Exception) {
  const failures: string[] = []
  for (const read of reads) {
    if (exception(read)) continue
    const covered = mapping(read)
    const fail = (reason: string) => failures.push(`${read.scenario}: ${read.kind} ${read.path.join('.')} — ${reason}`)
    if (!covered) { fail('no serialized lock input (add a projection/mapping or a precise justified exception)'); continue }
    const expected = read.kind === 'get' ? wire(read.value) : read.value
    const actual = read.kind === 'has' ? covered.value !== undefined
      : read.kind === 'keys' ? Object.keys(covered.value ?? {}).sort() : covered.value
    // Container gets navigate a projection; their keys/leaf reads are checked
    // separately. A missing container still fails, including truthiness-only reads.
    if (expected && typeof expected === 'object' && read.kind === 'get') {
      if (actual === null || typeof actual !== 'object') fail(`missing container at ${covered.location}`)
    } else if (!isDeepStrictEqual(read.kind === 'keys' ? [...expected as string[]].sort() : expected, actual)) {
      fail(`differs from ${covered.location}: read=${JSON.stringify(expected)}, lock=${JSON.stringify(actual)}`)
    }
  }
  if (failures.length) throw new Error(`Uncovered enforcement reads (${failures.length}):\n${failures.join('\n')}`)
}
