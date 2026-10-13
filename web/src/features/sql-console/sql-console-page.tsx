import type { SqlRowLimit } from '@/features/sql-console/components/sql-editor-constants'
import type { DbKind } from '@/shared/lib/api/db-console'
import type { ApiError } from '@/shared/lib/api/http'
import { Terminal } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConsoleErrorBanner } from '@/features/sql-console/components/console-error-banner'
import { ResultsGrid } from '@/features/sql-console/components/results-grid'
import { SchemaTree } from '@/features/sql-console/components/schema-tree'
import { SqlEditor } from '@/features/sql-console/components/sql-editor'
import { useRunDbQuery } from '@/features/sql-console/hooks/use-db-console-queries'
import { applyLimit, buildStarterSql } from '@/features/sql-console/lib/starter-sql'
import { Badge } from '@/shared/ui/badge'

export interface SqlConsolePageProps {
  targetName: string
}

export function SqlConsolePage({ targetName }: SqlConsolePageProps) {
  const { t } = useTranslation()

  const [sql, setSql] = useState('')
  const [limit, setLimit] = useState<SqlRowLimit>(1000)
  const [currentSchema, setCurrentSchema] = useState<string | undefined>(undefined)
  const [currentTable, setCurrentTable] = useState<string | undefined>(undefined)
  const [kind, setKind] = useState<DbKind | null>(null)
  const [readonly, setReadonly] = useState<boolean>(false)
  const [dismissedErrorRef, setDismissedErrorRef] = useState<ApiError | null>(null)

  // Stable session key for the entire mount. The backend uses it to group
  // related queries under a single SQL Console recording session.
  const [sessionKey] = useState(() => crypto.randomUUID())

  // Tracks the last starter `SELECT * FROM ...` we auto-inserted so we don't
  // clobber user edits but DO replace an unmodified starter when they pick
  // another table.
  const lastAutoInsertRef = useRef<string>('')

  const runMutation = useRunDbQuery(targetName)
  const bannerError = runMutation.error && runMutation.error !== dismissedErrorRef
    ? runMutation.error
    : null

  const handleMetaLoaded = useCallback((meta: { defaultSchema: string | undefined, kind: DbKind | null, readonly: boolean }) => {
    setKind(meta.kind)
    setReadonly(meta.readonly)
    setCurrentSchema(prev => prev ?? meta.defaultSchema)
  }, [])

  // Clicking a table (re)builds a `SELECT * FROM <table> LIMIT <n>` starter in
  // the editor so the query always reflects the table that was just picked.
  const handleSelectTable = useCallback((schema: string, table: string) => {
    setCurrentSchema(schema)
    setCurrentTable(table)
    const next = buildStarterSql(kind, schema, table, limit)
    lastAutoInsertRef.current = next
    setSql(next)
  }, [kind, limit])

  // Changing the row limit keeps the editor in sync: rewrite the LIMIT clause
  // of the current query (works for both the auto-generated starter and a
  // hand-edited query that still carries a LIMIT). Queries without a LIMIT are
  // left untouched.
  const handleLimitChange = useCallback((next: SqlRowLimit) => {
    setLimit(next)
    setSql((prev) => {
      const updated = applyLimit(prev, next)
      if (updated !== prev && prev === lastAutoInsertRef.current)
        lastAutoInsertRef.current = updated
      return updated
    })
  }, [])

  const handleRun = useCallback(() => {
    if (sql.trim().length === 0)
      return
    setDismissedErrorRef(null)
    runMutation.mutate({
      sql,
      limit,
      console_session_key: sessionKey,
    })
  }, [sql, limit, runMutation, sessionKey])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-3">
        <Terminal size={16} className="text-muted-foreground" />
        <div className="flex flex-col">
          <h1 className="m-0 text-[15px] font-semibold text-foreground">{t('sqlConsole.title')}</h1>
          <div className="text-[12px] text-muted-foreground">
            {t('sqlConsole.subtitle', { target: targetName })}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {readonly
            ? (
                <Badge tone="warning" aria-label={t('sqlConsole.readonly')}>
                  {t('sqlConsole.readonly')}
                </Badge>
              )
            : null}
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)]">
        <aside className="overflow-y-auto border-r border-border bg-card">
          <SchemaTree
            target={targetName}
            readonly={readonly}
            selectedSchema={currentSchema}
            selectedTable={currentTable}
            onSelectTable={handleSelectTable}
            onMetaLoaded={handleMetaLoaded}
          />
        </aside>
        <section className="flex min-h-0 flex-col">
          <div className="border-b border-border bg-background">
            <SqlEditor
              value={sql}
              onChange={setSql}
              limit={limit}
              onLimitChange={handleLimitChange}
              running={runMutation.isPending}
              onRun={handleRun}
            />
          </div>
          <ConsoleErrorBanner
            error={bannerError}
            targetReadonly={readonly}
            onDismiss={() => setDismissedErrorRef(runMutation.error ?? null)}
          />
          <div className="min-h-0 flex-1 overflow-auto">
            <ResultsGrid
              response={runMutation.data ?? null}
              loading={runMutation.isPending}
              hasError={!!runMutation.error}
            />
          </div>
        </section>
      </div>
    </div>
  )
}
