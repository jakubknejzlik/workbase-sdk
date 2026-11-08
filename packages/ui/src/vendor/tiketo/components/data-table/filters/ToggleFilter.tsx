import { useId } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
export function ToggleFilter({ value, onChange, labels }: { value: boolean | undefined; onChange: (value: boolean | undefined) => void; labels: { label: string; all: string; yes: string; no: string } }) {
  const id = useId()
  return <div className="grid gap-1 text-sm"><label id={id}>{labels.label}</label><Select value={value === undefined ? 'all' : String(value)} onValueChange={next => onChange(next === 'all' ? undefined : next === 'true')}><SelectTrigger aria-labelledby={id}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{labels.all}</SelectItem><SelectItem value="true">{labels.yes}</SelectItem><SelectItem value="false">{labels.no}</SelectItem></SelectContent></Select></div>
}
