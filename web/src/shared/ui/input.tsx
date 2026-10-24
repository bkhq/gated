import type { LucideIcon } from 'lucide-react'
import type * as React from 'react'
import { cn } from '@/shared/lib/utils'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  icon?: LucideIcon
  suffix?: React.ReactNode
  wrapperClassName?: string
  ref?: React.Ref<HTMLInputElement>
}

export function Input({ className, icon: Icon, suffix, wrapperClassName, disabled, ref, ...props }: InputProps) {
  return (
    <div
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 transition',
        'has-[input:focus]:border-ring has-[input:focus]:shadow-[0_0_0_3px_hsl(var(--ring)/0.18)]',
        disabled && 'opacity-50',
        wrapperClassName,
      )}
    >
      {Icon ? <Icon size={15} className="shrink-0 text-muted-foreground" /> : null}
      <input
        ref={ref}
        disabled={disabled}
        className={cn(
          'min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground',
          'focus:outline-none focus-visible:outline-none focus:ring-0 disabled:cursor-not-allowed',
          className,
        )}
        {...props}
      />
      {suffix}
    </div>
  )
}
