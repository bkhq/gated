import type { TFunction } from 'i18next'
import type { DbKind, DbSchemaList } from '@/shared/lib/api/db-console'
import { ChevronDown, ChevronRight, Database, Eye, KeyRound, Table as TableIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDbColumns, useDbSchemas, useDbTables } from '@/features/sql-console/hooks/use-db-console-queries'
import { asDbKind } from '@/shared/lib/api/db-console'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Skeleton } from '@/shared/ui/skeleton'

export interface SchemaTreeProps {
  target: string
  readonly?: boolean
  selectedSchema?: string
  selectedTable?: string
  onSelectTable: (schema: string, table: string) => void
  onMetaLoaded?: (meta: { defaultSchema: string | undefined, kind: DbKind | null, readonly: boolean }) => void
}

export function SchemaTree({
  target,
  readonly,
  selectedSchema,
  selectedTable,
  onSelectTable,
  onMetaLoaded,
}: SchemaTreeProps) {
  const { t } = useTranslation()
  const schemasQuery = useDbSchemas(target)
  const data = schemasQuery.data

  useEffect(() => {
    if (!data || !onMetaLoaded)
      return
    onMetaLoaded({ defaultSchema: data.default_schema ?? undefined, kind: asDbKind(data.kind), readonly: data.readonly })
  }, [data, onMetaLoaded])

  if (schemasQuery.isError) {
    return (
      <SchemaTreeError
        title={t('sqlConsole.schemaTree.error.title')}
        retry={t('sqlConsole.schemaTree.error.retry')}
        onRetry={() => { void schemasQuery.refetch() }}
      />
    )
  }

  if (schemasQuery.isLoading || !data)
    return <SchemaTreeLoading label={t('sqlConsole.schemaTree.loading')} />

  if (data.schemas.length === 0) {
    return (
      <div className="flex flex-col gap-1 px-3 py-6 text-center text-[12px] text-muted-foreground">
        <div className="text-[13px] font-medium text-foreground">{t('sqlConsole.schemaTree.empty.title')}</div>
        <div>{t('sqlConsole.schemaTree.empty.description')}</div>
      </div>
    )
  }

  return (
    <SchemaTreeBody
      data={data}
      target={target}
      readonly={readonly}
      selectedSchema={selectedSchema}
      selectedTable={selectedTable}
      onSelectTable={onSelectTable}
    />
  )
}

function SchemaTreeBody({
  data,
  target,
  readonly,
  selectedSchema,
  selectedTable,
  onSelectTable,
}: {
  data: DbSchemaList
  target: string
  readonly?: boolean
  selectedSchema?: string
  selectedTable?: string
  onSelectTable: (schema: string, table: string) => void
}) {
  const { t } = useTranslation()
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(() => {
    return data.default_schema ? new Set([data.default_schema]) : new Set()
  })

  const toggle = (name: string) => {
    setExpandedSchemas((prev) => {
      const next = new Set(prev)
      if (next.has(name))
        next.delete(name)
      else
        next.add(name)
      return next
    })
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <Database size={14} className="text-muted-foreground" />
        <div className="flex-1 text-[12px] font-semibold text-foreground">{t('sqlConsole.schemaTree.title')}</div>
        <Badge tone="mono">{kindLabel(t, data.kind)}</Badge>
        {readonly
          ? (
              <Badge tone="warning" aria-label={t('sqlConsole.readonly')}>
                <Eye size={10} />
                <span>{t('sqlConsole.readonly')}</span>
              </Badge>
            )
          : null}
      </div>
      <ul className="flex flex-col py-1" role="tree" aria-label={t('sqlConsole.schemaTree.title')}>
        {data.schemas.map((schema) => {
          const open = expandedSchemas.has(schema)
          return (
            <li key={schema} role="treeitem" aria-expanded={open}>
              <button
                type="button"
                onClick={() => toggle(schema)}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[13px] text-foreground transition hover:bg-accent"
              >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span className="truncate font-medium">{schema}</span>
                {data.default_schema === schema
                  ? <span className="ml-auto text-[10px] uppercase text-muted-foreground">{t('sqlConsole.schemaTree.default')}</span>
                  : null}
              </button>
              {open
                ? (
                    <SchemaTables
                      target={target}
                      schema={schema}
                      selectedSchema={selectedSchema}
                      selectedTable={selectedTable}
                      onSelectTable={onSelectTable}
                    />
                  )
                : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function SchemaTables({
  target,
  schema,
  selectedSchema,
  selectedTable,
  onSelectTable,
}: {
  target: string
  schema: string
  selectedSchema?: string
  selectedTable?: string
  onSelectTable: (schema: string, table: string) => void
}) {
  const { t } = useTranslation()
  const tablesQuery = useDbTables(target, schema)
  const [expandedTables, setExpandedTables] = useState<Set<string>>(() => new Set())

  if (tablesQuery.isError) {
    return (
      <div className="flex items-center gap-2 px-7 py-2 text-[12px] text-[hsl(var(--destructive))]">
        <span>{t('sqlConsole.schemaTree.tables.error')}</span>
        <Button variant="link" size="sm" onClick={() => { void tablesQuery.refetch() }}>
          {t('sqlConsole.schemaTree.error.retry')}
        </Button>
      </div>
    )
  }

  if (tablesQuery.isLoading || !tablesQuery.data) {
    return (
      <div className="flex flex-col gap-1 px-7 py-1.5">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3.5 w-24" />
      </div>
    )
  }

  if (tablesQuery.data.tables.length === 0)
    return <div className="px-7 py-2 text-[12px] text-muted-foreground">{t('sqlConsole.schemaTree.tables.empty')}</div>

  const toggle = (name: string) => {
    setExpandedTables((prev) => {
      const next = new Set(prev)
      if (next.has(name))
        next.delete(name)
      else
        next.add(name)
      return next
    })
  }

  return (
    <ul className="flex flex-col" role="group">
      {tablesQuery.data.tables.map((table) => {
        const open = expandedTables.has(table.name)
        const selected = selectedSchema === schema && selectedTable === table.name
        return (
          <li key={table.name} role="treeitem" aria-selected={selected} aria-expanded={open}>
            <div className={cn(
              'flex w-full items-center gap-1 pl-7 pr-2',
              selected && 'bg-[hsl(var(--accent)/0.55)]',
            )}
            >
              <button
                type="button"
                aria-label={open ? t('sqlConsole.schemaTree.collapseTable', { table: table.name }) : t('sqlConsole.schemaTree.expandTable', { table: table.name })}
                onClick={() => toggle(table.name)}
                className="flex h-6 w-4 items-center justify-center text-muted-foreground transition hover:text-foreground"
              >
                {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              </button>
              <button
                type="button"
                onClick={() => onSelectTable(schema, table.name)}
                className={cn(
                  'flex flex-1 items-center gap-1.5 py-1.5 text-left text-[12.5px] transition hover:text-foreground',
                  selected ? 'font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                <TableIcon size={11} className="shrink-0" />
                <span className="truncate">{table.name}</span>
                <span className="ml-auto text-[10px] uppercase">{tableTypeLabel(t, table.type)}</span>
              </button>
            </div>
            {open ? <SchemaColumns target={target} schema={schema} table={table.name} /> : null}
          </li>
        )
      })}
    </ul>
  )
}

function SchemaColumns({ target, schema, table }: { target: string, schema: string, table: string }) {
  const { t } = useTranslation()
  const columnsQuery = useDbColumns(target, schema, table)

  if (columnsQuery.isError) {
    return (
      <div className="flex items-center gap-2 px-11 py-1.5 text-[11.5px] text-[hsl(var(--destructive))]">
        <span>{t('sqlConsole.schemaTree.columns.error')}</span>
        <Button variant="link" size="sm" onClick={() => { void columnsQuery.refetch() }}>
          {t('sqlConsole.schemaTree.error.retry')}
        </Button>
      </div>
    )
  }

  if (columnsQuery.isLoading || !columnsQuery.data) {
    return (
      <div className="flex flex-col gap-1 px-11 py-1">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-28" />
      </div>
    )
  }

  if (columnsQuery.data.columns.length === 0)
    return <div className="px-11 py-1 text-[11.5px] text-muted-foreground">{t('sqlConsole.schemaTree.columns.empty')}</div>

  return (
    <ul className="flex flex-col py-1" role="group">
      {columnsQuery.data.columns.map(col => (
        <li
          key={col.name}
          className="flex items-center gap-1.5 px-11 py-0.5 text-[11.5px] text-muted-foreground"
        >
          {col.primary_key
            ? <KeyRound size={10} className="shrink-0 text-[hsl(var(--warning))]" aria-label={t('sqlConsole.schemaTree.columns.primaryKey')} />
            : <span className="inline-block h-2.5 w-2.5 shrink-0" aria-hidden="true" />}
          <span className="mono truncate text-foreground">{col.name}</span>
          <span className="mono ml-auto whitespace-nowrap text-[10.5px]">{col.data_type}</span>
          {col.nullable
            ? null
            : <span className="text-[9.5px] uppercase text-muted-foreground" title={t('sqlConsole.schemaTree.columns.notNull')}>NN</span>}
        </li>
      ))}
    </ul>
  )
}

function SchemaTreeLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-2 px-3 py-3" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-4 w-28" />
    </div>
  )
}

function SchemaTreeError({ title, retry, onRetry }: { title: string, retry: string, onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 px-3 py-4 text-[12.5px] text-[hsl(var(--destructive))]">
      <div className="font-medium">{title}</div>
      <Button variant="outline" size="sm" onClick={onRetry}>{retry}</Button>
    </div>
  )
}

function kindLabel(t: TFunction, kind: string): string {
  if (kind === 'MySql')
    return t('sqlConsole.kind.mysql')
  if (kind === 'Postgres')
    return t('sqlConsole.kind.postgres')
  return kind
}

function tableTypeLabel(t: TFunction, type: string): string {
  const lower = type.toLowerCase()
  if (lower.includes('view'))
    return t('sqlConsole.schemaTree.tableType.view')
  return t('sqlConsole.schemaTree.tableType.table')
}
