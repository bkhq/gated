import type { HttpProxyRecordingItem } from '@/shared/lib/api/recordings'
import type { BadgeTone } from '@/shared/ui/badge'
import { AlertTriangle, ChevronDown, ChevronRight, Inbox } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/shared/components/empty-state'
import { Badge } from '@/shared/ui/badge'
import { Skeleton } from '@/shared/ui/skeleton'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'
import { useHttpProxyRecording } from '../hooks/use-recording-queries'

export interface HttpProxyPlayerProps {
  recordingId: string
}

function statusTone(status: number | null | undefined): BadgeTone {
  if (typeof status !== 'number') {
    return 'mono'
  }
  if (status >= 500) {
    return 'danger'
  }
  if (status >= 400) {
    return 'warning'
  }
  if (status >= 300) {
    return 'info'
  }
  if (status >= 200) {
    return 'success'
  }
  return 'mono'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatBody(body: unknown): string | null {
  if (body === null || body === undefined) {
    return null
  }
  if (typeof body === 'string') {
    return body
  }
  if (Array.isArray(body) || isPlainObject(body)) {
    try {
      return JSON.stringify(body, null, 2)
    }
    catch {
      return String(body)
    }
  }
  return String(body)
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    return iso
  }
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function HttpProxyPlayer({ recordingId }: HttpProxyPlayerProps) {
  const { t } = useTranslation()
  const query = useHttpProxyRecording(recordingId, true)
  const [expanded, setExpanded] = React.useState<Set<number>>(() => new Set())

  const toggle = React.useCallback((index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      }
      else {
        next.add(index)
      }
      return next
    })
  }, [])

  if (query.isLoading) {
    return (
      <div role="status" aria-busy="true" aria-live="polite" className="space-y-2">
        <span className="sr-only">{t('recordings.httpProxy.title')}</span>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    )
  }

  if (query.isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title={t('recordings.httpProxy.title')}
        description={query.error instanceof Error ? query.error.message : String(query.error)}
      />
    )
  }

  const items: HttpProxyRecordingItem[] = query.data ?? []

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title={t('recordings.httpProxy.title')}
        description={t('recordings.httpProxy.empty')}
      />
    )
  }

  return (
    <Table aria-label={t('recordings.httpProxy.title')}>
      <THead>
        <TR>
          <TH className="w-10" aria-hidden="true" />
          <TH>{t('recordings.httpProxy.headers.timestamp')}</TH>
          <TH>{t('recordings.httpProxy.headers.method')}</TH>
          <TH>{t('recordings.httpProxy.headers.path')}</TH>
          <TH>{t('recordings.httpProxy.headers.status')}</TH>
        </TR>
      </THead>
      <TBody>
        {items.map((item, idx) => {
          const isOpen = expanded.has(idx)
          const reqBody = formatBody(item.request_body)
          const resBody = formatBody(item.response_body)
          const toggleLabel = isOpen
            ? t('recordings.httpProxy.collapse')
            : t('recordings.httpProxy.expand')
          const rowKey = `${idx}:${item.timestamp}:${item.request_method}:${item.request_path}`
          return (
            <React.Fragment key={rowKey}>
              <TR onClick={() => toggle(idx)} aria-expanded={isOpen}>
                <TD>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggle(idx)
                    }}
                    aria-label={toggleLabel}
                    className="flex items-center justify-center rounded-md p-1 text-muted-foreground hover:text-foreground"
                  >
                    {isOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                  </button>
                </TD>
                <TD className="whitespace-nowrap font-mono text-xs text-muted-foreground">{formatTimestamp(item.timestamp)}</TD>
                <TD className="font-mono text-xs">{item.request_method}</TD>
                <TD className="break-all font-mono text-xs">{item.request_path}</TD>
                <TD>
                  <Badge tone={statusTone(item.response_status)}>
                    {typeof item.response_status === 'number' ? item.response_status : '—'}
                  </Badge>
                </TD>
              </TR>
              {isOpen
                ? (
                    <tr className="border-b border-border bg-[hsl(var(--muted)/0.25)] last:border-b-0">
                      <td colSpan={5} className="px-3.5 py-3">
                        <div className="grid gap-3">
                          <BodyBlock
                            label={t('recordings.httpProxy.requestBody')}
                            body={reqBody}
                            emptyLabel={t('recordings.httpProxy.bodyNone')}
                          />
                          <BodyBlock
                            label={t('recordings.httpProxy.responseBody')}
                            body={resBody}
                            emptyLabel={t('recordings.httpProxy.bodyNone')}
                          />
                        </div>
                      </td>
                    </tr>
                  )
                : null}
            </React.Fragment>
          )
        })}
      </TBody>
    </Table>
  )
}

function BodyBlock({ label, body, emptyLabel }: { label: string, body: string | null, emptyLabel: string }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      {body === null
        ? <div className="text-[13px] text-muted-foreground">{emptyLabel}</div>
        : (
            <pre className="overflow-auto rounded-md border border-border bg-[hsl(var(--muted)/0.4)] px-2.5 py-2 text-[12px] leading-relaxed">
              {body}
            </pre>
          )}
    </div>
  )
}
