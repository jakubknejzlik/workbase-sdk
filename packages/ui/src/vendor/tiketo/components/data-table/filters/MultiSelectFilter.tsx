import { Checkbox } from '../../ui/checkbox'
export function MultiSelectFilter({ value, onChange, options, cap = 20, capLabel }: { value: string[]; onChange: (value: string[]) => void; options: { id: string; label: string }[]; cap?: number; capLabel: string }) {
  return <div className="grid gap-2 text-sm">{options.map(option => <label key={option.id} className="m-0! flex! min-h-7 items-center gap-2"><Checkbox checked={value.includes(option.id)} disabled={!value.includes(option.id) && value.length >= cap} onCheckedChange={checked => onChange(checked === true ? [...value, option.id] : value.filter(id => id !== option.id))} />{option.label}</label>)}{value.length >= cap && <p role="status">{capLabel}</p>}</div>
}
