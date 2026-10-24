import type * as React from 'react'
import { Switch as SwitchPrimitive } from '@base-ui/react/switch'
import { cn } from '@/shared/lib/utils'

export interface SwitchProps extends Omit<SwitchPrimitive.Root.Props, 'render'> {
  className?: string
  ref?: React.Ref<HTMLButtonElement>
}

export function Switch({ className, ref, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      data-slot="switch"
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border outline-none transition-colors',
        'data-checked:bg-primary data-unchecked:bg-muted',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm transition-transform',
          'data-checked:translate-x-[18px] data-unchecked:translate-x-0.5',
        )}
      />
    </SwitchPrimitive.Root>
  )
}
