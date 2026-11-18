import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from '../../src/components/ui/button'
import '../../src/styles.css'

const params = new URLSearchParams(location.search)
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark')
const variant = params.get('variant') as 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
function Proof() {
  const [disabled, setDisabled] = useState(true)
  const [submissions, setSubmissions] = useState(0)
  return <main className="space-y-6 p-6">
    <label><input type="checkbox" checked={disabled} onChange={event => setDisabled(event.target.checked)} /> Disable</label>
    <form onSubmit={event => { event.preventDefault(); setSubmissions(count => count + 1) }}>
      <label>Value<input aria-label="Value" /></label>
      <Button type="submit" variant={variant} disabled={disabled}>Confirm</Button>
    </form>
    <Button type="button" variant={variant}>Enabled</Button>
    <Button asChild variant={variant}><a href="#destination">Back</a></Button>
    <output aria-label="Submissions">{submissions}</output>
  </main>
}
createRoot(document.getElementById('root')!).render(<Proof />)
