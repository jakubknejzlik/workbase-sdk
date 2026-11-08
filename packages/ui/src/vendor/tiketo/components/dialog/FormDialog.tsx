'use client'

import * as React from 'react'
import { useState, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog'
import {
  UnsavedChangesPrompt,
  type UnsavedChangesPromptProps,
} from './UnsavedChangesPrompt'

export interface FormDialogProps {
  /** Dialog open state */
  open: boolean
  /** Callback when dialog open state changes */
  onOpenChange: (open: boolean) => void
  /** Dialog title */
  title: React.ReactNode
  /** Dialog description (optional) */
  description?: string
  /**
   * Pass formState from React Hook Form for dirty/submitting tracking.
   * Used to determine whether to show unsaved changes warning.
   */
  formState?: {
    isDirty?: boolean
    isSubmitting?: boolean
  }
  /**
   * Called when form should reset (for discard action).
   * Typically calls form.reset() from React Hook Form.
   */
  onReset?: () => void
  /** Max width class (e.g., 'sm:max-w-[500px]') */
  maxWidth?: string
  /** Optional alignment for host dialog headings and descriptions. */
  headerClassName?: string
  /** Whether to show the close button. Default: true */
  showCloseButton?: boolean
  /** Localized labels for the unsaved changes prompt. */
  discardPrompt?: Pick<
    UnsavedChangesPromptProps,
    'title' | 'message' | 'discardLabel' | 'continueLabel'
  >
  /** Host navigation/focus/localization slots; form controller survives discard UI. */
  closeRequest?: number
  onContinueEditing?: () => void
  closeLabel?: string
  onCloseAutoFocus?: (event: Event) => void
  onOpenAutoFocus?: (event: Event) => void
  /** Form content - rendered inside dialog body */
  children: React.ReactNode
}

/**
 * FormDialog provides consistent dialog UX for form operations with:
 * - Automatic dirty detection via formState prop
 * - Inline discard confirmation when closing with unsaved changes
 * - Close prevention during form submission
 *
 * Pattern: Dialog contains Form as children (Approach A from audit)
 *
 * @example
 * ```tsx
 * const form = useForm<VenueFormValues>({
 *   defaultValues: { name: venue?.name ?? '' },
 * })
 *
 * return (
 *   <FormDialog
 *     open={open}
 *     onOpenChange={onOpenChange}
 *     title={venue ? 'Edit Venue' : 'Create Venue'}
 *     formState={form.formState}
 *     onReset={() => form.reset()}
 *   >
 *     <Form {...form}>
 *       <form onSubmit={form.handleSubmit(onSubmit)}>
 *         <FormField ... />
 *         <Button type="submit">Save</Button>
 *       </form>
 *     </Form>
 *   </FormDialog>
 * )
 * ```
 */
export const FormDialog = ({
  open,
  onOpenChange,
  title,
  description,
  formState,
  onReset,
  maxWidth = 'sm:max-w-[500px]',
  headerClassName,
  showCloseButton = true,
  discardPrompt,
  children,
  closeRequest, onContinueEditing, closeLabel, onCloseAutoFocus, onOpenAutoFocus,
}: FormDialogProps) => {
  const [showDiscardPrompt, setShowDiscardPrompt] = useState(false)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const previousFocus = React.useRef<HTMLElement | null>(null)
  React.useEffect(() => {
    if (showDiscardPrompt) {
      previousFocus.current = document.activeElement as HTMLElement
      contentRef.current?.querySelector<HTMLElement>('[data-slot="discard-prompt"] button')?.focus()
    } else if (previousFocus.current) {
      if (contentRef.current?.contains(previousFocus.current)) previousFocus.current.focus()
      else contentRef.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)')?.focus()
      previousFocus.current = null
    }
  }, [showDiscardPrompt])

  const isDirty = formState?.isDirty ?? false
  const isSubmitting = formState?.isSubmitting ?? false

  // Handle open state changes (including close button clicks)
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      // Opening - always allow
      if (newOpen) {
        setShowDiscardPrompt(false)
        onOpenChange(true)
        return
      }

      // Closing - check conditions
      if (isSubmitting) {
        return // Block close during submit
      }

      if (isDirty) {
        setShowDiscardPrompt(true)
        return // Show discard prompt
      }

      onOpenChange(false)
    },
    [isDirty, isSubmitting, onOpenChange],
  )

  // Prevent ESC close when dirty or submitting
  const handleEscapeKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (isSubmitting) {
        event.preventDefault()
        return
      }
      if (isDirty) {
        event.preventDefault()
        setShowDiscardPrompt(true)
      }
    },
    [isDirty, isSubmitting],
  )

  // Prevent backdrop click close when dirty or submitting
  const handlePointerDownOutside = useCallback(
    (event: Event) => {
      if (isSubmitting) {
        event.preventDefault()
        return
      }
      if (isDirty) {
        event.preventDefault()
        setShowDiscardPrompt(true)
      }
    },
    [isDirty, isSubmitting],
  )

  // Handle discard - reset form and close dialog
  const handleDiscard = useCallback(() => {
    onReset?.()
    setShowDiscardPrompt(false)
    onOpenChange(false)
  }, [onReset, onOpenChange])

  // Handle continue editing - hide discard prompt
  const handleContinueEditing = useCallback(() => {
    setShowDiscardPrompt(false)
    onContinueEditing?.()
  }, [onContinueEditing])

  // Reset discard prompt when dialog opens
  React.useEffect(() => {
    if (open) {
      setShowDiscardPrompt(false)
    }
  }, [open])

  React.useEffect(() => {
    if (closeRequest) handleOpenChange(false)
  }, [closeRequest])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        ref={contentRef}
        closeLabel={closeLabel}
        onCloseAutoFocus={onCloseAutoFocus}
        onOpenAutoFocus={onOpenAutoFocus}
        className={`${showDiscardPrompt ? 'sm:max-w-lg' : maxWidth} max-h-[90vh] overflow-y-auto`}
        onEscapeKeyDown={handleEscapeKeyDown}
        onPointerDownOutside={handlePointerDownOutside}
        onInteractOutside={handlePointerDownOutside}
        showCloseButton={showCloseButton && !showDiscardPrompt}>
        <DialogHeader className={showDiscardPrompt ? 'sr-only' : headerClassName}>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {showDiscardPrompt && <div data-slot="discard-prompt"><UnsavedChangesPrompt onDiscard={handleDiscard} onContinue={handleContinueEditing} {...discardPrompt} /></div>}
        {/* Keep the host controller/RHF/mutation tree alive while source prompt is shown. */}
        <div hidden={showDiscardPrompt}>{children}</div>
      </DialogContent>
    </Dialog>
  )
}
