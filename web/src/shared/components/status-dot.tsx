import { cn } from '@/shared/lib/utils'

export function StatusDot({ tone = 'success', pulse = false, label }: {
  tone?: 'success' | 'warning' | 'danger' | 'info' | 'muted'
  pulse?: boolean
  label?: string
}) {
  const color = {
    success: 'bg-[hsl(var(--success))]',
    warning: 'bg-[hsl(var(--warning))]',
    danger: 'bg-[hsl(var(--destructive))]',
    info: 'bg-[hsl(var(--info))]',
    muted: 'bg-muted-foreground',
  }[tone]

  return (
    <>
      <span aria-hidden="true" className={cn('inline-block h-2 w-2 shrink-0 rounded-full', color, pulse && 'pulse-dot')} />
      {label ? <span className="sr-only">{label}</span> : null}
    </>
  )
}
