import { sha256 } from '../crypto'

export interface Bundle {
  revision: number; parent: string | null; manual: string
  pre: string; generated: string; post: string
}
const markers = ['begin pre-data', 'end pre-data', 'begin generated', 'end generated', 'begin post-data', 'end post-data']
const digest = '[a-f0-9]{64}'
const header = new RegExp(`^-- workbase:migration r([1-9]\\d*) parent=(${digest}|none) manual=(${digest}|unconfirmed|none)$`)
/** Only delimiters are interpreted. Region bodies retain every byte, including CRLF. */
export function parseBundle(file: string, sql: string): Bundle {
  const lines = sql.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const fail = (line: number, reason: string): never => { throw new Error(`${file}:${line}: ${reason}`) }
  const match = header.exec((lines[0] ?? '').replace(/\r?\n$/, ''))
  if (!match || !Number.isSafeInteger(Number(match[1]))) fail(1, 'expected migration header')
  const bodies = ['', '', '']
  let next = 0
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r?\n$/, '')
    if (line.startsWith('-- workbase:')) {
      if (line !== `-- workbase:${markers[next]}` || next === markers.length) fail(i + 1, `duplicate, out-of-order or invalid marker; expected ${markers[next] ?? 'end of file'}`)
      next++
    } else if (next % 2 === 1) bodies[Math.floor(next / 2)] += lines[i]
    else fail(i + 1, 'content outside regions')
  }
  if (next !== markers.length) fail(lines.length + 1, `missing marker -- workbase:${markers[next]}`)
  return { revision: Number(match![1]), parent: match![2] === 'none' ? null : match![2], manual: match![3], pre: bodies[0], generated: bodies[1], post: bodies[2] }
}
export function renderBundle(bundle: Bundle): string {
  return `-- workbase:migration r${bundle.revision} parent=${bundle.parent ?? 'none'} manual=${bundle.manual}\n`
    + `-- workbase:begin pre-data\n${bundle.pre}-- workbase:end pre-data\n`
    + `-- workbase:begin generated\n${bundle.generated}-- workbase:end generated\n`
    + `-- workbase:begin post-data\n${bundle.post}-- workbase:end post-data\n`
}
export const hasManual = (bundle: Bundle) => bundle.pre.length > 0 || bundle.post.length > 0
/** Decimal UTF-8 byte length, colon, body; repeated in pre/generated/post order. */
export const manualEvidence = (bundle: Bundle) => sha256([bundle.pre, bundle.generated, bundle.post].map(body => `${new TextEncoder().encode(body).length}:${body}`).join(''))
export async function checkBundle(file: string, sql: string): Promise<Bundle> {
  const bundle = parseBundle(file, sql)
  const expected = hasManual(bundle) ? await manualEvidence(bundle) : 'none'
  if (bundle.manual !== expected) throw new Error(`${file}:1: manual ${bundle.manual === 'unconfirmed' ? 'unconfirmed' : 'evidence mismatch'}; review manual regions and run migrate:plan --base <ref> --confirm-manual`)
  return bundle
}
