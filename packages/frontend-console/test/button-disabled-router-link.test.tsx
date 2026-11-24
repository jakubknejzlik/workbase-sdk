import { expect, it, vi } from 'vitest'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen } from '@testing-library/react'
import { Button } from '@workbasehq/ui/components/ui/button'
import { ButtonLinkRouter, ButtonRouterLink } from './fixtures/button-link'

it.each(['disabled', 'aria-boolean', 'aria-string', 'both', 'child-aria'] as const)('207 %s omits the TanStack Link from the React tree until enabled', async mode => {
  const rendered = vi.fn()
  const content = (disabled: boolean) => <Button asChild
    disabled={disabled && (mode === 'disabled' || mode === 'both')}
    aria-disabled={disabled && mode === 'aria-boolean' ? true : disabled && (mode === 'aria-string' || mode === 'both') ? 'true' : undefined}>
    <ButtonRouterLink aria-disabled={disabled && mode === 'child-aria' ? 'true' : undefined} onRender={rendered}>
      <span>Router destination</span>
    </ButtonRouterLink>
  </Button>
  function Proof() {
    const [disabled, setDisabled] = useState(true)
    return <><button onClick={() => setDisabled(value => !value)}>Toggle</button>{content(disabled)}</>
  }
  render(<ButtonLinkRouter><Proof /></ButtonLinkRouter>)
  await screen.findByText('Router destination')
  const text = screen.getByText('Router destination').closest('[data-slot="button"]')!
  expect(text.tagName).toBe('SPAN')
  expect(text.getAttribute('aria-disabled')).toBe('true')
  expect(text.classList.contains('aria-disabled:bg-muted')).toBe(true)
  expect(document.querySelector('a, [href]')).toBeNull()
  expect(rendered).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Toggle' }))
  const link = await screen.findByRole('link', { name: 'Router destination' })
  expect(link.getAttribute('href')).toBe('/button-disabled-links.html?destination=1')
  expect(rendered).toHaveBeenCalled()
  expect(fireEvent.contextMenu(link)).toBe(true)
  expect(fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))).toBe(true)
})

// Descendants must disappear too: removing just the outer link leaves active labels.
it.each(['disabled', 'aria-boolean', 'aria-string', 'both'] as const)('207 redesign2 %s reduces nested router content to presentation-only text', async mode => {
  const activate = vi.fn(() => { window.location.hash = 'nested-activated' })
  const props = {
    disabled: mode === 'disabled' || mode === 'both',
    'aria-disabled': mode === 'aria-boolean' ? true : mode === 'aria-string' || mode === 'both' ? 'true' as const : undefined,
  }
  const originalURL = window.location.href
  render(<ButtonLinkRouter><><Button asChild {...props}><ButtonRouterLink>
    <><span onClick={activate} onMouseDown={activate} onAuxClick={activate}>Label</span>{' '}<span>
      <a href="#nested" tabIndex={0} onClick={activate}>Nested link</a>{' '}
      <button onClick={activate}>Nested button</button>{' '}{[7, <span key="tail">tail</span>]}{false}{null}
    </span></>
  </ButtonRouterLink></Button><button>Next</button></></ButtonLinkRouter>)
  const label = await screen.findByText('Label', { exact: false })
  const root = label.closest('[data-slot="button"]')!
  const target = root.querySelector('span') ?? root
  fireEvent.click(target)
  fireEvent.mouseDown(target, { button: 1 })
  fireEvent(target, new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))
  expect(activate).not.toHaveBeenCalled()
  expect(window.location.href).toBe(originalURL)
  expect(root.textContent).toBe('Label Nested link Nested button 7tail')
  expect(root.children).toHaveLength(0)
  expect(root.querySelector('a, button, [href], [tabindex]')).toBeNull()
  expect(root.getAttribute('aria-disabled')).toBe('true')
  expect(root.classList.contains('aria-disabled:bg-muted')).toBe(true)
  ;(root as HTMLElement).focus()
  expect(document.activeElement).not.toBe(root)
  await userEvent.setup().tab()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }))
})
