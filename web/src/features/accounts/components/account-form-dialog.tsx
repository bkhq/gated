import type { AccountUpdateInput } from '@/features/accounts/hooks/use-accounts-queries'
import type { RevealConfirmation } from '@/shared/lib/api/accounts'
import type { Account, AccountCredentials, AccountKind, HttpHeaderCredential } from '@/shared/types/domain'
import type { AccountDraft } from '@/shared/types/drafts'
import { Pencil, ShieldCheck, Trash2, User as UserIcon } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  defaultCredentialsFor,
  useAccount,
  useAccountReferences,
  useCreateAccount,
  useRevealAccountSecret,
  useUpdateAccount,
} from '@/features/accounts/hooks/use-accounts-queries'
import { formatDateTime, isRotationDue, missingCredentialFields, stepUpErrorKey } from '@/features/accounts/utils'
import { DiscardChangesDialog } from '@/shared/components/discard-changes-dialog'
import { DrawerFooter } from '@/shared/components/drawer-footer'
import { EmptyState } from '@/shared/components/empty-state'
import { FormDialog, FormDialogDescription, FormDialogTitle } from '@/shared/components/form-dialog'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Select } from '@/shared/ui/select'
import { Skeleton } from '@/shared/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'
import { Textarea } from '@/shared/ui/textarea'

import { CredentialsEditor } from './account-credentials-editor'
import { AccountCredentialsView } from './account-credentials-view'
import { DeleteAccountDialog } from './delete-account-dialog'
import { StepUpDialog } from './step-up-dialog'

export type AccountFormMode = 'view' | 'create' | 'edit'

export interface AccountFormDialogProps {
  open: boolean
  mode: AccountFormMode
  account: Account | null
  onClose: () => void
  onDeleted?: () => void
  onSaved?: (account: Account) => void
  // Restrict selectable kinds on create (e.g. inline create from a target).
  allowedKinds?: readonly AccountKind[]
  finalFocusRef?: React.RefObject<HTMLElement | null>
}

const ACCOUNT_KINDS: readonly AccountKind[] = [
  'ssh-password',
  'ssh-key',
  'db-password',
  'k8s-token',
  'k8s-client-cert',
  'http-headers',
]

type Tab = 'details' | 'targets'

// Rotation due date presets; durations are counted from the moment of saving.
const ROTATION_DAYS = { d30: 30, d90: 90, d180: 180, d365: 365 } as const
type RotationChoice = 'keep' | 'never' | keyof typeof ROTATION_DAYS

function resolveRotation(choice: RotationChoice, current: string | null, now = Date.now()): string | null {
  if (choice === 'keep')
    return current
  if (choice === 'never')
    return null
  return new Date(now + ROTATION_DAYS[choice] * 86_400_000).toISOString()
}

interface DraftState {
  name: string
  description: string
  kind: AccountKind
  credentials: AccountCredentials
  rotation: RotationChoice
}

function emptyDraft(kind: AccountKind): DraftState {
  return {
    name: '',
    description: '',
    kind,
    credentials: defaultCredentialsFor(kind),
    rotation: 'never',
  }
}

function draftFromAccount(account: Account, credentials: AccountCredentials): DraftState {
  return {
    name: account.name,
    description: account.description,
    kind: account.kind,
    credentials,
    rotation: account.rotationDueAt ? 'keep' : 'never',
  }
}

// Strip empty optional fields so the request body matches the backend's
// `Option<String>` shape (None for absent vs Some("") for empty). Blank
// required secrets are kept as "" — on edit the backend keeps the stored value.
function sanitizeCredentials(creds: AccountCredentials): AccountCredentials {
  switch (creds.kind) {
    case 'ssh-password':
      return creds
    case 'ssh-key': {
      const out: AccountCredentials = { kind: 'ssh-key', username: creds.username, private_key_pem: creds.private_key_pem }
      if (creds.passphrase)
        out.passphrase = creds.passphrase
      return out
    }
    case 'db-password':
      return creds
    case 'k8s-token': {
      const out: AccountCredentials = { kind: 'k8s-token', token: creds.token }
      if (creds.ca_pem)
        out.ca_pem = creds.ca_pem
      if (creds.namespace)
        out.namespace = creds.namespace
      return out
    }
    case 'k8s-client-cert': {
      const out: AccountCredentials = {
        kind: 'k8s-client-cert',
        client_certificate_pem: creds.client_certificate_pem,
        client_private_key_pem: creds.client_private_key_pem,
      }
      if (creds.passphrase)
        out.passphrase = creds.passphrase
      if (creds.ca_pem)
        out.ca_pem = creds.ca_pem
      if (creds.namespace)
        out.namespace = creds.namespace
      return out
    }
    case 'http-headers':
      return {
        kind: 'http-headers',
        headers: creds.headers.filter(h => h.name.length > 0).map((h) => {
          const out: HttpHeaderCredential = { name: h.name, value: h.value }
          if (h.sensitive)
            out.sensitive = true
          return out
        }),
      }
  }
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso)
    return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(locale)
}

export function AccountFormDialog(props: AccountFormDialogProps) {
  const { mode, account } = props
  return (
    <AccountFormDialogBody key={`${props.open}-${mode}-${account?.id ?? 'new'}`} {...props} />
  )
}

function AccountFormDialogBody({ open, mode: initialMode, account: initialAccount, onClose, onDeleted, onSaved, allowedKinds, finalFocusRef }: AccountFormDialogProps) {
  const { t, i18n } = useTranslation()
  const kinds = allowedKinds && allowedKinds.length > 0 ? allowedKinds : ACCOUNT_KINDS
  const [mode, setMode] = React.useState<AccountFormMode>(initialAccount ? initialMode : 'create')
  const createMutation = useCreateAccount()
  const updateMutation = useUpdateAccount()
  const revealMutation = useRevealAccountSecret()
  const detailQuery = useAccount(initialAccount?.id)
  const account = detailQuery.data?.account ?? initialAccount
  const storedCredentials = detailQuery.data?.credentials ?? null
  const referencesQuery = useAccountReferences(account?.id)
  const targetNames = referencesQuery.data?.targetNames ?? []

  const [tab, setTab] = React.useState<Tab>('details')
  const [draft, setDraft] = React.useState<DraftState | null>(() => (mode === 'create' ? emptyDraft(kinds[0] ?? 'ssh-password') : null))
  const [baseline, setBaseline] = React.useState<DraftState | null>(draft)
  // Credentials only fly to the backend when explicitly touched — that
  // distinguishes a normal name/description edit from a credential rotation.
  const [credentialsDirty, setCredentialsDirty] = React.useState(mode === 'create')
  const [rotationDirty, setRotationDirty] = React.useState(false)
  const [showErrors, setShowErrors] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [stepUp, setStepUp] = React.useState<'save' | 'reveal' | null>(null)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [discardToView, setDiscardToView] = React.useState(false)

  // Edit drafts start from the stored (secret-free) credentials, which load
  // asynchronously; seed the draft once they arrive.
  if (mode === 'edit' && draft === null && account && storedCredentials) {
    const seeded = draftFromAccount(account, storedCredentials)
    setDraft(seeded)
    setBaseline(seeded)
  }

  const dirty = draft !== null && baseline !== null && JSON.stringify(draft) !== JSON.stringify(baseline)

  const missing = draft
    ? [
        ...(draft.name.trim() === '' ? ['fields.name'] : []),
        ...(credentialsDirty ? missingCredentialFields(draft.credentials, mode === 'edit') : []),
      ]
    : []

  function patchDraft(patch: Partial<DraftState>) {
    setDraft(prev => (prev ? { ...prev, ...patch } : prev))
  }

  function patchCredentials(next: AccountCredentials) {
    setCredentialsDirty(true)
    patchDraft({ credentials: next })
  }

  function setKind(next: AccountKind) {
    setCredentialsDirty(true)
    patchDraft({ kind: next, credentials: defaultCredentialsFor(next) })
  }

  function setRotation(next: RotationChoice) {
    setRotationDirty(true)
    patchDraft({ rotation: next })
  }

  function startEdit() {
    revealMutation.reset()
    setDraft(null)
    setBaseline(null)
    setCredentialsDirty(false)
    setRotationDirty(false)
    setShowErrors(false)
    setFormError(null)
    setMode('edit')
  }

  function backToView() {
    setDiscardToView(false)
    setDraft(null)
    setBaseline(null)
    setShowErrors(false)
    setFormError(null)
    setMode('view')
  }

  function requestSave() {
    if (!draft)
      return
    if (missing.length > 0) {
      setShowErrors(true)
      setTab('details')
      return
    }
    setFormError(null)
    setStepUp('save')
  }

  async function save(confirmation: RevealConfirmation) {
    if (!draft)
      return
    try {
      if (mode === 'edit' && account) {
        const patch: AccountUpdateInput = {
          name: draft.name,
          description: draft.description,
        }
        if (credentialsDirty)
          patch.credentials = sanitizeCredentials(draft.credentials)
        if (rotationDirty && draft.rotation !== 'keep')
          patch.rotationDueAt = resolveRotation(draft.rotation, null)
        const updated = await updateMutation.mutateAsync({ id: account.id, patch, confirmation })
        setStepUp(null)
        if (updated)
          onSaved?.(updated)
        backToView()
      }
      else {
        const accountDraft: AccountDraft = {
          name: draft.name,
          kind: draft.kind,
          description: draft.description,
          credentials: sanitizeCredentials(draft.credentials),
          tags: [],
          rotationDueAt: resolveRotation(draft.rotation, null),
        }
        const created = await createMutation.mutateAsync({ draft: accountDraft, confirmation })
        setStepUp(null)
        onSaved?.(created)
        onClose()
      }
    }
    catch (failure) {
      // Wrong confirmation / throttling stays in the prompt; validation and
      // conflicts belong to the form.
      if (stepUpErrorKey(failure))
        throw failure
      setStepUp(null)
      setFormError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  async function reveal(confirmation: RevealConfirmation) {
    if (!account)
      return
    await revealMutation.mutateAsync({ id: account.id, confirmation })
    setStepUp(null)
  }

  const revealed = revealMutation.data && account && revealMutation.data.kind === account.kind ? revealMutation.data.credentials : null
  const isView = mode === 'view'

  const header = (
    <div className="flex items-center gap-3 border-b border-border px-6 py-5">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary text-foreground">
        <UserIcon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <FormDialogTitle className={`m-0 flex items-center gap-2 text-[17px] font-semibold leading-tight ${account ? 'mono' : ''}`}>
          <span className="truncate">{account?.name || t('accounts.form.titleNew')}</span>
          {account ? <Badge tone="mono" className="font-sans">{t(`accounts.credLabels.${account.kind}`)}</Badge> : null}
          {mode === 'edit' ? <Badge tone="info" className="font-sans">{t('accounts.view.editing')}</Badge> : null}
        </FormDialogTitle>
        <FormDialogDescription className="mt-0.5 truncate text-[13px] text-muted-foreground">
          {account?.description || t('accounts.form.descNew')}
        </FormDialogDescription>
      </div>
    </div>
  )

  const tabs = ['details', 'targets'] as const
  // A new account has no bindings yet, so create is a single page.
  const tabsStrip = mode === 'create'
    ? undefined
    : (
        <div className="border-b border-border px-6 pt-2">
          <Tabs value={tab} onChange={next => setTab(next as Tab)}>
            <TabsList className="gap-1 bg-transparent p-0">
              {tabs.map(value => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className={`h-9 rounded-none bg-transparent px-2.5 shadow-none ${tab === value ? 'border-b-2 border-foreground' : 'border-b-2 border-transparent'}`}
                >
                  {t(`accounts.form.tabs.${value}`)}
                  {value === 'targets' && account ? ` · ${targetNames.length}` : ''}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      )

  const footer = (requestClose: () => void) => isView
    ? (
        <DrawerFooter
          leftAction={(
            <Button variant="ghost" size="sm" className="text-[hsl(var(--destructive))]" onClick={() => setDeleteOpen(true)}>
              <Trash2 size={13} />
              <span>{t('actions.delete')}</span>
            </Button>
          )}
          onCancel={requestClose}
          cancelLabel={t('actions.close')}
          onSave={startEdit}
          saveLabel={(
            <>
              <Pencil size={13} />
              <span>{t('actions.edit')}</span>
            </>
          )}
        />
      )
    : (
        <DrawerFooter
          leftAction={showErrors && missing.length > 0
            ? (
                <span role="alert" className="text-[12px] text-[hsl(var(--destructive))]">
                  {t('accounts.form.missing', { fields: missing.map(key => t(key)).join(', ') })}
                </span>
              )
            : undefined}
          onCancel={mode === 'edit' ? () => (dirty ? setDiscardToView(true) : backToView()) : requestClose}
          onSave={requestSave}
          saveLabel={(
            <>
              <ShieldCheck size={13} />
              <span>{t('accounts.form.saveVerified')}</span>
            </>
          )}
          saveDisabled={draft === null}
          isPending={createMutation.isPending || updateMutation.isPending}
        />
      )

  return (
    <>
      <FormDialog
        open={open}
        onClose={onClose}
        width="lg"
        dirty={dirty}
        discardTitle={t('accounts.unsaved.title')}
        discardBody={t('accounts.unsaved.body')}
        discardLabel={t('accounts.unsaved.discard')}
        finalFocusRef={finalFocusRef}
        header={header}
        belowHeader={tabsStrip}
        scrollResetKey={tab}
        footer={footer}
      >
        {formError
          ? (
              <div role="alert" className="rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)] p-3 text-[12.5px] text-[hsl(var(--destructive))]">
                {formError}
              </div>
            )
          : null}

        {!isView && draft === null
          ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            )
          : (
              <Tabs className="w-full self-stretch" value={tab} onChange={next => setTab(next as Tab)}>
                <TabsContent value="details">
                  {isView || !draft
                    ? account
                      ? (
                          <div className="flex flex-col gap-5">
                            <dl className="grid grid-cols-1 gap-x-6 gap-y-4 text-[13px] sm:grid-cols-2">
                              <ViewField label={t('fields.name')} value={<span className="mono">{account.name}</span>} />
                              <ViewField label={t('accounts.form.cred.kindLabel')} value={t(`accounts.credLabels.${account.kind}`)} />
                              <ViewField
                                label={t('accounts.form.rotation.label')}
                                value={account.rotationDueAt
                                  ? (
                                      <span className="inline-flex items-center gap-2">
                                        {formatDate(account.rotationDueAt, i18n.language)}
                                        {isRotationDue(account) ? <Badge tone="warning">{t('accounts.view.rotationDue')}</Badge> : null}
                                      </span>
                                    )
                                  : t('accounts.form.rotation.never')}
                              />
                              <ViewField label={t('fields.lastUsed')} value={formatDateTime(account.lastUsed, i18n.language)} />
                              <div className="sm:col-span-2">
                                <ViewField label={t('fields.description')} value={account.description || '—'} />
                              </div>
                            </dl>
                            {storedCredentials
                              ? (
                                  <AccountCredentialsView
                                    credentials={storedCredentials}
                                    revealed={revealed}
                                    onReveal={() => setStepUp('reveal')}
                                    onHide={() => revealMutation.reset()}
                                  />
                                )
                              : <Skeleton className="h-32 w-full" />}
                          </div>
                        )
                      : null
                    : (
                        <div className="flex flex-col gap-5">
                          <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                            <div>
                              <Label htmlFor="account-name">{t('fields.name')}</Label>
                              <Input
                                id="account-name"
                                className="mono"
                                value={draft.name}
                                onChange={event => patchDraft({ name: event.target.value })}
                                placeholder="prod-deploy"
                                aria-invalid={showErrors && draft.name.trim() === ''}
                              />
                            </div>
                            <div>
                              <Label htmlFor="account-kind">{t('accounts.form.cred.kindLabel')}</Label>
                              <Select
                                id="account-kind"
                                value={draft.kind}
                                onValueChange={value => setKind(value as AccountKind)}
                                disabled={mode === 'edit'}
                                options={(mode === 'edit' ? ACCOUNT_KINDS : kinds).map(k => ({ value: k, label: t(`accounts.credLabels.${k}`) }))}
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <Label htmlFor="account-description">{t('fields.description')}</Label>
                              <Textarea
                                id="account-description"
                                rows={2}
                                value={draft.description}
                                onChange={event => patchDraft({ description: event.target.value })}
                                placeholder={t('accounts.form.descriptionPlaceholder')}
                              />
                            </div>
                          </div>

                          <section className="flex flex-col gap-4 border-t border-border pt-5">
                            <h3 className="m-0 text-[13px] font-semibold">{t('accounts.form.sections.credential')}</h3>
                            {mode === 'edit'
                              ? (
                                  <div className="rounded-md border border-border/60 bg-[hsl(var(--muted)/0.25)] p-3 text-[12px] text-muted-foreground">
                                    {t('accounts.form.cred.emptyOnEditHint')}
                                  </div>
                                )
                              : null}
                            <CredentialsEditor credentials={draft.credentials} onChange={patchCredentials} />
                          </section>

                          <RotationField
                            value={draft.rotation}
                            current={mode === 'edit' ? account?.rotationDueAt ?? null : null}
                            onChange={setRotation}
                          />
                        </div>
                      )}
                </TabsContent>

                <TabsContent value="targets">
                  <Card className="p-0">
                    <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                      <div className="flex-1 text-[13px] font-semibold">{t('accounts.form.targets.title')}</div>
                    </div>
                    {targetNames.length === 0
                      ? (
                          <div className="p-6">
                            <EmptyState
                              title={t('accounts.form.targets.emptyTitle')}
                              description={t('accounts.form.targets.emptyDescription')}
                            />
                          </div>
                        )
                      : targetNames.map((name, index) => (
                          <div
                            key={name}
                            className="flex items-center gap-2.5 px-4 py-2.5"
                            style={{ borderTop: index === 0 ? 'none' : '1px solid hsl(var(--border))' }}
                          >
                            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-secondary">
                              <ShieldCheck size={14} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[13.5px] font-medium">{name}</div>
                            </div>
                          </div>
                        ))}
                  </Card>
                </TabsContent>
              </Tabs>
            )}
      </FormDialog>

      <StepUpDialog
        open={stepUp === 'save'}
        title={t(mode === 'create' ? 'accounts.stepUp.createTitle' : 'accounts.stepUp.updateTitle')}
        description={t('accounts.stepUp.saveDescription')}
        confirmLabel={t('accounts.stepUp.confirmSave')}
        onCancel={() => setStepUp(null)}
        onConfirm={save}
      />
      <StepUpDialog
        open={stepUp === 'reveal'}
        title={t('accounts.stepUp.revealTitle')}
        description={t('accounts.stepUp.revealDescription')}
        confirmLabel={t('accounts.form.reveal.show')}
        onCancel={() => setStepUp(null)}
        onConfirm={reveal}
      />
      <DiscardChangesDialog
        open={discardToView}
        title={t('accounts.unsaved.title')}
        body={t('accounts.unsaved.body')}
        discardLabel={t('accounts.unsaved.discard')}
        onCancel={() => setDiscardToView(false)}
        onDiscard={backToView}
      />
      {deleteOpen && account
        ? (
            <DeleteAccountDialog
              account={account}
              onClose={() => setDeleteOpen(false)}
              onDeleted={() => {
                onDeleted?.()
                onClose()
              }}
              onOpenInstead={() => {
                setDeleteOpen(false)
                setTab('targets')
              }}
            />
          )
        : null}
    </>
  )
}

function ViewField({ label, value }: { label: string, value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="mb-1 text-[12px] text-muted-foreground">{label}</dt>
      <dd className="m-0 break-words">{value}</dd>
    </div>
  )
}

function RotationField({ value, current, onChange }: {
  value: RotationChoice
  current: string | null
  onChange: (next: RotationChoice) => void
}) {
  const { t, i18n } = useTranslation()
  const choices: RotationChoice[] = [...(current ? ['keep' as const] : []), 'd30', 'd90', 'd180', 'd365', 'never']
  const preview = resolveRotation(value, current)
  return (
    <Card className="p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor="account-rotation" className="mb-0">{t('accounts.form.rotation.label')}</Label>
          <div className="mt-0.5 text-[12px] text-muted-foreground">
            {preview
              ? t('accounts.form.rotation.dueOn', { date: formatDate(preview, i18n.language) })
              : t('accounts.form.rotation.hint')}
          </div>
        </div>
        <Select
          id="account-rotation"
          className="w-[180px] shrink-0"
          value={value}
          onValueChange={next => onChange(next as RotationChoice)}
          options={choices.map(choice => ({
            value: choice,
            label: choice === 'keep'
              ? t('accounts.form.rotation.keep', { date: formatDate(current, i18n.language) })
              : t(`accounts.form.rotation.${choice}`),
          }))}
        />
      </div>
    </Card>
  )
}
