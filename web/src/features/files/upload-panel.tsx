import { Check, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import { formatSize } from './lib/paths'

export interface UploadItem {
  id: number
  name: string
  size: number
  loaded: number
  status: 'uploading' | 'done' | 'error' | 'canceled'
  error?: string
  controller: AbortController
}

/** Floating list of running and finished uploads. */
export function UploadPanel({ uploads, onClearFinished }: { uploads: UploadItem[], onClearFinished: () => void }) {
  const { t } = useTranslation()
  if (uploads.length === 0)
    return null
  return (
    <div role="status" aria-label={t('files.uploads.title')} className="absolute bottom-3 right-3 z-20 flex max-h-64 w-80 max-w-[calc(100%-1.5rem)] flex-col rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
      <div className="flex flex-none items-center justify-between border-b border-border py-1 pl-3 pr-1 text-[13px] font-medium">
        <span>{t('files.uploads.title')}</span>
        <Button variant="ghost" size="sm" onClick={onClearFinished}>{t('files.uploads.clear')}</Button>
      </div>
      <ul className="m-0 min-h-0 flex-1 list-none overflow-auto p-2 text-[12px]">
        {uploads.map(item => (
          <li key={item.id} className="flex items-center gap-2 py-1">
            <div className="min-w-0 flex-1">
              <div className="mono truncate" title={item.name}>{item.name}</div>
              {item.status === 'uploading'
                ? (
                    <>
                      <div className="mt-1 h-1 overflow-hidden rounded bg-muted">
                        <div className="h-full bg-[hsl(var(--primary))]" style={{ width: `${item.size ? (item.loaded / item.size) * 100 : 0}%` }} />
                      </div>
                      <div className="tabular mt-0.5 text-muted-foreground">{`${formatSize(item.loaded)} / ${formatSize(item.size)}`}</div>
                    </>
                  )
                : null}
              {item.status === 'error' ? <div className="truncate text-destructive" title={item.error}>{item.error}</div> : null}
              {item.status === 'canceled' ? <div className="text-muted-foreground">{t('files.uploads.canceled')}</div> : null}
            </div>
            {item.status === 'done' ? <Check size={15} className="shrink-0 text-[hsl(var(--success))]" aria-label={t('files.uploads.done')} /> : null}
            {item.status === 'uploading'
              ? (
                  <Button variant="ghost" size="icon-sm" aria-label={t('files.uploads.cancel', { name: item.name })} title={t('actions.cancel')} onClick={() => item.controller.abort()}>
                    <X size={14} />
                  </Button>
                )
              : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
