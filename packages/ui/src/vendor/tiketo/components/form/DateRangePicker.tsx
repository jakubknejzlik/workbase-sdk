import * as React from 'react'
import { CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import { formatCalendarDate as format } from '../../../../data-table/date-format'
import { DateRange } from 'react-day-picker'
import { Button } from '../ui/button'
import { Calendar } from '../ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { cn } from '../../lib/utils'

/**
 * Preset definition for quick date range selection
 */
export interface DateRangePreset {
  value: string
  label: string
  getValue: () => DateRange
}

export interface DateRangePickerProps {
  value?: DateRange
  onChange?: (value: DateRange | undefined) => void
  placeholder?: string
  className?: string
  disabled?: boolean
  minDate?: Date
  maxDate?: Date
  numberOfMonths?: number
  disabledDates?: (date: Date) => boolean
  /** Optional presets for quick date range selection */
  presets?: DateRangePreset[]
  /** Placeholder text for presets dropdown */
  presetsPlaceholder?: string
  /** Alignment of the popover */
  align?: 'start' | 'center' | 'end'
  /** Callback for navigating to previous period */
  onNavigatePrevious?: () => void
  /** Callback for navigating to next period */
  onNavigateNext?: () => void
  /** Whether next navigation is disabled (e.g., at current period) */
  locale?: import('react-day-picker').DayPickerProps['locale']
  label?: string
  disableNext?: boolean
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = React.useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false
  )

  React.useEffect(() => {
    const media = window.matchMedia(query)
    setMatches(media.matches)

    const listener = (e: MediaQueryListEvent) => setMatches(e.matches)
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [query])

  return matches
}

export const DateRangePicker = React.forwardRef<
  HTMLButtonElement,
  DateRangePickerProps
>(
  (
    {
      value,
      onChange,
      placeholder = 'Pick a date range',
      className,
      disabled,
      minDate,
      maxDate,
      numberOfMonths = 2,
      disabledDates,
      presets,
      presetsPlaceholder = 'Select preset',
      align = 'start',
      onNavigatePrevious,
      onNavigateNext,
      disableNext,
      label, locale,
    },
    ref
  ) => {
    const [open, setOpen] = React.useState(false)
    const [localRange, setLocalRange] = React.useState<DateRange | undefined>(
      value
    )
    const [isSelectingNewRange, setIsSelectingNewRange] = React.useState(false)
    const isDesktop = useMediaQuery('(min-width: 768px)')

    const showNavigation = onNavigatePrevious || onNavigateNext

    React.useEffect(() => {
      setLocalRange(value)
    }, [value])

    React.useEffect(() => {
      if (!open) {
        setIsSelectingNewRange(false)
      }
    }, [open])

    React.useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (!open) return

        if (e.key === 'Escape') {
          e.preventDefault()
          setOpen(false)
          setLocalRange(value)
        }
      }

      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }, [open, value])

    const handleSelect = (range: DateRange | undefined) => {
      if (!range?.from) {
        setLocalRange(undefined)
        onChange?.(undefined)
        setIsSelectingNewRange(false)
        return
      }

      if (range.from && !range.to) {
        setLocalRange(range)
        setIsSelectingNewRange(true)
        return
      }

      if (range.from && range.to) {
        if (isSelectingNewRange) {
          setLocalRange(range)
          onChange?.(range)
          setOpen(false)
          setIsSelectingNewRange(false)
        } else {
          setLocalRange({ from: range.from, to: undefined })
          setIsSelectingNewRange(true)
        }
      }
    }

    const handlePresetSelect = (presetValue: string) => {
      const preset = presets?.find((p) => p.value === presetValue)
      if (preset) {
        const range = preset.getValue()
        setLocalRange(range)
        onChange?.(range)
        setOpen(false)
      }
    }

    const isDateDisabled = (date: Date) => {
      if (disabledDates) {
        return disabledDates(date)
      }

      if (minDate && date < minDate) return true
      if (maxDate && date > maxDate) return true

      return false
    }

    const getAriaLabel = () => {
      if (label) return label
      if (localRange?.from && localRange?.to) {
        return `Date range: ${format(localRange.from, 'MMMM d, yyyy')} to ${format(localRange.to, 'MMMM d, yyyy')}`
      }
      if (localRange?.from) {
        return `Date range starting ${format(localRange.from, 'MMMM d, yyyy')}`
      }
      return 'Select date range'
    }

    // On mobile always use single month, otherwise respect numberOfMonths prop
    const effectiveNumberOfMonths = isDesktop ? numberOfMonths : 1

    const pickerButton = (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            ref={ref}
            variant="outline"
            disabled={disabled}
            className={cn(
              'justify-start text-left font-normal',
              !localRange && 'text-muted-foreground',
              className
            )}
            aria-label={getAriaLabel()}
            aria-expanded={open}
            aria-haspopup="dialog"
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {localRange?.from ? (
              localRange.to ? (
                <>
                  {format(localRange.from, 'MMM d, yyyy')} -{' '}
                  {format(localRange.to, 'MMM d, yyyy')}
                </>
              ) : (
                format(localRange.from, 'MMM d, yyyy')
              )
            ) : (
              placeholder
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          aria-label={label ?? placeholder}
          className={cn('w-auto p-0', presets && 'flex flex-col space-y-2 p-2')}
          align={align}
        >
          {presets && presets.length > 0 && (
            <Select onValueChange={handlePresetSelect}>
              <SelectTrigger aria-label="Quick date range presets">
                <SelectValue placeholder={presetsPlaceholder} />
              </SelectTrigger>
              <SelectContent position="popper">
                {presets.map((preset) => (
                  <SelectItem key={preset.value} value={preset.value}>
                    {preset.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className={cn(presets && 'rounded-md border')}>
            <Calendar
              locale={locale}
              mode="range"
              defaultMonth={localRange?.from || minDate}
              selected={localRange}
              onSelect={handleSelect}
              numberOfMonths={effectiveNumberOfMonths}
              disabled={isDateDisabled}
            />
          </div>
        </PopoverContent>
      </Popover>
    )

    if (!showNavigation) {
      return pickerButton
    }

    return (
      <div className="flex items-center gap-2">
        {onNavigatePrevious && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onNavigatePrevious}
            disabled={disabled}
            aria-label="Previous period"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        )}

        {pickerButton}

        {onNavigateNext && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onNavigateNext}
            disabled={disabled || disableNext}
            aria-label="Next period"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        )}
      </div>
    )
  }
)

DateRangePicker.displayName = 'DateRangePicker'
