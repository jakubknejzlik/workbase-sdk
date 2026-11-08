import { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip'
import { ArrowLeft } from 'lucide-react'

export interface DetailPageHeaderProps {
  /** Complete back link element (takes precedence over backUrl) */
  backLink?: ReactNode
  /** URL for default back link (uses anchor if backLink not provided) */
  backUrl?: string
  /** Label for back button (default: "Back") */
  backLabel?: string
  /** The title to display - can be a string or ReactNode */
  title: string | ReactNode
  /** Optional badge to display next to the title (e.g., type badge) */
  badge?: ReactNode
  /** Callback when edit button is clicked. If not provided, edit button won't be shown */
  onEdit?: () => void
  /** Whether the edit button is disabled */
  editDisabled?: boolean
  /** Tooltip text when edit button is disabled */
  editDisabledTooltip?: string
  /** Callback when delete button is clicked. If not provided, delete button won't be shown */
  onDelete?: () => void
  /** Whether the delete button is disabled */
  deleteDisabled?: boolean
  /** Tooltip text when delete button is disabled */
  deleteDisabledTooltip?: string
  /** Extra action buttons to show (rendered between edit and delete) */
  extraActions?: ReactNode
  /** Optional label for the edit button (default: "Edit") */
  editLabel?: string
  /** Optional label for the delete button (default: "Delete") */
  deleteLabel?: string
  /** Additional CSS classes for container */
  className?: string
}

/**
 * DetailPageHeader provides a consistent header for detail pages with:
 * - Router-agnostic back navigation (via backLink ReactNode or backUrl anchor fallback)
 * - Title and optional badge display
 * - Edit and delete action buttons
 * - Support for extra custom actions
 *
 * @example
 * ```tsx
 * // With TanStack Router (via backLink)
 * import { Link } from '@tanstack/react-router'
 *
 * <DetailPageHeader
 *   backLink={
 *     <Link to="/members">
 *       <Button variant="ghost" size="sm">
 *         <ArrowLeft className="mr-2 h-4 w-4" />
 *         Back to Members
 *       </Button>
 *     </Link>
 *   }
 *   title="John Doe"
 *   badge={<Badge>Active</Badge>}
 *   onEdit={openEditDialog}
 *   onDelete={openDeleteDialog}
 * />
 *
 * // With plain anchor (via backUrl)
 * <DetailPageHeader
 *   backUrl="/members"
 *   backLabel="Back to Members"
 *   title="John Doe"
 *   onEdit={openEditDialog}
 * />
 * ```
 */
export function DetailPageHeader({
  backLink,
  backUrl,
  backLabel = 'Back',
  title,
  badge,
  onEdit,
  editDisabled,
  editDisabledTooltip,
  onDelete,
  deleteDisabled,
  deleteDisabledTooltip,
  extraActions,
  editLabel = 'Edit',
  deleteLabel = 'Delete',
  className,
}: DetailPageHeaderProps) {
  return (
    <div className={cn('space-y-4', className)}>
      {/* Back Navigation */}
      {(backLink || backUrl) && (
        <div className="flex items-center gap-4">
          {backLink ?? (backUrl && (
            <a href={backUrl}>
              <Button variant="ghost" size="sm">
                <ArrowLeft className="mr-2 h-4 w-4" />
                {backLabel}
              </Button>
            </a>
          ))}
        </div>
      )}

      {/* Title and Actions */}
      <div className="flex flex-wrap justify-between items-start gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <h1 tabIndex={-1} className="text-2xl font-bold [overflow-wrap:anywhere]">{title}</h1>
          {badge}
        </div>
        <div className="flex flex-wrap gap-2">
          {extraActions}
          {onEdit && (
            editDisabled && editDisabledTooltip ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button variant="outline" size="sm" disabled>
                      {editLabel}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{editDisabledTooltip}</TooltipContent>
              </Tooltip>
            ) : (
              <Button variant="outline" size="sm" onClick={onEdit} disabled={editDisabled}>
                {editLabel}
              </Button>
            )
          )}
          {onDelete && (
            deleteDisabled && deleteDisabledTooltip ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button variant="outline" size="sm" disabled>
                      {deleteLabel}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{deleteDisabledTooltip}</TooltipContent>
              </Tooltip>
            ) : (
              <Button variant="outline" size="sm" onClick={onDelete} disabled={deleteDisabled}>
                {deleteLabel}
              </Button>
            )
          )}
        </div>
      </div>
    </div>
  )
}
