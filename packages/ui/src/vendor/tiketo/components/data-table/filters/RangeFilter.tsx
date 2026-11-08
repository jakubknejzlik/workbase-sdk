import { Input } from '../../ui/input'
export interface RangeInput { value?: string; from?: string; to?: string }
/** Source range input composition; bounds/validity and staged Apply are supplied by the host. */
export function RangeFilter({ value, onChange, labels }: { value: RangeInput; onChange: (value: RangeInput) => void; labels: { single: string; from: string; to: string } }) {
  return <div className="space-y-3"><label className="grid gap-1 text-sm">{labels.single}<Input type="number" step="any" value={value.value ?? ''} onChange={event => onChange({ value: event.target.value })} /></label><div className="grid grid-cols-2 gap-2">{(['from', 'to'] as const).map(key => <label key={key} className="grid gap-1 text-sm">{labels[key]}<Input type="number" step="any" value={value[key] ?? ''} onChange={event => onChange({ ...value, value: undefined, [key]: event.target.value })} /></label>)}</div></div>
}
