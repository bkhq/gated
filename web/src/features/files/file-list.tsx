import type { Selection, SelectMode, SortKey, SortState } from './lib/entries'
import type { SftpEntry } from '@/shared/lib/api/sftp'
import { ArrowDown, ArrowUp } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/shared/lib/utils'
import { Skeleton } from '@/shared/ui/skeleton'
import { EntryIcon } from './entry-icon'
import { formatMode, formatMtime, formatSize } from './lib/paths'

const SIZE_COLUMN = 'w-24 shrink-0 text-right'
const MODIFIED_COLUMN = 'hidden w-40 shrink-0 @2xl:block'
const MODE_COLUMN = 'hidden w-28 shrink-0 @3xl:block'

function SortableHeader({ column, label, sort, onSort, className }: {
  column: SortKey
  label: string
  sort: SortState
  onSort: (key: SortKey) => void
  className: string
}) {
  const active = sort.key === column
  const Arrow = sort.order === 'asc' ? ArrowUp : ArrowDown
  return (
    <span
      role="columnheader"
      aria-sort={active ? (sort.order === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={className}
    >
      <button type="button" className={cn('focus-ring inline-flex items-center gap-1 rounded hover:text-foreground', active && 'text-foreground')} onClick={() => onSort(column)}>
        {label}
        {active ? <Arrow size={11} aria-hidden="true" /> : null}
      </button>
    </span>
  )
}

export interface FileListProps {
  entries: SftpEntry[]
  loading: boolean
  empty: React.ReactNode
  selection: Selection
  sort: SortState
  onSort: (key: SortKey) => void
  onSelect: (name: string, mode: SelectMode) => void
  onClearSelection: () => void
  onOpen: (entry: SftpEntry) => void
  /** Right click on a row, before the context menu opens. */
  onEntryContextMenu: (entry: SftpEntry) => void
  onKeyDown: (event: React.KeyboardEvent) => void
}

export function FileList({ entries, loading, empty, selection, sort, onSort, onSelect, onClearSelection, onOpen, onEntryContextMenu, onKeyDown }: FileListProps) {
  const { t } = useTranslation()
  const anchorRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    anchorRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selection.anchor])

  return (
    <div
      role="grid"
      aria-multiselectable="true"
      tabIndex={0}
      className="focus-ring flex min-h-0 flex-1 flex-col overflow-auto outline-none"
      onClick={onClearSelection}
      onKeyDown={(event) => {
        // Focus inside the grid is on a header button, which handles its own keys.
        if (event.target === event.currentTarget)
          onKeyDown(event)
      }}
    >
      <div role="row" className="sticky top-0 z-10 flex h-8 flex-none items-center gap-3 border-b border-border bg-card px-3 text-[12px] font-medium text-muted-foreground" onClick={event => event.stopPropagation()}>
        <SortableHeader column="name" label={t('fields.name')} sort={sort} onSort={onSort} className="min-w-0 flex-1 pl-6" />
        <SortableHeader column="size" label={t('files.fields.size')} sort={sort} onSort={onSort} className={SIZE_COLUMN} />
        <SortableHeader column="mtime" label={t('files.fields.modified')} sort={sort} onSort={onSort} className={MODIFIED_COLUMN} />
        <span role="columnheader" className={MODE_COLUMN}>{t('files.fields.permissions')}</span>
      </div>
      {loading
        ? Array.from({ length: 6 }, (_, index) => (
            <div key={`files-skeleton-${String(index)}`} className="flex h-9 flex-none items-center px-3">
              <Skeleton className="h-3.5 w-48" />
            </div>
          ))
        : entries.length === 0
          ? empty
          : (
              <div className="p-1">
                {entries.map((entry) => {
                  const selected = selection.names.has(entry.name)
                  return (
                    <div
                      key={entry.name}
                      ref={entry.name === selection.anchor ? anchorRef : undefined}
                      role="row"
                      data-name={entry.name}
                      aria-selected={selected}
                      className={cn(
                        'flex h-9 cursor-default select-none items-center gap-3 rounded-md px-2 text-[13px] hover:bg-accent/60',
                        selected && 'bg-accent text-accent-foreground hover:bg-accent',
                      )}
                      onClick={(event) => {
                        event.stopPropagation()
                        // Touch has no double click: a tap opens.
                        if ((event.nativeEvent as PointerEvent).pointerType === 'touch')
                          onOpen(entry)
                        else
                          onSelect(entry.name, event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'single')
                      }}
                      onDoubleClick={() => onOpen(entry)}
                      onContextMenu={() => onEntryContextMenu(entry)}
                    >
                      <span role="gridcell" className="flex min-w-0 flex-1 items-center gap-2">
                        <EntryIcon entry={entry} />
                        <span className="mono truncate" title={entry.name}>{entry.name}</span>
                      </span>
                      <span role="gridcell" className={cn(SIZE_COLUMN, 'mono tabular text-[12px] text-muted-foreground')}>
                        {entry.kind === 'dir' ? '—' : formatSize(entry.size)}
                      </span>
                      <span role="gridcell" className={cn(MODIFIED_COLUMN, 'mono tabular text-[12px] text-muted-foreground')}>{formatMtime(entry.mtime)}</span>
                      <span role="gridcell" className={cn(MODE_COLUMN, 'mono text-[12px] text-muted-foreground')}>{formatMode(entry.permissions, entry.kind)}</span>
                    </div>
                  )
                })}
              </div>
            )}
    </div>
  )
}
