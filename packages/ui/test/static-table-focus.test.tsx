import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { StaticDataTable } from '../src'
import { TablePresentationContext, useTablePresentation } from '../src/data-table/presentation'

function WidgetTable() {
  const presentation = useTablePresentation()
  return <TablePresentationContext.Provider value={{ ...presentation, listV2: true, scrollRegion: 'Records', scrollTabStop: 'overflow' }}>
    <StaticDataTable label="Records" data={[{ id: 'record' }]} columns={[{ id: 'id', header: 'Record', cell: () => <a href="/record">Alex Example</a> }]} />
  </TablePresentationContext.Provider>
}

it('keeps the first Tab on a bounded record and exposes the scroll stop only while overflowing', async () => {
  render(<WidgetTable />)
  const user = userEvent.setup()
  const region = screen.getByRole('region', { name: 'Records' })
  await user.tab()
  expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Alex Example' }))
  let scrollLeft = 0
  Object.defineProperty(region, 'scrollLeft', { configurable: true, get: () => scrollLeft, set: value => { scrollLeft = Math.max(0, Math.min(value, region.scrollWidth - region.clientWidth)) } })
  Object.defineProperties(region, { scrollWidth: { configurable: true, value: 700 }, clientWidth: { configurable: true, value: 300 } })
  act(() => { fireEvent.scroll(region) })
  expect(region.tabIndex).toBe(0)
  region.focus()
  await user.keyboard('{End}')
  expect(region.scrollLeft).toBe(400)
  await user.keyboard('{Home}')
  expect(region.scrollLeft).toBe(0)
  Object.defineProperty(region, 'clientWidth', { configurable: true, value: 700 })
  act(() => { fireEvent.scroll(region) })
  expect(region.tabIndex).toBe(-1)
})
