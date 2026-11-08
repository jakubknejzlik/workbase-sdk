import { Fragment, type ReactNode } from 'react'
import type { ConsoleDetailSection } from '../../plugins/console/src/contract'

/** Cards are already capability-filtered. Unspecified cards retain their original order. */
export function DetailCards({ sections, cards }: { sections?: ConsoleDetailSection[]; cards: { key: string; content: ReactNode }[] }) {
  if (!sections) return <>{cards.map(card => <Fragment key={card.key}>{card.content}</Fragment>)}</>
  const remaining = new Map(cards.map(card => [card.key, card.content]))
  const rows = sections.map(section => (section.row ?? ['info']).flatMap(key => {
    if (!remaining.has(key)) return []
    const content = remaining.get(key)
    remaining.delete(key)
    return [{ key, content }]
  })).filter(row => row.length)
  rows.push(...Array.from(remaining, ([key, content]) => [{ key, content }]))
  const columns = ['grid-cols-1', 'md:grid-cols-2', 'md:grid-cols-3']
  return <>{rows.map(row => <div key={row.map(card => card.key).join(',')} data-detail-row="" className={`grid grid-cols-1 gap-6 items-start ${columns[row.length - 1]}`}>
    {row.map(card => <Fragment key={card.key}>{card.content}</Fragment>)}
  </div>)}</>
}
