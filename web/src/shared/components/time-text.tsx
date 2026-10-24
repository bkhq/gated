import { useTranslation } from 'react-i18next'
import { formatDateTime, formatFullDateTime, formatRelativeTime } from '@/shared/lib/format-time'
import { cn } from '@/shared/lib/utils'

export function TimeText({ iso, mode = 'absolute', className }: {
  iso: string
  mode?: 'absolute' | 'relative'
  className?: string
}) {
  const { i18n } = useTranslation()
  const locale = i18n.language
  const text = mode === 'relative' ? formatRelativeTime(iso, locale) : formatDateTime(iso, locale)
  return (
    <time dateTime={iso} title={formatFullDateTime(iso, locale)} className={cn('tabular-nums', className)}>
      {text}
    </time>
  )
}
