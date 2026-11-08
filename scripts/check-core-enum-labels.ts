import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { coreEnums } from '../packages/core/src/query/enum-values'

/** The catalog may translate only values declared by core, never instance values. */
export function assertCoreEnumLabels(catalog: unknown) {
  const allowed = new Set(coreEnums.role.map(value => `value_${value}`))
  if (!allowed.size) throw new Error('Core enum set must not be empty')
  const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!isObject(catalog) || !Object.keys(catalog).length) throw new Error('Core enum catalog must be a non-empty language object')
  for (const [language, labels] of Object.entries(catalog)) {
    if (!language.trim() || !isObject(labels) || !Object.keys(labels).length) throw new Error(`Core enum catalog language must contain labels: ${language}`)
    for (const key of Object.keys(labels)) {
      if (typeof labels[key] !== 'string') throw new Error(`Core enum label must be a string: ${language}.${key}`)
      if (!allowed.has(key)) throw new Error(`Non-core enum label: ${language}.${key}`)
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertCoreEnumLabels(JSON.parse(readFileSync(new URL('../packages/core/src/query/enum-labels.json', import.meta.url), 'utf8')))
  console.log('Core enum labels: every key belongs to a core-declared enum value')
}
