import * as React from 'react'
import { CalendarIcon } from 'lucide-react'
import { format, type Locale } from 'date-fns'
import { Button } from '../ui/button'
import { Calendar } from '../ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { cn } from '../../lib/utils'

export interface DatePickerProps extends Omit<React.ComponentProps<'button'>, 'value' | 'onChange'> {
  locale?: Locale

  value?: Date
  onChange?: (value: Date | undefined) => void
  placeholder?: string
  className?: string
  disabled?: boolean
  minDate?: Date
  maxDate?: Date
  disabledDates?: (date: Date) => boolean
  /**
   * Date format string (date-fns format)
   * @default "PPP" (e.g., "April 29, 2024")
   */
  dateFormat?: string
}

export const DatePicker = React.forwardRef<HTMLButtonElement, DatePickerProps>(
  (
    {
      value,
      onChange,
      placeholder = 'Pick a date',
      className,
      disabled,
      minDate,
      maxDate,
      disabledDates,
      dateFormat = 'PPP',
      locale,
      ...buttonProps
    },
    ref
  ) => {
    const [open, setOpen] = React.useState(false)

    const isDateDisabled = (date: Date) => {
      if (disabledDates) {
        return disabledDates(date)
      }

      if (minDate && date < minDate) return true
      if (maxDate && date > maxDate) return true

      return false
    }

    const handleSelect = (date: Date | undefined) => {
      onChange?.(date)
      setOpen(false)
    }

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            ref={ref}
            type="button"
            variant="outline"
            disabled={disabled}
            className={cn(
              'w-full justify-start text-left font-normal',
              !value && 'text-muted-foreground',
              className
            )}
            aria-label={value ? format(value, 'MMMM d, yyyy', { locale }) : 'Select date'}
            aria-expanded={open}
            aria-haspopup="dialog"
            {...buttonProps}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {value ? format(value, dateFormat, { locale }) : placeholder}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start" aria-label={buttonProps['aria-label'] ?? placeholder}>
          <Calendar
            mode="single"
            selected={value}
            onSelect={handleSelect}
            defaultMonth={value || minDate}
            disabled={isDateDisabled}
            locale={locale}
            autoFocus
          />
        </PopoverContent>
      </Popover>
    )
  }
)

DatePicker.displayName = 'DatePicker'
