import * as React from 'react'
import { Search, X, Command } from 'lucide-react'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'

export type SearchVariant =
  | 'default'
  | 'with-icon'
  | 'with-button'
  | 'expandable'
  | 'with-shortcut'
  | 'with-clear'

export interface DataTableSearchProps {
  /** Current search value */
  value: string
  /** Callback when search value changes */
  onChange: (value: string) => void
  /** Placeholder text */
  placeholder?: string
  /** Visual variant of the search input */
  variant?: SearchVariant
  /** Additional CSS classes */
  className?: string
  /** Debounce delay in milliseconds (default: 300) */
  debounceMs?: number
  /** Enable keyboard shortcut (Cmd+K / Ctrl+K) */
  label?: string
  clearLabel?: string
  description?: string
  enableShortcut?: boolean
}

/**
 * DataTableSearch - A search input component for DataTable with multiple visual variants.
 *
 * Variants:
 * - `default`: Simple input field
 * - `with-icon`: Input with search icon inside
 * - `with-button`: Input with separate search button
 * - `expandable`: Icon that expands to input on click
 * - `with-shortcut`: Input showing keyboard shortcut hint
 * - `with-clear`: Input with clear button when value exists
 */
export const DataTableSearch: React.FC<DataTableSearchProps> = ({
  value,
  onChange,
  placeholder = 'Search...',
  variant = 'default',
  className,
  debounceMs = 300,
  enableShortcut = false,
  label, clearLabel, description,
}) => {
  const localValue = value
  const [isExpanded, setIsExpanded] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const handleChange = onChange

  // Keyboard shortcut handler
  React.useEffect(() => {
    if (!enableShortcut && variant !== 'with-shortcut') return

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        if (variant === 'expandable') {
          setIsExpanded(true)
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [enableShortcut, variant])

  const handleClear = () => {
    onChange('')
    inputRef.current?.focus()
  }

  const handleExpandToggle = () => {
    setIsExpanded(!isExpanded)
    if (!isExpanded) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }

  const handleBlur = () => {
    if (variant === 'expandable' && !localValue) {
      setIsExpanded(false)
    }
  }

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault()
    onChange(localValue)
  }

  // Variant: Default - Simple input
  if (variant === 'default') {
    return (
      <Input
        ref={inputRef}
        type="text"
          role="searchbox"
          aria-label={label}
          aria-description={description}
          maxLength={2000}
        value={localValue}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        className={cn('max-w-sm', className)}
      />
    )
  }

  // Variant: With Icon - Input with search icon inside
  if (variant === 'with-icon') {
    return (
      <div className={cn('relative max-w-sm', className)}>
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          ref={inputRef}
          type="text"
          role="searchbox"
          aria-label={label}
          aria-description={description}
          maxLength={2000}
          value={localValue}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={placeholder}
          className="pl-9"
        />
      </div>
    )
  }

  // Variant: With Button - Input + separate search button
  if (variant === 'with-button') {
    return (
      <form onSubmit={handleSubmit} className={cn('flex gap-2 max-w-sm', className)}>
        <Input
          ref={inputRef}
          type="text"
          role="searchbox"
          aria-label={label}
          aria-description={description}
          maxLength={2000}
          value={localValue}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1"
        />
        <Button type="submit" size="sm" variant="secondary">
          <Search className="h-4 w-4 mr-1" />
          {label ?? placeholder}
        </Button>
      </form>
    )
  }

  // Variant: Expandable - Icon that expands to input
  if (variant === 'expandable') {
    return (
      <div className={cn('flex items-center', className)}>
        {isExpanded ? (
          <div className="relative flex items-center">
            <Search className="absolute left-3 h-4 w-4 text-muted-foreground" />
            <Input
              ref={inputRef}
              type="text"
          role="searchbox"
          aria-label={label}
          aria-description={description}
          maxLength={2000}
              value={localValue}
              onChange={(e) => handleChange(e.target.value)}
              onBlur={handleBlur}
              placeholder={placeholder}
              className="pl-9 w-64 transition-all duration-200"
              autoFocus
            />
            {localValue && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleClear}
            aria-label={clearLabel}
                className="absolute right-1 h-7 w-7 p-0"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleExpandToggle}
            className="h-9 w-9 p-0"
          >
            <Search className="h-4 w-4" />
          </Button>
        )}
      </div>
    )
  }

  // Variant: With Shortcut - Input showing keyboard shortcut hint
  if (variant === 'with-shortcut') {
    const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0

    return (
      <div className={cn('relative max-w-sm', className)}>
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          ref={inputRef}
          type="text"
          role="searchbox"
          aria-label={label}
          aria-description={description}
          maxLength={2000}
          value={localValue}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={placeholder}
          className="pl-9 pr-16"
        />
        <kbd className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
          {isMac ? <Command className="h-3 w-3" /> : 'Ctrl+'}
          {isMac ? 'K' : 'K'}
        </kbd>
      </div>
    )
  }

  // Variant: With Clear - Input with clear button
  if (variant === 'with-clear') {
    return (
      <div className={cn('relative max-w-sm', className)}>
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          ref={inputRef}
          type="text"
          role="searchbox"
          aria-label={label}
          aria-description={description}
          maxLength={2000}
          value={localValue}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={placeholder}
          className={cn('pl-9', localValue && 'pr-9')}
        />
        {localValue && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleClear}
            aria-label={clearLabel}
            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0 hover:bg-transparent"
          >
            <X className="h-4 w-4 text-muted-foreground hover:text-foreground" />
          </Button>
        )}
      </div>
    )
  }

  // Fallback to default
  return (
    <Input
      ref={inputRef}
      type="text"
          role="searchbox"
          aria-label={label}
          aria-description={description}
          maxLength={2000}
      value={localValue}
      onChange={(e) => handleChange(e.target.value)}
      placeholder={placeholder}
      className={cn('max-w-sm', className)}
    />
  )
}

DataTableSearch.displayName = 'DataTableSearch'
