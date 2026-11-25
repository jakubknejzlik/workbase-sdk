import { Fragment, type ReactNode } from 'react'
import type { ConsolePage } from '../../plugins/console/src/contract'

/** Configuration supplies priority; unsectioned cards keep their original order. */
export function DashboardCards({ sections, cards }: { sections?: ConsolePage['sections']; cards: { key: string; content: ReactNode }[] }) {
  const remaining = new Map(cards.map(card => [card.key, card]))
  const rows = (sections ?? []).map(section => section.row.flatMap(key => {
    const card = remaining.get(key)
    if (!card) return []
    remaining.delete(key)
    return [card]
  })).filter(row => row.length)
  rows.push(...Array.from(remaining.values(), card => [card]))
  return <div className="dashboard-cards">{rows.map(row => <div key={row.map(card => card.key).join(',')} data-dashboard-row="" data-detail-row="" data-dashboard-columns={row.length}>
    {row.map(card => <Fragment key={card.key}>{card.content}</Fragment>)}
  </div>)}</div>
}
