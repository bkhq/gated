import { cn } from '@/shared/lib/utils'

interface PageHeaderProps {
  title: React.ReactNode
  description?: string
  actions?: React.ReactNode
  className?: string
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-4 mb-4', className)}>
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description != null && description !== '' && (
          <p className="text-muted-foreground mt-1">{description}</p>
        )}
      </div>
      {actions != null && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}
