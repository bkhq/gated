import type * as React from 'react'
import { cn } from '@/shared/lib/utils'

export function Label({ className, ref, ...props }: React.LabelHTMLAttributes<HTMLLabelElement> & { ref?: React.Ref<HTMLLabelElement> }) {
  return (
    <label
      ref={ref}
      className={cn('mb-1.5 block text-[13px] font-medium text-foreground', className)}
      {...props}
    />
  )
}
