"use client"

import type { ReactNode } from "react"
import { Loader2 } from "lucide-react"

import { useState, useEffect } from 'react'
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
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { AlertTriangle } from 'lucide-react'

/**
 * Props for DeleteDialog component
 */
export interface DeleteDialogProps {
  title?: string
  targetDescription?: ReactNode
  cancelText?: string
  confirmText?: string
  children?: ReactNode
  pendingText?: string
  onCloseAutoFocus?: (event: Event) => void
  /** Dialog open state */
  open: boolean
  /** Callback when dialog open state changes */
  onOpenChange: (open: boolean) => void
  /** Entity type for title (e.g., "Member", "Venue") */
  entityType: string
  /** Entity display name (shown in confirmation) */
  entityName: string
  /** Called when delete is confirmed */
  onConfirm: () => Promise<void> | void
  /** Loading state during deletion */
  isDeleting?: boolean
  /** Warning message (default: "This action cannot be undone.") */
  warningMessage?: string
  /** Cascading effects warning (e.g., "This will also remove X related items") */
  cascadeWarning?: string
  /** Whether to require typing entity name to confirm (opt-in) */
  requireTypeConfirm?: boolean
}

/**
 * DeleteDialog component for destructive action confirmation
 *
 * Features:
 * - AlertTriangle icon with destructive styling
 * - Optional type-to-confirm for high-risk deletions
 * - Cascade warning for related data
 * - Loading state with disabled buttons
 *
 * @example Basic usage
 * ```tsx
 * <DeleteDialog
 *   open={open}
 *   onOpenChange={setOpen}
 *   entityType="Member"
 *   entityName="John Doe"
 *   onConfirm={handleDelete}
 *   isDeleting={isPending}
 * />
 * ```
 *
 * @example With type-to-confirm
 * ```tsx
 * <DeleteDialog
 *   open={open}
 *   onOpenChange={setOpen}
 *   entityType="Organization"
 *   entityName="Acme Corp"
 *   onConfirm={handleDelete}
 *   isDeleting={isPending}
 *   cascadeWarning="This will also remove all child organizations and their members."
 *   requireTypeConfirm
 * />
 * ```
 */
export const DeleteDialog = ({
  open,
  title, targetDescription, cancelText = 'Cancel', confirmText = 'Delete',
  children, pendingText, onCloseAutoFocus,
  onOpenChange,
  entityType,
  entityName,
  onConfirm,
  isDeleting = false,
  warningMessage = 'This action cannot be undone.',
  cascadeWarning,
  requireTypeConfirm = false,
}: DeleteDialogProps) => {
  const [confirmInput, setConfirmInput] = useState('')

  // Exact match required (case-sensitive per CONTEXT.md)
  const isConfirmValid = !requireTypeConfirm || confirmInput === entityName

  // Reset input when dialog closes
  useEffect(() => {
    if (!open) {
      setConfirmInput('')
    }
  }, [open])

  const handleConfirm = async () => {
    if (!isConfirmValid || isDeleting) return
    await onConfirm()
  }

  return (
    <AlertDialog open={open} onOpenChange={next => { if (!isDeleting) onOpenChange(next) }}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus} data-testid="delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            {title ?? `Delete ${entityType}?`}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>{warningMessage}</p>
              {cascadeWarning && (
                <p className="text-destructive font-medium">{cascadeWarning}</p>
              )}
              <p>{targetDescription ?? 'You are about to delete'}{' '}<strong className="text-foreground">"{entityName}"</strong></p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {requireTypeConfirm && (
          <div className="my-4 space-y-2">
            <Label htmlFor="delete-confirm-input">
              Type <strong>"{entityName}"</strong> to confirm:
            </Label>
            <Input
              id="delete-confirm-input"
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={entityName}
              disabled={isDeleting}
              autoComplete="off"
            />
          </div>
        )}

        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>{cancelText}</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={isDeleting || !isConfirmValid}
          >
            {isDeleting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />{pendingText ?? 'Deleting...'}</> : confirmText}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
