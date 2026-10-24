import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'

interface PagerProps {
  offset: number
  pageSize: number
  total: number
  onOffsetChange: (offset: number) => void
  className?: string
}

/** Range label with Previous/Next; renders nothing when everything fits on one page. */
export function Pager({ offset, pageSize, total, onOffsetChange, className }: PagerProps) {
  const { t } = useTranslation()
  if (total <= pageSize) {
    return null
  }
  return (
    <div className={className ?? 'flex items-center justify-between gap-2 pt-3'}>
      <span className="tabular text-[12.5px] text-muted-foreground">
        {t('pagination.range', { from: offset + 1, to: Math.min(offset + pageSize, total), total })}
      </span>
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          disabled={offset === 0}
          onClick={() => onOffsetChange(Math.max(0, offset - pageSize))}
        >
          <ChevronLeft size={13} />
          <span>{t('pagination.prev')}</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={offset + pageSize >= total}
          onClick={() => onOffsetChange(offset + pageSize)}
        >
          <span>{t('pagination.next')}</span>
          <ChevronRight size={13} />
        </Button>
      </div>
    </div>
  )
}
