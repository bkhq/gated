import type { LucideIcon } from 'lucide-react'
import { Info } from 'lucide-react'
import * as React from 'react'

export function EmptyState({ icon: Icon = Info, title, description, action }: {
  icon?: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center gap-2.5 rounded-lg border border-dashed border-border px-6 py-12 text-center text-muted-foreground"
    >
      <div aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-foreground">
        <Icon size={18} />
      </div>
      <div className="text-sm font-semibold text-foreground">{title}</div>
      {description && <div className="max-w-sm text-[13px]">{description}</div>}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}
