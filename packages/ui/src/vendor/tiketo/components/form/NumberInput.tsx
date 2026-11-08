import * as React from 'react'
import { Minus, Plus } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

export interface NumberInputProps
  extends Omit<
    React.ComponentProps<'input'>,
    'type' | 'value' | 'onChange' | 'min' | 'max' | 'step'
  > {
  value?: number
  onValueChange: (value: number | undefined) => void
  min?: number
  max?: number
  step?: number | 'any'
  decreaseLabel?: string
  increaseLabel?: string
}

export function stepNumberValue(
  value: number | undefined,
  direction: -1 | 1,
  { min, max, step = 1 }: { min?: number; max?: number; step?: number } = {},
): number {
  const base = value ?? 0
  const raw = base + direction * step
  const precision = Math.max(
    (String(step).split('.')[1] ?? '').length,
    (String(base).split('.')[1] ?? '').length,
  )
  const rounded = Number(raw.toFixed(Math.min(precision, 12)))
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, rounded))
}

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  function NumberInput(
    {
      value,
      onValueChange,
      min,
      max,
      step = 1,
      disabled,
      decreaseLabel = 'Decrease',
      increaseLabel = 'Increase',
      className,
      ...props
    },
    ref,
  ) {
    const buttonStep = step === 'any' ? 1 : step
    const decreaseDisabled =
      disabled || (value !== undefined && min !== undefined && value <= min)
    const increaseDisabled =
      disabled || (value !== undefined && max !== undefined && value >= max)
    return (
      <div className={`flex w-full items-center gap-1 ${className ?? ''}`}>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={decreaseLabel}
          disabled={decreaseDisabled}
          onClick={() =>
            onValueChange(
              stepNumberValue(value, -1, { min, max, step: buttonStep }),
            )
          }>
          <Minus className="h-4 w-4" />
        </Button>
        <Input
          {...props}
          ref={ref}
          type="number"
          inputMode="decimal"
          value={value ?? ''}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) =>
            onValueChange(
              event.target.value === ''
                ? undefined
                : event.target.valueAsNumber,
            )
          }
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={increaseLabel}
          disabled={increaseDisabled}
          onClick={() =>
            onValueChange(
              stepNumberValue(value, 1, { min, max, step: buttonStep }),
            )
          }>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    )
  },
)
