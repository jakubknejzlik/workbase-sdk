import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from '../../src/components/ui/button'
import '../../src/styles.css'

const params = new URLSearchParams(location.search)
const mode = params.get('mode')
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark')

function Proof() {
  const [disabled, setDisabled] = useState(true)
  const [handlers, setHandlers] = useState<string[]>([])
  const record = (name: string) => () => setHandlers(previous => [...previous, name])
  return <main className="space-y-6 p-6">
    <h1>Disabled slotted link: {mode}</h1>
    <label><input type="checkbox" checked={disabled} onChange={event => setDisabled(event.target.checked)} /> Disable</label>
    <Button asChild disabled={disabled && (mode === 'disabled' || mode === 'both')}
      aria-disabled={disabled && (mode === 'aria' || mode === 'both') ? 'true' : undefined}
      onMouseDownCapture={record('button-mousedown-capture')} onMouseDown={record('button-mousedown')}
      onAuxClickCapture={record('button-auxclick-capture')} onAuxClick={record('button-auxclick')}>
      <a href="/button-disabled-links.html?destination=1" aria-disabled={disabled && mode === 'child-aria' ? 'true' : undefined}
        onMouseDownCapture={record('child-mousedown-capture')} onMouseDown={record('child-mousedown')}
        onAuxClickCapture={record('child-auxclick-capture')} onAuxClick={record('child-auxclick')}>Destination</a>
    </Button>
    <output aria-label="Handlers">{JSON.stringify(handlers)}</output>
  </main>
}

createRoot(document.getElementById('root')!).render(<Proof />)
