import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
export const sdk = '@workbasehq/plugins/console/ui'
export const declaration = `import { page } from '${sdk}'\nexport default page({ title: 'sample.title' })`
export function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workbase-ui-')))
  function put(file: string, text: string) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text) }
  put('package.json', '{"type":"module"}')
  mkdirSync(join(root, 'node_modules/@workbasehq'), { recursive: true })
  for (const name of ['core', 'plugins']) symlinkSync(resolve('packages', name), join(root, 'node_modules/@workbasehq', name), 'dir')
  for (const name of ['react', 'react-dom', '@tanstack/react-router', '@types/react']) {
    mkdirSync(dirname(join(root, 'node_modules', name)), { recursive: true })
    symlinkSync(resolve('packages/plugins/node_modules', name), join(root, 'node_modules', name), 'dir')
  }
  put('schema/worker.ts', `import { defineEntity } from '@workbasehq/core/schema'\nexport default defineEntity({ fields: { name: { type: 'text' } } })`)
  put('config.ts', `import { defineConfig } from '@workbasehq/core/schema'\nimport worker from './schema/worker'\nexport default defineConfig({ id: 'sample', roles: ['admin'], organizationOwnerRole: 'admin', languages: ['en'], entities: { worker } })`)
  put('ui/index.ts', declaration)
  return { root, put }
}

export const forbidden: [string, string, string?, string?][] = [
  ['re-export', `export { x } from './-data'`, 'ui/-data.ts', 'export const x = 1'],
  ['export star', `export * from './-data'`, 'ui/-data.ts', 'export const x = 1'],
  ['import equals', `import x = require('./-data')`, 'ui/-data.ts', 'export const x = 1'],
  ['side effect', `import './-data'`, 'ui/-data.ts', 'export const x = 1'],
  ['dynamic literal', `import('./-data')`, 'ui/-data.ts', 'export const x = 1'],
  ['dynamic nonliteral', `const path = './-data'; import(path)`],
  ['bare package', `import x from 'some-unclassified-package'`],
  ['alias', `import x from '~/layout'`],
  ['unresolved', `import x from './-missing'`],
  ['config value', `import x from '../config'`],
  ['schema value', `import x from '../schema/worker'`],
  ['access value', `import x from '../access'`, 'access.ts', 'export default {}'],
  ['transitive', `import x from './-data'`, 'ui/-data.ts', `export { x } from 'react'`],
  ...['.ts', '.js', '.mjs', '.cjs', '.jsx', '.mts', '.json'].map(ext => [`React via ${ext}`, `import x from './-dep${ext}'`, `ui/-dep${ext}`, `import React from 'react'; export default React`] as [string, string, string, string]),
  ...['foo.bar.ts', '_layout.ts', '(group)/x.ts', 'route.ts', 'a/route.ts', 'x.tsx'].map(file => [`filename ${file}`, '', `ui/${file}`, declaration] as [string, string, string, string]),
]
