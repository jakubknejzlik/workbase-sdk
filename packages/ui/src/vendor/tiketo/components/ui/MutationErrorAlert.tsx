import { Alert, AlertDescription } from './alert'
import { AlertCircle } from 'lucide-react'

interface MutationErrorAlertProps {
  isError: boolean
  error: unknown
  fallbackMessage?: string
}

function extractErrorMessages(error: unknown, fallbackMessage: string): string[] {
  // The host supplies translated, closed-code copy; never expose service messages.
  return [fallbackMessage]
}

/**
 * Displays a destructive alert when a mutation fails.
 * Use this at the top of forms to show mutation errors.
 *
 * @example
 * ```tsx
 * const { mutate, isError, error } = usePutMemberMutation()
 *
 * <Form>
 *   <MutationErrorAlert isError={isError} error={error} />
 *   <FormField ... />
 * </Form>
 * ```
 */
export const MutationErrorAlert = ({
  isError,
  error,
  fallbackMessage = 'An error occurred',
}: MutationErrorAlertProps) => {
  if (!isError) return null

  const messages = extractErrorMessages(error, fallbackMessage)

  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertDescription>
        {messages.length === 1 ? (
          messages[0]
        ) : (
          <ul className="list-disc pl-4">
            {messages.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  )
}
