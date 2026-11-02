import type * as React from 'react'
import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox'
import { Check } from 'lucide-react'
import { cn } from '@/shared/lib/utils'

export interface CheckboxProps extends Omit<CheckboxPrimitive.Root.Props, 'render'> {
  label?: React.ReactNode
  className?: string
  boxClassName?: string
  ref?: React.Ref<HTMLButtonElement>
}

export function Checkbox({ className, boxClassName, label, ref, ...props }: CheckboxProps) {
  const root = (
    <CheckboxPrimitive.Root
      ref={ref}
      data-slot="checkbox"
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded border border-input bg-background outline-none transition-colors',
        'data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground',
        'data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-foreground',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]',
        boxClassName,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center"
      >
        <Check size={12} strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
  if (label === undefined) {
    return root
  }
  return (
    <label className={cn('inline-flex items-center gap-2 text-sm', className)}>
      {root}
      {label}
    </label>
  )
}
