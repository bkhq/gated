import * as React from 'react'
import { cn } from '@/shared/lib/utils'

export type BadgeTone = 'neutral' | 'outline' | 'success' | 'warning' | 'danger' | 'info' | 'mono'

const toneClass: Record<BadgeTone, string> = {
  neutral: 'bg-secondary text-secondary-foreground border-transparent',
  outline: 'bg-transparent text-foreground border-border',
  success: 'bg-[hsl(var(--success)/0.14)] text-[hsl(var(--success))] border-[hsl(var(--success)/0.3)]',
  warning: 'bg-[hsl(var(--warning)/0.14)] text-[hsl(var(--warning))] border-[hsl(var(--warning)/0.3)]',
  danger: 'bg-[hsl(var(--destructive)/0.14)] text-[hsl(var(--destructive))] border-[hsl(var(--destructive)/0.3)]',
  info: 'bg-[hsl(var(--info)/0.14)] text-[hsl(var(--info))] border-[hsl(var(--info)/0.3)]',
  mono: 'bg-muted text-muted-foreground border-transparent',
}

export function Badge({ tone = 'neutral', className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-1 text-[11px] font-medium leading-none', toneClass[tone], className)} {...props} />
}
