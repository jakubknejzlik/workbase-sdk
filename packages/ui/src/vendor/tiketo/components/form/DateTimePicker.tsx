import * as React from 'react'
import { CalendarIcon, Clock } from 'lucide-react'
import { format, type Locale } from 'date-fns'
import { Button } from '../ui/button'
import { Calendar } from '../ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Input } from '../ui/input'
import { cn } from '../../lib/utils'

export interface DateTimePickerProps extends Omit<React.ComponentProps<'button'>, 'value' | 'onChange'> {
  locale?: Locale
  timeLabel?: string

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
  /**
   * Time format string (date-fns format)
   * @default "HH:mm" (e.g., "14:30")
   */
  timeFormat?: string
  /**
   * Step for time input in seconds
   * @default 60 (1 minute)
   */
  timeStep?: number
}

export const DateTimePicker = React.forwardRef<HTMLButtonElement, DateTimePickerProps>(
  (
    {
      value,
      onChange,
      placeholder = 'Pick a date and time',
      className,
      disabled,
      minDate,
      maxDate,
      disabledDates,
      dateFormat = 'PPP',
      locale,
      timeFormat = 'HH:mm',
      timeStep = 60,
      timeLabel = 'Time',
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

    const handleDateSelect = (date: Date | undefined) => {
      if (!date) {
        onChange?.(undefined)
        return
      }

      // Preserve the time from the current value, or use current time
      const hours = value?.getHours() ?? new Date().getHours()
      const minutes = value?.getMinutes() ?? new Date().getMinutes()

      const newDate = new Date(date)
      newDate.setHours(hours, minutes, 0, 0)
      onChange?.(newDate)
    }

    const handleTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const timeValue = e.target.value
      if (!timeValue) return

      const [hours, minutes] = timeValue.split(':').map(Number)

      // Use current value's date or today
      const baseDate = value ? new Date(value) : new Date()
      baseDate.setHours(hours, minutes, 0, 0)
      onChange?.(baseDate)
    }

    const timeValue = value
      ? `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`
      : ''

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
            aria-label={
              value
                ? `${format(value, 'MMMM d, yyyy', { locale })} at ${format(value, timeFormat, { locale })}`
                : 'Select date and time'
            }
            aria-expanded={open}
            aria-haspopup="dialog"
            {...buttonProps}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {value ? (
              <>
                {format(value, dateFormat, { locale })} {format(value, timeFormat, { locale })}
              </>
            ) : (
              placeholder
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start" aria-label={buttonProps['aria-label'] ?? placeholder}>
          <Calendar
            mode="single"
            selected={value}
            onSelect={handleDateSelect}
            defaultMonth={value || minDate}
            disabled={isDateDisabled}
            locale={locale}
            autoFocus
          />
          <div className="border-t p-3">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <Input
                type="time"
                aria-label={timeLabel}
                value={timeValue}
                onChange={handleTimeChange}
                step={timeStep}
                className="w-auto"
                disabled={disabled}
              />
            </div>
          </div>
        </PopoverContent>
      </Popover>
    )
  }
)

DateTimePicker.displayName = 'DateTimePicker'
