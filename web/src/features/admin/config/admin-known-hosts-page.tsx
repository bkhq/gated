import type { SortDir } from '@/shared/components/sort'
import type { KnownHost } from '@/shared/types/domain'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Fingerprint,
  Search,
  ServerOff,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  useDeleteKnownHost,
  useDeleteKnownHostsBatch,
  useKnownHosts,
} from '@/features/known-hosts/hooks/use-known-hosts-queries'
import { BulkActionBar } from '@/shared/components/bulk-action-bar'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { ariaSort } from '@/shared/components/sort'
import { SortHeader } from '@/shared/components/sort-header'
import { StatCard } from '@/shared/components/stat-card'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { Checkbox } from '@/shared/ui/checkbox'
import { Dialog } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Skeleton } from '@/shared/ui/skeleton'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

type SortKey = 'host' | 'algo'

const NOTICE_MS = 3000

function algoBucket(algo: string): 'ed25519' | 'rsa' | 'ecdsa' | 'other' {
  const a = algo.toLowerCase()
  if (a.includes('ed25519')) {
    return 'ed25519'
  }
  if (a.includes('rsa')) {
    return 'rsa'
  }
  if (a.includes('ecdsa')) {
    return 'ecdsa'
  }
  return 'other'
}

function compareHosts(a: KnownHost, b: KnownHost, key: SortKey, dir: SortDir): number {
  let cmp = 0
  switch (key) {
    case 'host':
      cmp = a.host.localeCompare(b.host)
      break
    case 'algo':
      cmp = a.algo.localeCompare(b.algo)
      break
  }
  return dir === 'asc' ? cmp : -cmp
}

function truncateFingerprint(fp: string): string {
  if (fp.length <= 28) {
    return fp
  }
  return `${fp.slice(0, 14)}…${fp.slice(-10)}`
}

// eslint-disable-next-line react-refresh/only-export-components -- pure helper exported for unit testing
export function csvEscape(value: string): string {
  // Neutralize spreadsheet formula injection: cells starting with one of these
  // characters are interpreted as formulas by Excel/LibreOffice/Sheets.
  const neutralized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  if (/[",\n\r]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`
  }
  return neutralized
}

// eslint-disable-next-line react-refresh/only-export-components -- pure helper exported for unit testing
export function buildCsv(hosts: KnownHost[]): string {
  const header = ['host', 'algo', 'fingerprint'].join(',')
  const rows = hosts.map(host => [host.host, host.algo, host.fingerprint].map(csvEscape).join(','))
  return [header, ...rows].join('\n')
}

function todayStamp(): string {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${yyyy}${mm}${dd}`
}

function downloadCsv(hosts: KnownHost[]) {
  const csv = buildCsv(hosts)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `known-hosts-${todayStamp()}.csv`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function AdminKnownHostsPage() {
  const { t } = useTranslation()
  const hostsQuery = useKnownHosts()
  const deleteOneMutation = useDeleteKnownHost()
  const deleteBatchMutation = useDeleteKnownHostsBatch()

  const [query, setQuery] = React.useState('')
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const [sortKey, setSortKey] = React.useState<SortKey>('host')
  const [sortDir, setSortDir] = React.useState<SortDir>('asc')
  const [pendingDelete, setPendingDelete] = React.useState<KnownHost | null>(null)
  const [pendingBulkPurge, setPendingBulkPurge] = React.useState<KnownHost[] | null>(null)
  const [notice, setNotice] = React.useState<{ key: number, message: string } | null>(null)

  React.useEffect(() => {
    if (notice === null) {
      return undefined
    }
    const handle = window.setTimeout(setNotice, NOTICE_MS, null)
    return () => window.clearTimeout(handle)
  }, [notice])

  const hosts = hostsQuery.data
  const total = hosts?.length ?? 0

  const stats = React.useMemo(() => {
    const list = hosts ?? []
    const ed = list.filter(host => algoBucket(host.algo) === 'ed25519').length
    const rsa = list.filter(host => algoBucket(host.algo) === 'rsa').length
    const ecdsa = list.filter(host => algoBucket(host.algo) === 'ecdsa').length
    return [
      { label: t('admin.knownHosts.stats.total'), value: String(list.length), icon: Fingerprint },
      { label: t('admin.knownHosts.stats.ed25519'), value: String(ed), icon: ShieldCheck },
      { label: t('admin.knownHosts.stats.rsa'), value: String(rsa), icon: ShieldCheck },
      { label: t('admin.knownHosts.stats.ecdsa'), value: String(ecdsa), icon: ShieldCheck },
    ]
  }, [hosts, t])

  const filtered = React.useMemo(() => {
    const list = hosts ?? []
    const needle = query.trim().toLowerCase()
    const result = needle
      ? list.filter(host =>
          host.host.toLowerCase().includes(needle)
          || host.fingerprint.toLowerCase().includes(needle),
        )
      : list.slice()
    result.sort((a, b) => compareHosts(a, b, sortKey, sortDir))
    return result
  }, [hosts, query, sortKey, sortDir])

  const visibleAllSelected = filtered.length > 0 && filtered.every(host => selected.has(host.id))
  const visibleSomeSelected = filtered.some(host => selected.has(host.id)) && !visibleAllSelected
  const selectedHosts = React.useMemo(
    () => (hosts ?? []).filter(host => selected.has(host.id)),
    [hosts, selected],
  )
  const selectedCount = selectedHosts.length

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (visibleAllSelected) {
        for (const host of filtered) {
          next.delete(host.id)
        }
      }
      else {
        for (const host of filtered) {
          next.add(host.id)
        }
      }
      return next
    })
  }

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      }
      else {
        next.add(id)
      }
      return next
    })
  }

  const requestSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'))
    }
    else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const onExport = () => {
    downloadCsv(filtered)
  }

  const onBulkPurgeRequest = () => {
    if (selectedHosts.length === 0) {
      return
    }
    setPendingBulkPurge(selectedHosts)
  }

  const onBulkPurgeConfirm = async () => {
    if (!pendingBulkPurge) {
      return
    }
    const ids = pendingBulkPurge.map(host => host.id)
    await deleteBatchMutation.mutateAsync(ids)
    setPendingBulkPurge(null)
    setSelected(new Set())
    setNotice({ key: Date.now(), message: t('admin.knownHosts.toast.deletedBatch', { count: ids.length }) })
  }

  const onSingleDeleteConfirm = async () => {
    if (!pendingDelete) {
      return
    }
    await deleteOneMutation.mutateAsync(pendingDelete.id)
    const id = pendingDelete.id
    setSelected((prev) => {
      if (!prev.has(id)) {
        return prev
      }
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setPendingDelete(null)
    setNotice({ key: Date.now(), message: t('admin.knownHosts.toast.deletedOne') })
  }

  const isLoading = hostsQuery.isLoading
  const isError = hostsQuery.isError
  const list = hosts ?? []

  return (
    <>
      <PageHeader
        title={t('admin.knownHosts.title')}
        description={t('admin.knownHosts.description')}
        breadcrumbs={[
          { label: t('section.admin') },
          { label: t('admin.knownHosts.title') },
        ]}
        actions={(
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={onExport}
              disabled={filtered.length === 0}
              aria-label={t('admin.knownHosts.actions.export')}
            >
              <Download size={13} />
              <span>{t('admin.knownHosts.actions.export')}</span>
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={onBulkPurgeRequest}
              disabled={selectedCount === 0 || deleteBatchMutation.isPending}
              aria-label={t('admin.knownHosts.actions.purge')}
            >
              <Trash2 size={13} />
              <span>{t('admin.knownHosts.actions.purge')}</span>
            </Button>
          </>
        )}
      />

      <div className="grid grid-cols-1 gap-3 px-6 pt-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(stat => (
          <StatCard key={stat.label} label={stat.label} value={stat.value} icon={stat.icon} />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-4">
        <div className="w-[360px]">
          <Input
            icon={Search}
            placeholder={t('admin.knownHosts.search.placeholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            aria-label={t('actions.search')}
          />
        </div>
        {query
          ? (
              <Button variant="ghost" size="sm" onClick={() => setQuery('')}>
                {t('actions.clearFilters')}
              </Button>
            )
          : null}
        <span className="flex-1" />
        {notice
          ? (
              <span
                key={notice.key}
                className="inline-flex items-center gap-1.5 text-[12.5px] text-[hsl(var(--success))]"
                role="status"
                aria-live="polite"
              >
                <CheckCircle2 size={13} />
                <span>{notice.message}</span>
              </span>
            )
          : (
              <span className="text-[12px] text-muted-foreground">
                {t('admin.knownHosts.range', { showing: filtered.length, total })}
              </span>
            )}
      </div>

      <BulkActionBar
        selectedCount={selectedCount}
        onClear={() => setSelected(new Set())}
      >
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onBulkPurgeRequest}
          disabled={deleteBatchMutation.isPending}
        >
          <Trash2 size={13} />
          <span>{t('admin.knownHosts.selection.purge')}</span>
        </Button>
      </BulkActionBar>

      <div className="px-6 pb-6">
        {isLoading
          ? <KnownHostsTableSkeleton />
          : isError
            ? (
                <EmptyState
                  icon={AlertTriangle}
                  title={t('admin.knownHosts.loadError.title')}
                  description={t('admin.knownHosts.loadError.description')}
                  action={(
                    <Button variant="outline" size="sm" onClick={() => { void hostsQuery.refetch() }}>
                      {t('admin.knownHosts.loadError.retry')}
                    </Button>
                  )}
                />
              )
            : list.length === 0
              ? (
                  <EmptyState
                    icon={ServerOff}
                    title={t('admin.knownHosts.empty.title')}
                    description={t('admin.knownHosts.empty.hint')}
                  />
                )
              : filtered.length === 0
                ? (
                    <EmptyState
                      icon={Search}
                      title={t('admin.knownHosts.empty.filtered.title')}
                      action={(
                        <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                          {t('admin.knownHosts.empty.filtered.clear')}
                        </Button>
                      )}
                    />
                  )
                : (
                    <Table>
                      <THead>
                        <TR>
                          <TH className="w-[44px] pl-5">
                            <Checkbox
                              checked={visibleAllSelected}
                              indeterminate={visibleSomeSelected}
                              onCheckedChange={toggleAll}
                              aria-label={t('admin.knownHosts.selectAll')}
                              aria-checked={visibleSomeSelected ? 'mixed' : visibleAllSelected}
                            />
                          </TH>
                          <TH aria-sort={ariaSort(sortKey === 'host', sortDir)}>
                            <SortHeader
                              label={t('admin.knownHosts.table.host')}
                              active={sortKey === 'host'}
                              dir={sortDir}
                              onClick={() => requestSort('host')}
                            />
                          </TH>
                          <TH aria-sort={ariaSort(sortKey === 'algo', sortDir)}>
                            <SortHeader
                              label={t('admin.knownHosts.table.algorithm')}
                              active={sortKey === 'algo'}
                              dir={sortDir}
                              onClick={() => requestSort('algo')}
                            />
                          </TH>
                          <TH>{t('admin.knownHosts.table.fingerprint')}</TH>
                          <TH className="pr-5 text-right">{t('admin.knownHosts.table.actions')}</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {filtered.map(host => (
                          <KnownHostRow
                            key={host.id}
                            host={host}
                            checked={selected.has(host.id)}
                            onToggle={() => toggleOne(host.id)}
                            onDelete={() => setPendingDelete(host)}
                          />
                        ))}
                      </TBody>
                    </Table>
                  )}
      </div>

      <Dialog open={pendingDelete !== null} onClose={() => setPendingDelete(null)} width={440}>
        {pendingDelete
          ? (
              <div className="flex flex-col">
                <div className="px-6 pb-3 pt-5">
                  <DialogPrimitive.Title className="m-0 text-[16px] font-semibold">{t('admin.knownHosts.delete.one.title')}</DialogPrimitive.Title>
                  <DialogPrimitive.Description className="mt-2 text-[13.5px] text-muted-foreground">
                    {t('admin.knownHosts.delete.one.body', { host: pendingDelete.host })}
                  </DialogPrimitive.Description>
                </div>
                <div className="flex justify-end gap-2 border-t border-border px-6 py-3">
                  <Button variant="outline" onClick={() => setPendingDelete(null)} disabled={deleteOneMutation.isPending}>
                    {t('admin.knownHosts.delete.cancel')}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => { void onSingleDeleteConfirm() }}
                    disabled={deleteOneMutation.isPending}
                  >
                    {t('admin.knownHosts.delete.confirm')}
                  </Button>
                </div>
              </div>
            )
          : null}
      </Dialog>

      <Dialog open={pendingBulkPurge !== null} onClose={() => setPendingBulkPurge(null)} width={460}>
        {pendingBulkPurge
          ? (
              <div className="flex flex-col">
                <div className="px-6 pb-3 pt-5">
                  <DialogPrimitive.Title className="m-0 text-[16px] font-semibold">
                    {t('admin.knownHosts.delete.batch.title', { count: pendingBulkPurge.length })}
                  </DialogPrimitive.Title>
                  <DialogPrimitive.Description className="mt-2 text-[13.5px] text-muted-foreground">
                    {t('admin.knownHosts.delete.batch.body', { count: pendingBulkPurge.length })}
                  </DialogPrimitive.Description>
                </div>
                <div className="flex justify-end gap-2 border-t border-border px-6 py-3">
                  <Button variant="outline" onClick={() => setPendingBulkPurge(null)} disabled={deleteBatchMutation.isPending}>
                    {t('admin.knownHosts.delete.cancel')}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => { void onBulkPurgeConfirm() }}
                    disabled={deleteBatchMutation.isPending}
                  >
                    {t('admin.knownHosts.delete.confirm')}
                  </Button>
                </div>
              </div>
            )
          : null}
      </Dialog>
    </>
  )
}

function KnownHostRow({ host, checked, onToggle, onDelete }: {
  host: KnownHost
  checked: boolean
  onToggle: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const stop = (event: React.MouseEvent | React.KeyboardEvent) => event.stopPropagation()
  return (
    <TR>
      <TD className="pl-5" onClick={stop}>
        <Checkbox
          checked={checked}
          onCheckedChange={onToggle}
          aria-label={t('admin.knownHosts.selectRow', { host: host.host })}
        />
      </TD>
      <TD className="font-mono text-[12.5px]">{host.host}</TD>
      <TD>
        <Badge tone="mono" className="font-mono">{host.algo}</Badge>
      </TD>
      <TD className="font-mono text-[12px] text-muted-foreground" title={host.fingerprint}>
        {truncateFingerprint(host.fingerprint)}
      </TD>
      <TD className="pr-5 text-right" onClick={stop}>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          aria-label={t('admin.knownHosts.actions.deleteOne')}
        >
          <Trash2 size={14} />
        </Button>
      </TD>
    </TR>
  )
}

function KnownHostsTableSkeleton() {
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex h-10 items-center gap-3 border-b border-border bg-[hsl(var(--muted)/0.5)] px-5">
        <Skeleton className="h-3 w-4 rounded" />
        <Skeleton className="h-3 w-32" />
        <Skeleton className="ml-auto h-3 w-16" />
      </div>
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={`kh-skel-${String(index)}`}
          className="flex items-center gap-3 border-b border-border px-5 py-3 last:border-b-0"
        >
          <Skeleton className="h-4 w-4 rounded" />
          <Skeleton className="h-3.5 w-44" />
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="h-3 w-56" />
          <Skeleton className="ml-auto h-3 w-20" />
          <Skeleton className="h-7 w-7 rounded" />
        </div>
      ))}
    </Card>
  )
}
