import { useId } from 'react'
import { Input } from '../../ui/input'
export function TextFilter({ value, onChange, label, description }: { value: string; onChange: (value: string) => void; label: string; description?: string }) {
  const descriptionId = useId()
  return <div className="grid gap-1"><label className="grid gap-1 text-sm">{label}<Input aria-describedby={description ? descriptionId : undefined} value={value} maxLength={2000} onChange={event => onChange(event.target.value)} /></label>{description && <p id={descriptionId} className="text-sm text-muted-foreground">{description}</p>}</div>
}
