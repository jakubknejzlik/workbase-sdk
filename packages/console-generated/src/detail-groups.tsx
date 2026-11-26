import type { ReactNode } from 'react'
import type { detailPlan } from './detail-plan'

type Plan = NonNullable<ReturnType<typeof detailPlan>>
type Item = Plan['summary'][number]
/** Conditions suppress the value, preserving an explicit explanation of applicability. */
export function DetailGroups({ plan, row, label, value, translate, edit }: { plan: Plan; row: Record<string, unknown>; label: (field: string) => string; value: (field: string) => ReactNode; translate: (key: string) => string; edit?: (field: string, value: ReactNode, label: string) => ReactNode }) {
  const fields = (items: Item[], kind: 'summary' | 'metadata') => <dl className="c2-detail detail-field-grid" data-detail-grid={kind}>{items.map(item => {
    const applicable = !item.when || row[item.when.field] === item.when.eq
    const state = !applicable ? 'not-applicable' : row[item.field] == null ? 'not-provided' : 'provided'
    const fieldLabel = item.label ? translate(item.label) : label(item.field)
    const reference = (row.__labels as Record<string, unknown> | undefined)?.[item.field]
    const content = state === 'not-applicable' ? translate('detailNotApplicable') : state === 'not-provided' && !reference ? translate('detailNotProvided') : value(item.field)
    return <div className="detail-field" key={item.field} data-detail-field={item.field} data-detail-state={state}>
      <dt className="detail-field-label">{fieldLabel}</dt>
      <dd className="detail-field-value">{applicable && edit ? edit(item.field, content, fieldLabel) : content}
        {item.help && <p className="detail-field-help">{translate(item.help)}</p>}
      </dd>
    </div>
  })}</dl>
  return <div className="detail-information">
    {!!plan.summary.length && <div data-detail-summary="">{fields(plan.summary, 'summary')}</div>}
    {plan.groups.map(group => <section key={group.id} data-detail-group={group.id}>
      <div className="detail-group-heading"><h2>{translate(group.label)}</h2>{group.help && <p>{translate(group.help)}</p>}</div>
      {fields(group.fields, 'metadata')}
    </section>)}
  </div>
}
