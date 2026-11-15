import { expect, it } from 'vitest'
import { replaceLiteral } from '../src/composition/literal-edit.ts'

it.each([
  ['access.ts', ['roles', 'staff', 'system'], `{ roles: { staff: { system: /* before */ { 'audit.read': 'deny' } /* after */ } } }`],
  ['schema/worker.ts', ['access'], `{ fields: { name: { type: 'text' } }, access: /* before */ { staff: 'deny' } /* after */ }`],
])('replaces one literal span in %s, preserving every byte outside it', (file, path, object) => {
  const source = `// žluťoučký header\r\nimport { defineAccess as declaration } from '@workbasehq/core/schema'\r\nexport default declaration(${object})\r\n// footer\r\n`
  const start = source.indexOf('{', source.indexOf('/* before */')), end = source.indexOf(' /* after */')
  const changed = replaceLiteral(source, path as string[], { changed: 'allow' }, file)
  expect(Buffer.from(changed.slice(0, start))).toEqual(Buffer.from(source.slice(0, start)))
  expect(Buffer.from(changed.slice(changed.indexOf(' /* after */')))).toEqual(Buffer.from(source.slice(end)))
  expect(JSON.parse(changed.slice(start, changed.indexOf(' /* after */')))).toEqual({ changed: 'allow' })
})
