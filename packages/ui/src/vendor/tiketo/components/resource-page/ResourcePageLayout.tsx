import * as React from 'react'
import { Plus } from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip'

export interface ResourcePageLayoutProps {
  title: string
  actionLabel?: string
  onAction?: () => void
  actionDisabled?: boolean
  actionDisabledTooltip?: string
  headerActions?: React.ReactNode
  children: React.ReactNode
}

export function ResourcePageLayout({
  title,
  actionLabel,
  onAction,
  actionDisabled,
  actionDisabledTooltip,
  headerActions,
  children,
}: ResourcePageLayoutProps) {
  return (
    <div className="space-y-4 min-w-0">
      <div className="flex flex-wrap justify-between items-center gap-2 min-h-10">
        <h1 tabIndex={-1} className="text-2xl font-bold min-w-0 [overflow-wrap:anywhere]">{title}</h1>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {headerActions}
          {actionLabel && onAction && (
            actionDisabled && actionDisabledTooltip ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button disabled>
                      <Plus className="mr-2 h-4 w-4" />
                      {actionLabel}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{actionDisabledTooltip}</TooltipContent>
              </Tooltip>
            ) : (
              <Button onClick={onAction} disabled={actionDisabled}>
                <Plus className="mr-2 h-4 w-4" />
                {actionLabel}
              </Button>
            )
          )}
        </div>
      </div>
      {children}
    </div>
  )
}
