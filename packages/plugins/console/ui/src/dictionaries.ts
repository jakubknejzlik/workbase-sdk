import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sourceAt } from './locations'
import type { Finding, KeySource } from './validate'
export type Catalogs = Record<string, Record<string, Record<string, string>>>
const suffix = /_(zero|one|two|few|many|other)$/
export const variables = (text: string) => [...new Set([...text.matchAll(/{{\s*([\w]+)\s*}}/g)].map(m => m[1]))].sort()
export function checkDictionaries(root: string, required: Map<string, KeySource[]>, catalogs: Catalogs, sdk: Record<string, Record<string, string>>): Finding[] {
  const findings: Finding[] = []
  function emit(code: string, lang: string, ns: string, key: string, refs: KeySource[] = []) {
    const file = resolve(root, 'locales', lang, ns + '.json')
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { /* Catalog read errors are reported by the pipeline. */ }
    findings.push({ code, ...sourceAt(file, text, '"' + key + '"'), key: ns + ':' + key, lang, message: refs.map(r => `${r.file}:${r.line}:${r.col}`).join(', ') })
  }
  const accepted = new Map<string, Set<string>>()
  for (const [id, refs] of required) {
    const [ns, key] = id.split(':')
    const plural = refs.some(ref => ref.plural) || Object.values(catalogs).some(c => Object.keys(c[ns] ?? {}).some(k => suffix.test(k) && k.replace(suffix, '') === key))
    let expectedVars: string | undefined
    for (const [lang, resources] of Object.entries(catalogs)) {
      const forms = plural ? new Intl.PluralRules(lang).resolvedOptions().pluralCategories.map(category => key + '_' + category) : [key]
      const set = accepted.get(lang + ':' + ns) ?? new Set<string>(); accepted.set(lang + ':' + ns, set)
      for (const form of forms) {
        set.add(form)
        const text = (ns === 'sdk' ? sdk[lang] : resources[ns])?.[form]
        if (text === undefined) { emit('missing-key', lang, ns, form, refs); continue }
        const vars = JSON.stringify(variables(text))
        expectedVars ??= vars
        if (vars !== expectedVars) emit('interpolation', lang, ns, form, refs)
      }
    }
  }
  for (const [lang, resources] of Object.entries(catalogs)) {
    if (!['cs', 'en'].includes(lang)) findings.push({ code: 'unsupported-language', file: resolve(root, 'config.ts'), line: 1, col: 1, lang })
    for (const [ns, catalog] of Object.entries(resources)) for (const [key, text] of Object.entries(catalog)) {
      if (text.includes('$t(')) emit('nested-translation', lang, ns, key)
      if (ns === 'sdk') {
        const original = sdk[lang]?.[key]
        if (original === undefined) emit('unknown-sdk-key', lang, ns, key)
        else if (variables(text).some(v => !variables(original).includes(v))) emit('override-interpolation', lang, ns, key)
      } else if (!accepted.get(lang + ':' + ns)?.has(key)) emit('orphan-key', lang, ns, key)
    }
  }
  return findings
}
