import { expect, it, vi } from 'vitest'
import { useState } from 'react'
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
