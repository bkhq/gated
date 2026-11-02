import type * as React from 'react'
import { cn } from '@/shared/lib/utils'

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  wrapperClassName?: string
  ref?: React.Ref<HTMLTextAreaElement>
}

export function Textarea({ className, rows = 4, wrapperClassName, disabled, ref, ...props }: TextareaProps) {
  return (
    <div
      className={cn(
        'flex w-full rounded-md border border-input bg-background px-3 py-2.5 transition',
        'has-[textarea:focus]:border-ring has-[textarea:focus]:shadow-[0_0_0_3px_hsl(var(--ring)/0.18)]',
        disabled && 'opacity-50',
        wrapperClassName,
      )}
    >
      <textarea
        ref={ref}
        rows={rows}
        disabled={disabled}
        className={cn(
          'min-w-0 flex-1 resize-y bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground',
          'focus:outline-none focus-visible:outline-none focus:ring-0 disabled:cursor-not-allowed',
          className,
        )}
        {...props}
      />
    </div>
  )
}
