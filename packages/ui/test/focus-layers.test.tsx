import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useFocusContainment } from '../src/components/ui/focus-containment'
function Layer({ state, name }: { state: 'open' | 'closed'; name: string }) {
  const focus = useFocusContainment<HTMLDivElement>()
  return <div data-state={state} ref={focus.ref}><button>{name}</button></div>
}
it('an exiting menu portal cannot capture focus returned from its dialog', () => {
  render(<><button>Row menu trigger</button><Layer name="Exiting menu" state="closed" /></>)
  const trigger = screen.getByRole('button', { name: 'Row menu trigger' }); trigger.focus()
  expect(document.activeElement).toBe(trigger)
})
it('the open parent keeps containment while a closed nested portal finishes its animation', () => {
  render(<><button>Outside</button><Layer name="Open parent" state="open" /><Layer name="Exiting child" state="closed" /></>)
  screen.getByRole('button', { name: 'Outside' }).focus()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open parent' }))
})
