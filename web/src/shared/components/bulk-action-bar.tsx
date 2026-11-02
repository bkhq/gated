import type * as React from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'

export interface BulkActionBarProps {
  'selectedCount': number
  'onClear': () => void
  'children': React.ReactNode
  'className'?: string
  'aria-label'?: string
}

// Stable-layout selection toolbar. Sits between the filter row and the table so
// the table's top edge never moves when no rows are selected (max-height: 0).
// When the count flips to >0, the bar expands smoothly to reveal the actions
// without yanking other elements.
export function BulkActionBar({
  selectedCount,
  onClear,
  children,
  className,
  'aria-label': ariaLabel,
}: BulkActionBarProps) {
  const { t } = useTranslation()
  const open = selectedCount > 0
  return (
    <div
      className={cn(
        'overflow-hidden transition-[max-height,opacity] duration-150 ease-out',
        open ? 'max-h-20 opacity-100' : 'pointer-events-none max-h-0 opacity-0',
        className,
      )}
      aria-hidden={!open}
    >
      <div className="px-6 pb-2 pt-1">
        <div
          className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2.5 py-1.5"
          role="region"
          aria-label={ariaLabel ?? t('common.bulkActions')}
        >
          <span className="text-[12.5px] font-medium">
            {t('common.selectedCount', { count: selectedCount })}
          </span>
          <span className="h-4 w-px bg-border" aria-hidden="true" />
          <div className="flex flex-1 items-center gap-2">{children}</div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClear}
            aria-label={t('common.clearSelection')}
          >
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  )
}
