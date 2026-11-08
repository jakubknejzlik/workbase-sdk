"use client"

import { DialogFooter } from "../ui/dialog"
import { Button } from "../ui/button"

export interface UnsavedChangesPromptProps {
  /** Callback when user confirms discarding changes */
  onDiscard: () => void
  /** Callback when user wants to continue editing */
  onContinue: () => void
  /** Custom title text */
  title?: string
  /** Custom message text */
  message?: string
  /** Custom discard button text */
  discardLabel?: string
  /** Custom continue button text */
  continueLabel?: string
}

/**
 * Inline discard confirmation UI component.
 * Used within FormDialog to replace content when user tries to close with unsaved changes.
 *
 * @example
 * ```tsx
 * {showDiscardPrompt ? (
 *   <UnsavedChangesPrompt
 *     onDiscard={() => {
 *       form.reset()
 *       onOpenChange(false)
 *     }}
 *     onContinue={() => setShowDiscardPrompt(false)}
 *   />
 * ) : (
 *   <FormContent />
 * )}
 * ```
 */
export const UnsavedChangesPrompt = ({
  onDiscard,
  onContinue,
  title = "Discard changes?",
  message = "You have unsaved changes that will be lost.",
  discardLabel = "Discard",
  continueLabel = "Continue Editing",
}: UnsavedChangesPromptProps) => (
  <div className="space-y-4 text-left">
    <div className="space-y-2">
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
    <DialogFooter className="flex-row flex-wrap justify-end">
      <Button variant="outline" onClick={onContinue}>
        {continueLabel}
      </Button>
      <Button variant="destructive" onClick={onDiscard}>
        {discardLabel}
      </Button>
    </DialogFooter>
  </div>
)
