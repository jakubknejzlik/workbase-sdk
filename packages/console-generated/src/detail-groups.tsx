import type { ReactNode } from 'react'
import type { detailPlan } from './detail-plan'

type Plan = NonNullable<ReturnType<typeof detailPlan>>
type Item = Plan['summary'][number]
/** Conditions suppress the value, preserving an explicit explanation of applicability. */
export function DetailGroups({ plan, row, label, value, translate, edit }: { plan: Plan; row: Record<string, unknown>; label: (field: string) => string; value: (field: string) => ReactNode; translate: (key: string) => string; edit?: (field: string, value: ReactNode, label: string) => ReactNode }) {
  const fields = (items: Item[]) => <dl className="c2-detail grid gap-4 sm:grid-cols-2">{items.map(item => {
    const applicable = !item.when || row[item.when.field] === item.when.eq
    const state = !applicable ? 'not-applicable' : row[item.field] == null ? 'not-provided' : 'provided'
    const fieldLabel = item.label ? translate(item.label) : label(item.field)
    const reference = (row.__labels as Record<string, unknown> | undefined)?.[item.field]
    const content = state === 'not-applicable' ? translate('detailNotApplicable') : state === 'not-provided' && !reference ? translate('detailNotProvided') : value(item.field)
    return <div className="min-w-0 space-y-1" key={item.field} data-detail-field={item.field} data-detail-state={state}>
      <dt className="text-sm font-medium text-muted-foreground">{fieldLabel}</dt>
      <dd className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{applicable && edit ? edit(item.field, content, fieldLabel) : content}</dd>
      {item.help && <dd className="text-sm text-muted-foreground">{translate(item.help)}</dd>}
    </div>
  })}</dl>
  return <div className="space-y-6">
    {!!plan.summary.length && <div data-detail-summary="" className="border-b pb-6">{fields(plan.summary)}</div>}
    {plan.groups.map(group => <section key={group.id} data-detail-group={group.id} className="space-y-4">
      <div className="space-y-1"><h2 className="font-semibold">{translate(group.label)}</h2>{group.help && <p className="text-sm text-muted-foreground">{translate(group.help)}</p>}</div>
      {fields(group.fields)}
    </section>)}
  </div>
}
