import type { Location } from './validate'
export function sourceAt(file: string, text: string, key?: string): Location {
  const pos = key ? Math.max(0, text.indexOf(key)) : 0, before = text.slice(0, pos).split('\n')
  return { file, line: before.length, col: before.at(-1)!.length + 1 }
}
