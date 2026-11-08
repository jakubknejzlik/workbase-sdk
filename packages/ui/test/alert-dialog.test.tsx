import { expect, it } from 'vitest'
import { createRef } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel } from '../src/components/ui/alert-dialog'

it('AlertDialog focuses its own cancel with two open dialogs and forwards its content ref', async () => {
  const second = createRef<HTMLDivElement>()
  function Proof({ openSecond }: { openSecond: boolean }) {
    return <>
      <AlertDialog open><AlertDialogContent><AlertDialogTitle>First dialog</AlertDialogTitle><AlertDialogDescription>First decision</AlertDialogDescription><AlertDialogAction>First action</AlertDialogAction><AlertDialogCancel>First cancel</AlertDialogCancel></AlertDialogContent></AlertDialog>
      <AlertDialog open={openSecond}><AlertDialogContent ref={second}><AlertDialogTitle>Second dialog</AlertDialogTitle><AlertDialogDescription>Second decision</AlertDialogDescription><AlertDialogAction>Second action</AlertDialogAction><AlertDialogCancel>Second cancel</AlertDialogCancel></AlertDialogContent></AlertDialog>
    </>
  }
  const { rerender } = render(<Proof openSecond={false} />)
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First cancel' })))
  rerender(<Proof openSecond />)
  expect(screen.getAllByRole('alertdialog')).toHaveLength(2)
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Second cancel' })))
  expect(second.current).toBe(screen.getByRole('alertdialog', { name: 'Second dialog' }))
})
