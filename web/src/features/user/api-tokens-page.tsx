import type { ApiToken } from '@/shared/types/domain'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Calendar,
  Check,
  ChevronsUpDown,
  Clock,
  Copy,
  Hash,
  Inbox,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useApiTokens, useCreateApiToken, useRevokeApiToken } from '@/features/api-tokens/hooks/use-api-tokens-queries'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { StatCard } from '@/shared/components/stat-card'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { Drawer } from '@/shared/ui/drawer'
import { DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'
import { Select } from '@/shared/ui/select'
import { Skeleton } from '@/shared/ui/skeleton'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'
import { ConfirmDialog, FieldGroup } from './_credential-primitives'
import { fieldAria, useReturnFocusOnClose } from './_credential-utils'

type SortKey = 'name' | 'created'
type SortDir = 'asc' | 'desc'

const EXPIRY_OPTIONS_KEYS = ['d30', 'd90', 'd365', 'never'] as const
type ExpiryKey = (typeof EXPIRY_OPTIONS_KEYS)[number]
const EXPIRY_VALUE_BY_KEY: Record<ExpiryKey, string> = {
  d30: '30d',
  d90: '90d',
  d365: '365d',
  never: 'never',
}

function sortValue(token: ApiToken, key: SortKey): string {
  switch (key) {
    case 'name': return token.name.toLowerCase()
    case 'created': return token.created
  }
}

function compare(a: ApiToken, b: ApiToken, key: SortKey, dir: SortDir): number {
  const av = sortValue(a, key)
  const bv = sortValue(b, key)
  const result = av.localeCompare(bv)
  return dir === 'asc' ? result : -result
}

export function ApiTokensPage() {
  const { t } = useTranslation()
  const tokensQuery = useApiTokens()
  const revokeMutation = useRevokeApiToken()

  const tokens = React.useMemo(() => tokensQuery.data ?? [], [tokensQuery.data])

  const [query, setQuery] = React.useState('')
  const [sortKey, setSortKey] = React.useState<SortKey>('created')
  const [sortDir, setSortDir] = React.useState<SortDir>('desc')

  const [createOpen, setCreateOpen] = React.useState(false)
  const [pendingRevoke, setPendingRevoke] = React.useState<ApiToken | null>(null)
  const [createdSecret, setCreatedSecret] = React.useState<string | null>(null)

  const filtersActive = query.trim().length > 0

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    const out = tokens.filter((token) => {
      if (needle && !token.name.toLowerCase().includes(needle)) {
        return false
      }
      return true
    })
    return out.sort((a, b) => compare(a, b, sortKey, sortDir))
  }, [tokens, query, sortKey, sortDir])

  const expiringSoon = tokens.filter(token => /^\d{1,2}d$/u.test(token.expiresIn) && Number.parseInt(token.expiresIn, 10) <= 30).length

  const stats = [
    { label: t('user.apiTokens.stats.total'), value: String(tokens.length), icon: Hash },
    { label: t('user.apiTokens.stats.expiring'), value: String(expiringSoon), icon: Calendar },
  ]

  const setSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'))
    }
    else {
      setSortKey(key)
      setSortDir(key === 'name' ? 'asc' : 'desc')
    }
  }

  const clearFilters = () => {
    setQuery('')
  }

  const isLoading = tokensQuery.isLoading
  const showEmpty = !isLoading && tokens.length === 0
  const showFilteredEmpty = !isLoading && tokens.length > 0 && filtered.length === 0

  return (
    <>
      <PageHeader
        title={t('user.apiTokens.title')}
        description={t('user.apiTokens.description')}
        actions={(
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus size={13} aria-hidden="true" />
            <span>{t('user.apiTokens.actions.create')}</span>
          </Button>
        )}
      />

      <div className="grid gap-3 px-6 pt-4 sm:grid-cols-2">
        {stats.map(stat => (
          <StatCard key={stat.label} label={stat.label} value={stat.value} icon={stat.icon} />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-4">
        <div className="w-[280px]">
          <Input
            icon={Search}
            placeholder={t('user.apiTokens.searchPlaceholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            aria-label={t('a11y.user.apiTokens.search')}
          />
        </div>
        {filtersActive
          ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                {t('actions.clearFilters')}
              </Button>
            )
          : null}
        <span className="flex-1" />
        <span role="status" aria-live="polite" className="text-[12px] text-muted-foreground">
          {filtered.length}
          {' / '}
          {tokens.length}
        </span>
      </div>

      <div className="px-6 pb-6">
        {isLoading
          ? <ApiTokensTableSkeleton />
          : showEmpty
            ? (
                <EmptyState
                  icon={Inbox}
                  title={t('user.apiTokens.empty.title')}
                  description={t('user.apiTokens.empty.description')}
                  action={(
                    <Button size="sm" onClick={() => setCreateOpen(true)}>
                      <Plus size={13} aria-hidden="true" />
                      <span>{t('user.apiTokens.actions.create')}</span>
                    </Button>
                  )}
                />
              )
            : showFilteredEmpty
              ? (
                  <EmptyState
                    icon={Clock}
                    title={t('user.apiTokens.empty.filteredTitle')}
                    description={t('user.apiTokens.empty.filteredDescription')}
                    action={(
                      <Button variant="outline" size="sm" onClick={clearFilters}>
                        {t('actions.clearFilters')}
                      </Button>
                    )}
                  />
                )
              : (
                  <Table>
                    <THead>
                      <TR>
                        <TH aria-sort={sortKey === 'name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'} className="pl-5">
                          <SortHeader label={t('profile.tokens.fields.name')} active={sortKey === 'name'} dir={sortDir} onClick={() => setSort('name')} />
                        </TH>
                        <TH aria-sort={sortKey === 'created' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                          <SortHeader label={t('profile.tokens.fields.created')} active={sortKey === 'created'} dir={sortDir} onClick={() => setSort('created')} />
                        </TH>
                        <TH>{t('profile.tokens.fields.expiresIn')}</TH>
                        <TH className="pr-5 text-right" aria-label={t('fields.actions')} />
                      </TR>
                    </THead>
                    <TBody>
                      {filtered.map(token => (
                        <TR key={token.id}>
                          <TD className="pl-5">
                            <div className="flex items-center gap-2.5">
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground" aria-hidden="true">
                                <Hash size={15} />
                              </div>
                              <div className="min-w-0">
                                <div className="truncate text-[13.5px] font-medium">{token.name}</div>
                              </div>
                            </div>
                          </TD>
                          <TD className="text-[12.5px] text-muted-foreground">{token.created}</TD>
                          <TD className="mono tabular text-[12.5px] text-muted-foreground">
                            {token.expiresIn === 'never' ? t('profile.tokens.expiry.never') : token.expiresIn}
                          </TD>
                          <TD className="pr-5 text-right">
                            <DropdownMenu
                              trigger={(
                                <Button variant="ghost" size="icon-sm" aria-label={t('user.apiTokens.rowMenu', { name: token.name })}>
                                  <MoreHorizontal size={14} aria-hidden="true" />
                                </Button>
                              )}
                              items={[
                                { label: t('profile.actions.revoke'), icon: Trash2, danger: true, onClick: () => setPendingRevoke(token) },
                              ]}
                            />
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
      </div>

      <CreateTokenDrawer
        open={createOpen}
        existingNames={tokens.map(token => token.name)}
        onClose={() => setCreateOpen(false)}
        onCreated={(secret) => {
          setCreateOpen(false)
          setCreatedSecret(secret)
        }}
      />

      <SecretRevealDialog
        secret={createdSecret}
        onClose={() => setCreatedSecret(null)}
      />

      <ConfirmDialog
        open={pendingRevoke !== null}
        title={t('profile.tokens.revoke.title')}
        body={pendingRevoke ? t('profile.tokens.revoke.body', { name: pendingRevoke.name }) : ''}
        confirmLabel={t('profile.tokens.revoke.confirm')}
        destructive
        onCancel={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (pendingRevoke) {
            void revokeMutation.mutateAsync(pendingRevoke.id)
          }
          setPendingRevoke(null)
        }}
      >
        {pendingRevoke
          ? (
              <DialogBody>
                <div className="rounded-md border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.08)] p-3 text-[13px]">
                  <div className="flex items-center gap-2 font-semibold text-[hsl(var(--warning))]">
                    <AlertTriangle size={14} aria-hidden="true" />
                    {t('profile.tokens.revoke.warningTitle')}
                  </div>
                  <p className="mt-1 text-muted-foreground">{t('profile.tokens.revoke.warningBody')}</p>
                </div>
              </DialogBody>
            )
          : null}
      </ConfirmDialog>
    </>
  )
}

function SortHeader({ label, active, dir, onClick }: {
  label: string
  active: boolean
  dir: SortDir
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="-mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-left transition hover:bg-[hsl(var(--accent)/0.55)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]"
      onClick={onClick}
    >
      <span>{label}</span>
      {active
        ? (
            dir === 'asc'
              ? <ArrowUp size={11} className="text-foreground" />
              : <ArrowDown size={11} className="text-foreground" />
          )
        : <ChevronsUpDown size={11} className="opacity-60" />}
    </button>
  )
}

interface TokenCreateDraft {
  name: string
  expiresIn: string
}

function CreateTokenDrawer(props: {
  open: boolean
  existingNames: string[]
  onClose: () => void
  onCreated: (secret: string) => void
}) {
  if (!props.open) {
    return null
  }
  return <CreateTokenDrawerBody {...props} />
}

function CreateTokenDrawerBody({ existingNames, onClose, onCreated }: {
  existingNames: string[]
  onClose: () => void
  onCreated: (secret: string) => void
}) {
  useReturnFocusOnClose()
  const { t } = useTranslation()
  const titleId = React.useId()
  const createMutation = useCreateApiToken()
  const [draft, setDraft] = React.useState<TokenCreateDraft>(() => ({ name: '', expiresIn: '90d' }))
  const [touched, setTouched] = React.useState(false)
  const [discardOpen, setDiscardOpen] = React.useState(false)

  const nameTrimmed = draft.name.trim()
  const nameError = nameTrimmed === ''
    ? t('profile.tokens.createDrawer.validate.nameRequired')
    : existingNames.includes(nameTrimmed)
      ? t('profile.tokens.createDrawer.validate.nameDuplicate')
      : undefined
  const valid = nameError === undefined
  const dirty = nameTrimmed !== ''

  async function submit() {
    setTouched(true)
    if (!valid) {
      return
    }
    const { fullSecret } = await createMutation.mutateAsync({
      name: nameTrimmed,
      expiresIn: draft.expiresIn,
    })
    onCreated(fullSecret)
  }

  function attemptClose() {
    if (dirty) {
      setDiscardOpen(true)
      return
    }
    onClose()
  }

  return (
    <>
      <Drawer open onClose={attemptClose} width={560}>
        <div className="flex h-full flex-col" role="region" aria-labelledby={titleId}>
          <div className="flex items-start justify-between gap-3 border-b border-border px-6 py-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary text-foreground" aria-hidden="true">
                <Hash size={18} />
              </div>
              <div>
                <h2 id={titleId} className="m-0 text-[17px] font-semibold">{t('profile.tokens.createDrawer.title')}</h2>
                <p className="mt-0.5 text-[13px] text-muted-foreground">{t('profile.tokens.createDrawer.description')}</p>
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={attemptClose} aria-label={t('actions.close')}>
              <X size={15} aria-hidden="true" />
            </Button>
          </div>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
            <FieldGroup label={t('profile.tokens.createDrawer.nameLabel')} error={touched ? nameError : undefined} htmlFor="user-token-name" required>
              <Input
                id="user-token-name"
                placeholder={t('profile.tokens.createDrawer.namePlaceholder')}
                value={draft.name}
                onChange={event => setDraft(prev => ({ ...prev, name: event.target.value }))}
                onBlur={() => setTouched(true)}
                aria-invalid={touched && nameError ? true : undefined}
                {...fieldAria('user-token-name', true, touched && !!nameError)}
              />
            </FieldGroup>
            <FieldGroup label={t('profile.tokens.createDrawer.expiresLabel')} htmlFor="user-token-expires">
              <Select
                id="user-token-expires"
                value={draft.expiresIn}
                onValueChange={value => setDraft(prev => ({ ...prev, expiresIn: value }))}
                options={EXPIRY_OPTIONS_KEYS.map(key => ({
                  value: EXPIRY_VALUE_BY_KEY[key],
                  label: t(`profile.tokens.expiry.${key}`),
                }))}
              />
            </FieldGroup>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border bg-card px-6 py-3">
            <Button variant="outline" onClick={attemptClose}>{t('actions.cancel')}</Button>
            <Button onClick={() => { void submit() }} disabled={!valid || createMutation.isPending}>
              {t('profile.tokens.createDrawer.submit')}
            </Button>
          </div>
        </div>
      </Drawer>
      <ConfirmDialog
        open={discardOpen}
        title={t('profile.info.discardTitle')}
        body={t('profile.info.discardBody')}
        confirmLabel={t('profile.info.discard')}
        cancelLabel={t('profile.info.keepEditing')}
        destructive
        onCancel={() => setDiscardOpen(false)}
        onConfirm={() => {
          setDiscardOpen(false)
          onClose()
        }}
      />
    </>
  )
}

function SecretRevealDialog({ secret, onClose }: { secret: string | null, onClose: () => void }) {
  if (!secret) {
    return null
  }
  return <SecretRevealDialogBody secret={secret} onClose={onClose} />
}

function SecretRevealDialogBody({ secret, onClose }: { secret: string, onClose: () => void }) {
  const { t } = useTranslation()
  const [copied, setCopied] = React.useState(false)
  const [liveMsg, setLiveMsg] = React.useState('')

  function copy() {
    void navigator.clipboard?.writeText(secret)
    setCopied(true)
    setLiveMsg(t('profile.tokens.secret.copied'))
  }

  return (
    <Dialog open onClose={onClose} width={560}>
      <DialogHeader
        title={t('profile.tokens.secret.title')}
        description={t('profile.tokens.secret.description')}
        onClose={onClose}
      />
      <DialogBody>
        <div className="flex items-stretch gap-2 rounded-md border border-border bg-[hsl(var(--muted)/0.5)] p-3">
          <code className="mono min-w-0 flex-1 break-all text-[13px]">{secret}</code>
          <Button variant="outline" size="icon-sm" aria-label={t('profile.tokens.secret.copy')} onClick={copy}>
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          </Button>
        </div>
        <span className="sr-only" role="status" aria-live="polite">{liveMsg}</span>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t('profile.tokens.secret.acknowledge')}</Button>
      </DialogFooter>
    </Dialog>
  )
}

function ApiTokensTableSkeleton() {
  return (
    <Table>
      <THead>
        <TR>
          <TH className="pl-5"><Skeleton className="h-3.5 w-24" /></TH>
          <TH><Skeleton className="h-3.5 w-16" /></TH>
          <TH><Skeleton className="h-3.5 w-12" /></TH>
          <TH className="pr-5" />
        </TR>
      </THead>
      <TBody>
        {Array.from({ length: 4 }).map((_, index) => (
          <TR key={`at-skel-${String(index)}`}>
            <TD className="pl-5">
              <div className="flex items-center gap-2.5">
                <Skeleton className="h-8 w-8 rounded-lg" />
                <Skeleton className="h-3.5 w-36" />
              </div>
            </TD>
            <TD><Skeleton className="h-3 w-16" /></TD>
            <TD><Skeleton className="h-3 w-12" /></TD>
            <TD className="pr-5 text-right"><Skeleton className="ml-auto h-7 w-7 rounded" /></TD>
          </TR>
        ))}
      </TBody>
    </Table>
  )
}
