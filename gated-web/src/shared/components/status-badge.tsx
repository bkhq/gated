import { Badge } from '@/shared/components/ui/badge'
import { cn } from '@/shared/lib/utils'

type StatusVariant = 'active' | 'inactive' | 'enabled' | 'disabled' | 'success' | 'warning' | 'error' | 'default'

interface StatusBadgeProps {
  status: StatusVariant | string
  label?: string
  className?: string
}

const statusConfig: Record<string, { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' },
  inactive: { label: 'Inactive', className: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200' },
  enabled: { label: 'Enabled', className: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' },
  disabled: { label: 'Disabled', className: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200' },
  success: { label: 'Success', className: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' },
  warning: { label: 'Warning', className: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200' },
  error: { label: 'Error', className: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200' },
  default: { label: 'Unknown', className: '' },
}

export function StatusBadge({ status, label, className }: StatusBadgeProps) {
  const config = statusConfig[status] ?? statusConfig['default']!
  const displayLabel = label ?? config.label ?? status

  return (
    <Badge variant="outline" className={cn('font-medium', config.className, className)}>
      {displayLabel}
    </Badge>
  )
}
