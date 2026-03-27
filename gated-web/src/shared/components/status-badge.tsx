import { Badge } from '@/shared/components/ui/badge'
import { cn } from '@/shared/lib/utils'

type StatusVariant = 'active' | 'inactive' | 'enabled' | 'disabled' | 'success' | 'warning' | 'error' | 'pending' | 'default'

interface StatusBadgeProps {
  status: StatusVariant | string
  label?: string
  className?: string
}

const statusConfig: Record<string, { label: string, className: string, dot: string }> = {
  active: {
    label: 'Active',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800',
    dot: 'bg-emerald-500',
  },
  inactive: {
    label: 'Inactive',
    className: 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-900 dark:text-gray-400 dark:border-gray-700',
    dot: 'bg-gray-400',
  },
  enabled: {
    label: 'Enabled',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800',
    dot: 'bg-emerald-500',
  },
  disabled: {
    label: 'Disabled',
    className: 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-900 dark:text-gray-400 dark:border-gray-700',
    dot: 'bg-gray-400',
  },
  success: {
    label: 'Success',
    className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800',
    dot: 'bg-emerald-500',
  },
  warning: {
    label: 'Warning',
    className: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800',
    dot: 'bg-amber-500',
  },
  error: {
    label: 'Error',
    className: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800',
    dot: 'bg-red-500',
  },
  pending: {
    label: 'Pending',
    className: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800',
    dot: 'bg-blue-500 animate-pulse',
  },
  default: {
    label: 'Unknown',
    className: 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-900 dark:text-gray-400 dark:border-gray-700',
    dot: 'bg-gray-400',
  },
}

export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig.default!
  const displayLabel = label ?? config.label ?? status

  return (
    <Badge variant="outline" className={cn('gap-1.5 font-medium', config.className, className)}>
      <span className={cn('size-1.5 rounded-full shrink-0', config.dot)} />
      {displayLabel}
    </Badge>
  )
}
