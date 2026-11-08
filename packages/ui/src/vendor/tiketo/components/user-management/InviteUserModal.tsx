import type { ReactNode, ComponentProps } from 'react'
import { FormDialog } from '../dialog/FormDialog'

/** Source invite sizing; P4/P1 provide the guarded form and localized fields. */
export function InviteUserModal({ children, ...props }: Omit<ComponentProps<typeof FormDialog>, 'maxWidth'> & { children: ReactNode }) {
  return <FormDialog {...props} maxWidth="sm:max-w-[425px]">{children}</FormDialog>
}
