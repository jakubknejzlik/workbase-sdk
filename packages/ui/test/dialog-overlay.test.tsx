import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { Root, Portal, Overlay, Content, Title, Description } from '../src/components/ui/adapters/dialog'

function Dialog({ open }: { open: boolean }) {
  return <Root open={open}><Portal forceMount><Overlay data-testid="backdrop" /><Content><Title>Naming</Title><Description>Save a view</Description><button>Save view</button></Content></Portal></Root>
}
it('removes the closed backdrop even while a force-mounted portal retains exiting content', () => {
  const view = render(<Dialog open />)
  expect(screen.getAllByTestId('backdrop')).toHaveLength(1)
  expect(screen.getByTestId('backdrop').getAttribute('data-state')).toBe('open')
  view.rerender(<Dialog open={false} />)
  expect(screen.queryByTestId('backdrop')).toBeNull()
  view.rerender(<Dialog open />)
  expect(screen.getAllByTestId('backdrop')).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Save view' })).toBeTruthy()
})
it('tracks uncontrolled trigger and close transitions without leaving a backdrop', async () => {
  const { Trigger, Close } = await import('../src/components/ui/adapters/dialog')
  const { default: userEvent } = await import('@testing-library/user-event')
  const user = userEvent.setup()
  render(<Root><Trigger>Open</Trigger><Portal forceMount><Overlay data-testid="backdrop" /><Content><Title>Naming</Title><Description>Save a view</Description><Close>Save</Close></Content></Portal></Root>)
  expect(screen.queryByTestId('backdrop')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Open' }))
  expect(screen.getAllByTestId('backdrop')).toHaveLength(1)
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(screen.queryByTestId('backdrop')).toBeNull()
})
