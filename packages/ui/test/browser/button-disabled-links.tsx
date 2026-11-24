import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from '../../src/components/ui/button'
import '../../src/styles.css'
import { ButtonLinkRouter, ButtonRouterLink } from '../../../frontend-console/test/fixtures/button-link'

const params = new URLSearchParams(location.search)
const mode = params.get('mode')
const Child = params.get('kind') === 'router' ? ButtonRouterLink : 'a'
const nested = params.get('nested')
const variant = params.get('variant') as 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link' | null
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark')

function Proof() {
  const [disabled, setDisabled] = useState(true)
  const [handlers, setHandlers] = useState<string[]>([])
  const record = (name: string) => () => setHandlers(previous => [...previous, name])
  const activate = (name: string) => () => { record(name)(); location.hash = name }
  const label = nested === 'handler'
    ? <span onClick={activate('label-click')} onMouseDown={event => { if (event.button === 1) activate('label-middle')() }} onAuxClick={activate('label-auxclick')}>Destination</span>
    : nested === 'interactive'
      ? <span><a href="#nested" onClick={activate('nested-link')}>Nested link</a>{' '}<button onClick={activate('nested-button')}>Nested button</button></span>
      : 'Destination'
  return <main style={{ display: 'grid', gap: 24, justifyItems: 'start', padding: 24, minHeight: '100vh', alignContent: 'start', background: 'var(--background)', color: 'var(--foreground)' }}>
    <h1>Disabled slotted link: {params.get('kind')} / {mode} / {variant ?? 'default'}</h1>
    <label><input type="checkbox" checked={disabled} onChange={event => { setDisabled(event.target.checked); setHandlers([]) }} /> Disable</label>
    <Button asChild variant={variant ?? 'default'} disabled={disabled && (mode === 'disabled' || mode === 'both')}
      aria-disabled={disabled && (mode === 'aria' || mode === 'both') ? 'true' : disabled && mode === 'aria-boolean' ? true : undefined}
      onContextMenu={record('button-contextmenu')} onClick={record('button-click')} onKeyDown={record('button-keydown')} onKeyUp={record('button-keyup')}
      onMouseDownCapture={record('button-mousedown-capture')} onMouseDown={record('button-mousedown')}
      onAuxClickCapture={record('button-auxclick-capture')} onAuxClick={record('button-auxclick')}>
      <Child {...(mode === 'child-disabled' ? { disabled } : {})} href="/button-disabled-links.html?destination=1" aria-disabled={disabled && mode === 'child-aria' ? 'true' : undefined}
        onContextMenu={record('child-contextmenu')} onClick={record('child-click')} onKeyDown={record('child-keydown')} onKeyUp={record('child-keyup')}
        onMouseDownCapture={record('child-mousedown-capture')} onMouseDown={record('child-mousedown')}
        onAuxClickCapture={record('child-auxclick-capture')} onAuxClick={record('child-auxclick')}>{label}</Child>
    </Button>
    <button>Next</button>
    <output aria-label="Handlers">{JSON.stringify(handlers)}</output>
  </main>
}

createRoot(document.getElementById('root')!).render(<ButtonLinkRouter><Proof /></ButtonLinkRouter>)
