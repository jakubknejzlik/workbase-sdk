"use client"

import type { ReactNode } from "react"
import { Loader2 } from "lucide-react"

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '../ui/alert-dialog'
import { Button } from '../ui/button'

/**
 * Props for ConfirmDialog component
 */
export interface ConfirmDialogProps {
  children?: ReactNode
  pendingText?: string
  onCloseAutoFocus?: (event: Event) => void
  /** Dialog open state */
  open: boolean
  /** Callback when dialog open state changes */
  onOpenChange: (open: boolean) => void
  /** Dialog title */
  title: string
  /** Dialog description */
  description: string
  /** Confirm button text (default: "Confirm") */
  confirmText?: string
  /** Cancel button text (default: "Cancel") */
  cancelText?: string
  /** Confirm button variant (default: "default") */
  confirmVariant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
  /** Called when confirmed */
  onConfirm: () => Promise<void> | void
  /** Loading state during confirmation */
  isConfirming?: boolean
}

/**
 * ConfirmDialog component for generic confirmation patterns
 *
 * Uses AlertDialog to prevent accidental dismiss via ESC or backdrop click.
 * For delete-specific confirmations with type-to-confirm, use DeleteDialog instead.
 *
 * @example Basic usage
 * ```tsx
 * <ConfirmDialog
 *   open={open}
 *   onOpenChange={setOpen}
 *   title="Archive Project?"
 *   description="This project will be moved to the archive and hidden from the main list."
 *   onConfirm={handleArchive}
 *   isConfirming={isPending}
 * />
 * ```
 *
 * @example With destructive variant
 * ```tsx
 * <ConfirmDialog
 *   open={open}
 *   onOpenChange={setOpen}
 *   title="Remove Access?"
 *   description="This user will no longer be able to access this workspace."
 *   confirmText="Remove"
 *   confirmVariant="destructive"
 *   onConfirm={handleRemove}
 *   isConfirming={isPending}
 * />
 * ```
 */
export const ConfirmDialog = ({
  open,
  children, pendingText, onCloseAutoFocus,
  onOpenChange,
  title,
  description,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  confirmVariant = 'default',
  onConfirm,
  isConfirming = false,
}: ConfirmDialogProps) => {
  const handleConfirm = async () => {
    if (isConfirming) return
    await onConfirm()
  }

  return (
    <AlertDialog open={open} onOpenChange={next => { if (!isConfirming) onOpenChange(next) }}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isConfirming}>
            {cancelText}
          </AlertDialogCancel>
          <Button
            variant={confirmVariant}
            onClick={handleConfirm}
            disabled={isConfirming}
          >
            {isConfirming ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />{pendingText ?? 'Confirming...'}</> : confirmText}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
