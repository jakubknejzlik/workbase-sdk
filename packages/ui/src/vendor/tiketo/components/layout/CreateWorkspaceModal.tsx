import { Plus } from 'lucide-react'
import { type ReactNode } from 'react'
import { FormDialog, type FormDialogProps } from '../dialog/FormDialog'

/** Source 425px creation shell; P4 form and P1 controller supplied by the host. */
export function CreateWorkspaceModal({ dialog, children }: {
  dialog: Omit<FormDialogProps, 'children'>; children: ReactNode
}) {
  return <FormDialog {...dialog} headerClassName="text-left" title={<span className="flex items-center gap-2"><Plus className="h-5 w-5" />{dialog.title}</span>} maxWidth="sm:max-w-[425px]">{children}</FormDialog>
}
