import type { ApiToken } from '@/shared/types/domain'
import {
  AlertTriangle,
  Calendar,
  Check,
  Copy,
  Hash,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useApiTokens, useCreateApiToken, useRevokeApiToken } from '@/features/api-tokens/hooks/use-api-tokens-queries'
import { EmptyState } from '@/shared/components/empty-state'
import { StatCard } from '@/shared/components/stat-card'
import { Button } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { Drawer } from '@/shared/ui/drawer'
import { Input } from '@/shared/ui/input'
import { Select } from '@/shared/ui/select'
import { ConfirmDialog, FieldGroup, ListSkeleton, RowMenu } from './profile-shared'
import { fieldAria, useReturnFocusOnClose } from './profile-utils'

interface TokenCreateDraft {
  name: string
  expiresIn: string
}

const EXPIRY_OPTIONS_KEYS = ['d30', 'd90', 'd365', 'never'] as const
type ExpiryKey = (typeof EXPIRY_OPTIONS_KEYS)[number]
const EXPIRY_VALUE_BY_KEY: Record<ExpiryKey, string> = {
  d30: '30d',
  d90: '90d',
  d365: '365d',
  never: 'never',
}

export function ApiTokensTab() {
  const { t } = useTranslation()
  const tokensQuery = useApiTokens()
  const revokeMutation = useRevokeApiToken()

  const tokens = React.useMemo(() => tokensQuery.data ?? [], [tokensQuery.data])

  const [createOpen, setCreateOpen] = React.useState(false)
  const [pendingRevoke, setPendingRevoke] = React.useState<ApiToken | null>(null)
  const [createdSecret, setCreatedSecret] = React.useState<string | null>(null)

  const [query, setQuery] = React.useState('')

  const filtered = React.useMemo(() => {
    if (!query) {
      return tokens
    }
    const needle = query.toLowerCase()
    return tokens.filter(token => token.name.toLowerCase().includes(needle))
  }, [tokens, query])

  const expiringSoon = tokens.filter(token => /^\d{1,2}d$/u.test(token.expiresIn) && Number.parseInt(token.expiresIn, 10) <= 30).length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-[12.5px] text-muted-foreground">{t('profile.tokens.description')}</p>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus size={13} aria-hidden="true" />
          <span>{t('profile.tokens.create')}</span>
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <StatCard label={t('profile.tokens.stats.total')} value={String(tokens.length)} icon={Hash} />
        <StatCard label={t('profile.tokens.stats.expiring')} value={String(expiringSoon)} icon={Calendar} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="w-[280px]">
          <Input
            icon={Search}
            placeholder={t('profile.tokens.searchPlaceholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            aria-label={t('a11y.profile.tokensSearch')}
          />
        </div>
        <span className="flex-1" />
        <span
          role="status"
          aria-live="polite"
          className="text-[12px] text-muted-foreground"
        >
          {filtered.length}
          {' / '}
          {tokens.length}
        </span>
      </div>

      <Card>
        <CardContent className="p-0">
          {tokensQuery.isLoading
            ? <ListSkeleton className="p-5" />
            : filtered.length === 0
              ? (
                  <div className="p-6">
                    <EmptyState
                      icon={Hash}
                      title={t('profile.tokens.empty')}
                      description={t('profile.tokens.emptyHint')}
                      action={tokens.length === 0
                        ? (
                            <Button size="sm" onClick={() => setCreateOpen(true)}>
                              <Plus size={13} aria-hidden="true" />
                              <span>{t('profile.tokens.create')}</span>
                            </Button>
                          )
                        : undefined}
                    />
                  </div>
                )
              : (
                  <ul className="m-0 list-none divide-y divide-border p-0">
                    {filtered.map(token => (
                      <li key={token.id} className="flex items-center gap-3 px-5 py-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary text-foreground" aria-hidden="true">
                          <Hash size={15} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px] font-medium">{token.name}</div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground">
                            {t('profile.auth.added', { when: token.created })}
                            {' · '}
                            {token.expiresIn === 'never' ? t('profile.tokens.expiry.never') : token.expiresIn}
                          </div>
                        </div>
                        <RowMenu
                          items={[
                            { label: t('profile.actions.revoke'), icon: Trash2, danger: true, onClick: () => setPendingRevoke(token) },
                          ]}
                        />
                      </li>
                    ))}
                  </ul>
                )}
        </CardContent>
      </Card>

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

      <Dialog open={pendingRevoke !== null} onClose={() => setPendingRevoke(null)} width={460}>
        {pendingRevoke
          ? (
              <>
                <DialogHeader
                  title={t('profile.tokens.revoke.title')}
                  description={t('profile.tokens.revoke.body', { name: pendingRevoke.name })}
                  onClose={() => setPendingRevoke(null)}
                />
                <DialogBody>
                  <div className="rounded-md border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.08)] p-3 text-[13px]">
                    <div className="flex items-center gap-2 font-semibold text-[hsl(var(--warning))]">
                      <AlertTriangle size={14} aria-hidden="true" />
                      {t('profile.tokens.revoke.warningTitle')}
                    </div>
                    <p className="mt-1 text-muted-foreground">{t('profile.tokens.revoke.warningBody')}</p>
                  </div>
                </DialogBody>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setPendingRevoke(null)}>{t('actions.cancel')}</Button>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      void revokeMutation.mutateAsync(pendingRevoke.id)
                      setPendingRevoke(null)
                    }}
                  >
                    {t('profile.tokens.revoke.confirm')}
                  </Button>
                </DialogFooter>
              </>
            )
          : null}
      </Dialog>
    </div>
  )
}

function CreateTokenDrawer(props: {
  open: boolean
  existingNames: string[]
  onClose: () => void
  onCreated: (secret: string) => void
}) {
  if (!props.open)
    return null
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

  function confirmDiscard() {
    setDiscardOpen(false)
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
            <FieldGroup label={t('profile.tokens.createDrawer.nameLabel')} error={touched ? nameError : undefined} htmlFor="token-name" required>
              <Input
                id="token-name"
                placeholder={t('profile.tokens.createDrawer.namePlaceholder')}
                value={draft.name}
                onChange={event => setDraft(prev => ({ ...prev, name: event.target.value }))}
                onBlur={() => setTouched(true)}
                aria-invalid={touched && nameError ? true : undefined}
                {...fieldAria('token-name', true, touched && !!nameError)}
              />
            </FieldGroup>
            <FieldGroup label={t('profile.tokens.createDrawer.expiresLabel')} htmlFor="token-expires">
              <Select
                id="token-expires"
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
        onConfirm={confirmDiscard}
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

  function copy() {
    void navigator.clipboard.writeText(secret)
    setCopied(true)
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
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t('profile.tokens.secret.acknowledge')}</Button>
      </DialogFooter>
    </Dialog>
  )
}

// ===========================================================================
// TicketsTab
// ===========================================================================
