import type { LucideIcon } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { Card } from '@/shared/ui/card'

export type StatTone = 'default' | 'info' | 'success' | 'warning'

const toneRing: Record<StatTone, string> = {
  default: '',
  info: 'border-[hsl(var(--info)/0.3)] bg-[hsl(var(--info)/0.04)]',
  success: 'border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.04)]',
  warning: 'border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.04)]',
}

const toneIcon: Record<StatTone, string> = {
  default: 'text-muted-foreground',
  info: 'text-[hsl(var(--info))]',
  success: 'text-[hsl(var(--success))]',
  warning: 'text-[hsl(var(--warning))]',
}

export function StatCard({ label, value, hint, icon: Icon, tone = 'default', onClick, ariaLabel }: {
  label: string
  value: string | number
  hint?: string
  icon?: LucideIcon
  tone?: StatTone
  onClick?: () => void
  ariaLabel?: string
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="text-[12px] font-medium text-muted-foreground">{label}</div>
        {Icon && <Icon size={15} className={cn(toneIcon[tone])} aria-hidden="true" />}
      </div>
      <div className="tabular mt-2 text-[24px] font-semibold tracking-normal">{value}</div>
      {hint && <div className="mt-1 text-[12px] text-muted-foreground">{hint}</div>}
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        className={cn(
          'focus-ring min-w-0 cursor-pointer rounded-lg border border-border bg-card p-5 text-left text-card-foreground transition-colors duration-100 ease-out hover:border-[hsl(var(--accent-foreground)/0.2)] hover:bg-accent/40',
          toneRing[tone],
        )}
      >
        {body}
      </button>
    )
  }

  return (
    <Card className={cn('min-w-0 p-5', toneRing[tone])}>
      {body}
    </Card>
  )
}
