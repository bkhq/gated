import type { TFunction } from 'i18next'
import type { DbQueryResponse } from '@/shared/lib/api/db-console'
import { AlertTriangle, Inbox } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/shared/components/empty-state'
import { Badge } from '@/shared/ui/badge'
import { Skeleton } from '@/shared/ui/skeleton'
import { TBody, TD, TH, THead, TR } from '@/shared/ui/table'

export interface ResultsGridProps {
  response: DbQueryResponse | null
  loading: boolean
  hasError: boolean
}

const KNOWN_STATEMENT_KINDS = new Set([
  'SELECT',
  'SHOW',
  'EXPLAIN',
  'DESCRIBE',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'OTHER',
  'UNKNOWN',
])

export function ResultsGrid({ response, loading, hasError }: ResultsGridProps) {
  const { t } = useTranslation()

  if (loading) {
    return (
      <div className="flex flex-col gap-2 p-4" role="status" aria-live="polite">
        <span className="sr-only">{t('sqlConsole.results.loading')}</span>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    )
  }

  if (hasError && !response) {
    return (
      <div className="p-4">
        <EmptyState
          icon={AlertTriangle}
          title={t('sqlConsole.results.error')}
          description={t('sqlConsole.results.errorHint')}
        />
      </div>
    )
  }

  if (!response) {
    return (
      <div className="p-4">
        <EmptyState
          icon={Inbox}
          title={t('sqlConsole.results.idle')}
          description={t('sqlConsole.results.idleHint')}
        />
      </div>
    )
  }

  const { columns, rows, rows_affected, elapsed_ms, statement_kind, truncated, limit } = response

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-[12px] text-muted-foreground">
        <Badge tone="info">{statementKindLabel(t, statement_kind)}</Badge>
        <span>{t('sqlConsole.results.elapsed', { ms: elapsed_ms })}</span>
        {rows_affected !== undefined
          ? <span>{t('sqlConsole.results.rowsAffected', { count: rows_affected })}</span>
          : <span>{t('sqlConsole.results.rowsReturned', { count: rows.length })}</span>}
        <span className="ml-auto text-[11px]">{t('sqlConsole.results.limit', { limit })}</span>
      </div>
      {truncated
        ? (
            <div
              role="alert"
              className="flex items-center gap-2 border-b border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.14)] px-3 py-2 text-[12px] text-[hsl(var(--warning))]"
            >
              <AlertTriangle size={13} />
              <span>{t('sqlConsole.results.truncated', { limit })}</span>
            </div>
          )
        : null}
      {rows.length === 0
        ? (
            <div className="p-4">
              <EmptyState
                icon={Inbox}
                title={t('sqlConsole.results.empty')}
                description={statement_kind === 'SELECT' || statement_kind === 'SHOW'
                  ? t('sqlConsole.results.emptyHintSelect')
                  : t('sqlConsole.results.emptyHintNonSelect')}
              />
            </div>
          )
        : (
            <div className="overflow-auto">
              <table className="w-full border-collapse text-sm">
                <THead>
                  <TR>
                    {columns.map(col => (
                      <TH key={col.name} className="pl-3" title={col.type_name}>
                        <span className="mono text-[11.5px] font-semibold text-foreground">{col.name}</span>
                        <span className="ml-1.5 text-[10px] uppercase text-muted-foreground">{col.type_name}</span>
                      </TH>
                    ))}
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row, index) => (
                    <TR key={rowKey(row, index)}>
                      {columns.map((col, colIndex) => (
                        <TD key={col.name} className="mono whitespace-pre text-[12.5px]">
                          {renderCell(row[colIndex], t)}
                        </TD>
                      ))}
                    </TR>
                  ))}
                </TBody>
              </table>
            </div>
          )}
    </div>
  )
}

// React reorders DOM by key, so using array index causes incorrect reuse when
// the result set shifts. Compose a key from the raw row values so identical
// rows still get distinct keys via the trailing index.
function rowKey(row: unknown[], index: number): string {
  const head: string[] = []
  for (let i = 0; i < row.length && head.join('|').length < 64; i++)
    head.push(stringifyScalar(row[i]))
  return `${head.join('|')}#${index}`
}

function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined)
    return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value)
  return ''
}

function renderCell(value: unknown, t: TFunction): React.ReactNode {
  if (value === null || value === undefined)
    return <span className="text-muted-foreground">{t('sqlConsole.results.null')}</span>
  if (typeof value === 'string')
    return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value)
  try {
    return JSON.stringify(value)
  }
  catch {
    return String(value)
  }
}

function statementKindLabel(t: TFunction, kind: string): string {
  const upper = kind.toUpperCase()
  if (KNOWN_STATEMENT_KINDS.has(upper))
    return t(`sqlConsole.results.kind.${upper}`)
  return kind
}
