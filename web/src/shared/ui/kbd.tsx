import * as React from 'react'
import { cn } from '@/shared/lib/utils'

export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return <kbd className={cn('mono inline-block rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground', className)} {...props} />
}
