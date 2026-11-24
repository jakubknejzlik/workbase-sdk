import { screen, within } from '@testing-library/react'
import type userEvent from '@testing-library/user-event'
import en from '../src/locales/en.json'

type User = ReturnType<typeof userEvent.setup>
type Copy = Pick<typeof en, 'savedViews' | 'savedViewsMenu' | 'savedViewsApplyView' | 'savedViewsSaveNew' | 'savedViewsRenameThis' | 'savedViewsDeleteThis' | 'savedViewsConfirm' | 'savedViewsName' | 'savedViewsDelete'>
/** The personal-views menu: a trigger inside the labelled region, content in a dialog popover. */
export const viewsRegion = (copy: Copy = en) => screen.getByRole('region', { name: copy.savedViews })
export const viewsTrigger = (copy: Copy = en) => within(viewsRegion(copy)).getByRole('button', { name: copy.savedViewsMenu })
export async function openViewsMenu(user: User, copy: Copy = en) {
  if (!screen.queryByRole('dialog', { name: copy.savedViews })) await user.click(viewsTrigger(copy))
  return screen.findByRole('dialog', { name: copy.savedViews })
}
/** Explicit two-step use: choose a candidate, then confirm it. */
export async function applyView(user: User, name: string, copy: Copy = en) {
  const menu = await openViewsMenu(user, copy)
  await user.click(within(menu).getByRole('button', { name }))
  await user.click(within(menu).getByRole('button', { name: copy.savedViewsApplyView }))
}
/** Menu item -> naming dialog; returns the dialog. */
export async function openNaming(user: User, item: keyof Copy, copy: Copy = en) {
  const menu = await openViewsMenu(user, copy)
  await user.click(within(menu).getByRole('button', { name: copy[item] }))
  return screen.findByRole('dialog', { name: /./ })
}
