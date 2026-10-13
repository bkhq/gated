import type { TargetWithAccounts } from '@/features/targets/hooks/use-targets-queries'
import type { Account, AccountKind, HttpFlavor, Target, TargetKind } from '@/shared/types/domain'
import type { InlineAuth } from '@/shared/types/drafts'
import { Plus, ShieldCheck, Trash2, X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AccountFormDialog } from '@/features/accounts/components'
import { useAccounts } from '@/features/accounts/hooks/use-accounts-queries'
import { useRoles } from '@/features/roles/hooks/use-roles-queries'
import { useTargetGroups } from '@/features/target-groups/hooks/use-target-groups-queries'
import { useCreateTarget, useTargetRoles, useUpdateTarget } from '@/features/targets/hooks/use-targets-queries'
import { DrawerFooter } from '@/shared/components/drawer-footer'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { Drawer } from '@/shared/ui/drawer'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { PasswordInput } from '@/shared/ui/password-input'
import { Select } from '@/shared/ui/select'
import { Switch } from '@/shared/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'
import { Textarea } from '@/shared/ui/textarea'
import { DeleteTargetDialog } from './delete-target-dialog'

export type TargetFormMode = 'create' | 'edit'

export interface TargetFormDrawerProps {
  open: boolean
  mode: TargetFormMode
  target: TargetWithAccounts | null
  onClose: () => void
  onDeleted?: () => void
  onSaved?: (target: Target) => void
}

const COMPATIBLE: Record<TargetKind, AccountKind[]> = {
  ssh: ['ssh-password', 'ssh-key'],
  mysql: ['db-password'],
  postgres: ['db-password'],
  http: ['http-headers', 'k8s-token', 'k8s-client-cert'],
}

function compatibleKinds(kind: TargetKind): AccountKind[] {
  return COMPATIBLE[kind] ?? []
}

function primaryAccountIdFromTarget(target: TargetWithAccounts | null): number | null {
  const primary = target?.accounts?.find(entry => entry.role === 'primary')
  return primary?.account_id ?? null
}

interface DraftState {
  name: string
  description: string
  kind: TargetKind
  group: string
  host: string
  port: number
  user: string
  readonly: boolean
  flavor: HttpFlavor
  // Credentials come from a bound account or are typed in on the target.
  authSource: 'account' | 'manual'
  authMethod: InlineAuth['method']
  password: string
  privateKey: string
  passphrase: string
  token: string
}

function defaultAuthMethod(kind: TargetKind): InlineAuth['method'] {
  return kind === 'http' ? 'none' : 'password'
}

const BLANK_SECRETS = { password: '', privateKey: '', passphrase: '', token: '' }

function inlineAuthFromDraft(draft: DraftState): InlineAuth {
  switch (draft.authMethod) {
    case 'key':
      return { method: 'key', privateKey: draft.privateKey, passphrase: draft.passphrase }
    case 'bearer':
      return { method: 'bearer', token: draft.token }
    case 'none':
      return { method: 'none' }
    case 'password':
      return { method: 'password', password: draft.password }
  }
}

const DEFAULT_PORTS: Record<TargetKind, number> = {
  ssh: 22,
  mysql: 3306,
  postgres: 5432,
  http: 443,
}

function emptyDraft(): DraftState {
  return {
    name: '',
    description: '',
    kind: 'ssh',
    group: '',
    host: '',
    port: DEFAULT_PORTS.ssh,
    user: '',
    readonly: false,
    flavor: 'generic',
    authSource: 'account',
    authMethod: defaultAuthMethod('ssh'),
    ...BLANK_SECRETS,
  }
}

function draftFromTarget(target: TargetWithAccounts): DraftState {
  return {
    name: target.name,
    description: target.description ?? '',
    kind: target.kind,
    group: target.group,
    host: target.host,
    port: target.port,
    user: target.user,
    readonly: !!target.readonly,
    flavor: target.flavor ?? 'generic',
    authSource: target.accounts?.length ? 'account' : 'manual',
    authMethod: target.inlineAuth?.method ?? defaultAuthMethod(target.kind),
    ...BLANK_SECRETS,
  }
}

type FormTab = 'general' | 'auth' | 'policy' | 'roles' | 'logs'

interface MissingField {
  label: string
  tab: FormTab
}

// A name and an address are always required. Credentials come either from a
// primary account binding or from inline fields; a blank inline secret is
// accepted when the stored secret of the same method can be kept.
function missingFields(draft: DraftState, primaryAccountId: number | null, canKeepSecret: boolean): MissingField[] {
  const missing: MissingField[] = []
  if (draft.name.trim() === '')
    missing.push({ label: 'fields.name', tab: 'general' })
  if (draft.host.trim() === '')
    missing.push({ label: draft.kind === 'http' ? 'targets.form.httpUrl' : 'targets.detail.overview.host', tab: 'general' })
  if (draft.kind !== 'http' && !isValidPort(draft.port))
    missing.push({ label: 'fields.port', tab: 'general' })
  if (draft.authSource === 'account') {
    if (primaryAccountId == null)
      missing.push({ label: 'targets.form.auth.selectorLabel', tab: 'auth' })
    return missing
  }
  if ((draft.kind === 'mysql' || draft.kind === 'postgres') && draft.user.trim() === '')
    missing.push({ label: 'targets.form.auth.username', tab: 'auth' })
  if (canKeepSecret)
    return missing
  if (draft.kind === 'ssh' && draft.authMethod === 'password' && draft.password === '')
    missing.push({ label: 'targets.form.auth.password', tab: 'auth' })
  if (draft.authMethod === 'key' && draft.privateKey.trim() === '')
    missing.push({ label: 'targets.form.auth.privateKey', tab: 'auth' })
  if (draft.authMethod === 'bearer' && draft.token === '')
    missing.push({ label: 'targets.form.auth.token', tab: 'auth' })
  return missing
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

export function TargetFormDrawer(props: TargetFormDrawerProps) {
  const { open, mode, target, onClose } = props
  return (
    <Drawer open={open} onClose={onClose} width={620}>
      <TargetFormDrawerBody key={`${mode}-${target?.id ?? 'new'}`} {...props} />
    </Drawer>
  )
}

function TargetFormDrawerBody({ mode, target, onClose, onDeleted, onSaved }: TargetFormDrawerProps) {
  const { t } = useTranslation()
  const roles = useRoles().data ?? []
  const groups = useTargetGroups().data ?? []
  const targetRolesQuery = useTargetRoles(mode === 'edit' ? target?.id : undefined)
  const createMutation = useCreateTarget()
  const updateMutation = useUpdateTarget()

  const [tab, setTab] = React.useState<FormTab>('general')
  const [draft, setDraft] = React.useState<DraftState>(() => (mode === 'edit' && target ? draftFromTarget(target) : emptyDraft()))
  const [primaryAccountId, setPrimaryAccountId] = React.useState<number | null>(() => primaryAccountIdFromTarget(target))
  const [grantedRoles, setGrantedRoles] = React.useState<Set<string>>(() => new Set())
  const [showErrors, setShowErrors] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  // Read endpoints never return secrets; an inline target edited with the
  // same method keeps its stored secret when the field is left blank.
  const canKeepSecret = mode === 'edit'
    && !target?.accounts?.length
    && target?.inlineAuth?.method === draft.authMethod
  const missing = missingFields(draft, primaryAccountId, canKeepSecret)
  const invalid = (label: string) => showErrors && missing.some(field => field.label === label)

  // Seed role toggles from the persisted target-role bindings once loaded
  // (render-time seeding keeps user toggles after the initial seed).
  const loadedRoles = targetRolesQuery.data
  const [seededFrom, setSeededFrom] = React.useState<typeof loadedRoles>(undefined)
  if (loadedRoles && loadedRoles !== seededFrom) {
    setSeededFrom(loadedRoles)
    setGrantedRoles(new Set(loadedRoles.map(role => role.id)))
  }

  function patch<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft(prev => ({ ...prev, [key]: value }))
  }

  function setKind(next: TargetKind) {
    setDraft(prev => ({
      ...prev,
      kind: next,
      port: prev.port === DEFAULT_PORTS[prev.kind] ? DEFAULT_PORTS[next] : prev.port,
      authMethod: defaultAuthMethod(next),
      ...BLANK_SECRETS,
    }))
    setPrimaryAccountId(null)
  }

  function toggleRole(roleId: string, checked: boolean) {
    setGrantedRoles((prev) => {
      const next = new Set(prev)
      if (checked) {
        next.add(roleId)
      }
      else {
        next.delete(roleId)
      }
      return next
    })
  }

  async function save() {
    const firstMissing = missing[0]
    if (firstMissing) {
      setShowErrors(true)
      setTab(firstMissing.tab)
      return
    }
    setFormError(null)
    const manual = draft.authSource === 'manual'
    // An empty list switches the target to inline credentials.
    const accounts = !manual && primaryAccountId != null
      ? [{ account_id: primaryAccountId, role: 'primary' as const }]
      : []
    const roleIds = [...grantedRoles]
    const base = {
      name: draft.name,
      kind: draft.kind,
      host: draft.host,
      port: Number(draft.port) || DEFAULT_PORTS[draft.kind],
      user: manual ? draft.user : '',
      group: draft.group,
      description: draft.description,
      readonly: draft.readonly,
      flavor: draft.kind === 'http' ? draft.flavor : undefined,
      accounts,
      inlineAuth: manual ? inlineAuthFromDraft(draft) : undefined,
    }
    try {
      if (mode === 'edit' && target) {
        const updated = await updateMutation.mutateAsync({ id: target.id, patch: base, roleIds })
        if (updated) {
          onSaved?.(updated)
        }
      }
      else {
        const created = await createMutation.mutateAsync({ ...base, roleIds })
        onSaved?.(created)
      }
    }
    catch (failure) {
      setFormError(failure instanceof Error ? failure.message : String(failure))
      return
    }
    onClose()
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-border px-6 py-5">
        <div>
          <h2 className="m-0 text-[17px] font-semibold">
            {mode === 'create' ? t('targets.form.titleNew') : draft.name || t('targets.form.titleEdit')}
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {mode === 'create' ? t('targets.form.descNew') : t('targets.form.descEdit')}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('actions.close')}>
          <X size={15} />
        </Button>
      </div>

      <div className="border-b border-border px-6 pt-2">
        <Tabs value={tab} onChange={next => setTab(next as typeof tab)}>
          <TabsList className="gap-1 bg-transparent p-0">
            {(['general', 'auth', 'policy', 'roles', ...(mode === 'edit' ? ['logs' as const] : [])] as const).map(value => (
              <TabsTrigger
                key={value}
                value={value}
                className={`h-9 rounded-none bg-transparent px-2.5 shadow-none ${tab === value ? 'border-b-2 border-foreground' : 'border-b-2 border-transparent'}`}
              >
                {t(`targets.form.tabs.${value}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
        {showErrors && missing.length > 0
          ? (
              <div role="alert" className="rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)] p-3 text-[12.5px] text-[hsl(var(--destructive))]">
                {t('targets.form.missing', { fields: missing.map(field => t(field.label)).join(', ') })}
              </div>
            )
          : null}
        {formError
          ? (
              <div role="alert" className="rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)] p-3 text-[12.5px] text-[hsl(var(--destructive))]">
                {formError}
              </div>
            )
          : null}
        <Tabs value={tab} onChange={next => setTab(next as typeof tab)}>
          <TabsContent value="general">
            <div className="flex flex-col gap-4">
              <div>
                <Label htmlFor="target-name">{t('fields.name')}</Label>
                <Input id="target-name" value={draft.name} onChange={event => patch('name', event.target.value)} placeholder="prod-api-01" aria-invalid={invalid('fields.name') || undefined} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="target-kind">{t('fields.protocol')}</Label>
                  <Select
                    id="target-kind"
                    value={draft.kind}
                    onValueChange={value => setKind(value as TargetKind)}
                    disabled={mode === 'edit'}
                    options={[
                      { value: 'ssh', label: 'SSH' },
                      { value: 'mysql', label: 'MySQL' },
                      { value: 'postgres', label: 'PostgreSQL' },
                      { value: 'http', label: 'HTTP' },
                    ]}
                  />
                </div>
                <div>
                  <Label htmlFor="target-group">{t('targets.detail.overview.group')}</Label>
                  <Select
                    id="target-group"
                    value={draft.group}
                    onValueChange={value => patch('group', value)}
                    placeholder={t('targets.form.groupNone')}
                    options={[
                      { value: '', label: t('targets.form.groupNone') },
                      ...groups.map(group => ({ value: group.id, label: group.name })),
                    ]}
                  />
                </div>
              </div>
              {draft.kind === 'http'
                ? (
                    <div>
                      <Label htmlFor="target-flavor">{t('targets.form.httpFlavor')}</Label>
                      <Select
                        id="target-flavor"
                        value={draft.flavor}
                        onValueChange={value => patch('flavor', value as HttpFlavor)}
                        options={[
                          { value: 'generic', label: t('targets.form.httpFlavorGeneric') },
                          { value: 'kubernetes', label: t('targets.form.httpFlavorKubernetes') },
                        ]}
                      />
                      <div className="mt-1.5 text-[12px] text-muted-foreground">{t('targets.form.httpFlavorHint')}</div>
                    </div>
                  )
                : null}
              {draft.kind === 'http'
                ? (
                    // HTTP targets are addressed by a full upstream URL (the scheme
                    // is part of the address — http vs https matters). Host+port
                    // would lose the scheme and silently force https.
                    <div>
                      <Label htmlFor="target-url">{t('targets.form.httpUrl')}</Label>
                      <Input id="target-url" className="mono" value={draft.host} onChange={event => patch('host', event.target.value)} placeholder="http://10.16.4.21:8080" aria-invalid={invalid('targets.form.httpUrl') || undefined} />
                      <div className="mt-1.5 text-[12px] text-muted-foreground">{t('targets.form.httpUrlHint')}</div>
                    </div>
                  )
                : (
                    <>
                      <div className="grid grid-cols-[2fr_1fr] gap-3">
                        <div>
                          <Label htmlFor="target-host">{t('targets.detail.overview.host')}</Label>
                          <Input id="target-host" value={draft.host} onChange={event => patch('host', event.target.value)} placeholder="10.16.4.21" aria-invalid={invalid('targets.detail.overview.host') || undefined} />
                        </div>
                        <div>
                          <Label htmlFor="target-port">{t('fields.port')}</Label>
                          <Input id="target-port" className="mono" value={draft.port} onChange={event => patch('port', Number(event.target.value) || 0)} aria-invalid={invalid('fields.port') || undefined} />
                        </div>
                      </div>
                    </>
                  )}
              <div>
                <Label htmlFor="target-description">{t('fields.description')}</Label>
                <Textarea
                  id="target-description"
                  rows={3}
                  value={draft.description}
                  onChange={event => patch('description', event.target.value)}
                  placeholder={t('targets.form.descriptionPlaceholder')}
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="auth">
            <div className="flex flex-col gap-4">
              <div>
                <Label htmlFor="target-auth-source">{t('targets.form.auth.source')}</Label>
                <Select
                  id="target-auth-source"
                  value={draft.authSource}
                  onValueChange={value => patch('authSource', value as DraftState['authSource'])}
                  options={[
                    { value: 'account', label: t('targets.form.auth.sourceAccount') },
                    { value: 'manual', label: t('targets.form.auth.sourceManual') },
                  ]}
                />
              </div>
              {draft.authSource === 'account'
                ? (
                    <AccountSelect
                      targetKind={draft.kind}
                      value={primaryAccountId}
                      onChange={setPrimaryAccountId}
                      invalid={invalid('targets.form.auth.selectorLabel')}
                    />
                  )
                : (
                    <ManualAuthFields
                      draft={draft}
                      patch={patch}
                      invalid={invalid}
                      canKeepSecret={canKeepSecret}
                    />
                  )}
            </div>
          </TabsContent>

          <TabsContent value="policy">
            <div className="flex flex-col gap-4">
              <Card className="flex flex-col gap-3 p-3.5">
                <Row2 label={t('targets.form.policy.readOnly')} hint={t('targets.form.policy.readOnlyHint')}>
                  <Switch checked={draft.readonly} onCheckedChange={value => patch('readonly', value)} aria-label={t('targets.form.policy.readOnly')} />
                </Row2>
              </Card>
              {draft.kind === 'ssh' || draft.kind === 'http'
                ? <p className="m-0 text-[12px] text-muted-foreground">{t('targets.form.policy.readOnlyDbOnly')}</p>
                : null}
            </div>
          </TabsContent>

          <TabsContent value="roles">
            <p className="mb-3 mt-0 text-[12.5px] text-muted-foreground">{t('targets.form.rolesHint')}</p>
            {mode === 'edit' && targetRolesQuery.isLoading
              ? <p className="text-[13px] text-muted-foreground">{t('states.loading')}</p>
              : (
                  <Card className="p-0">
                    {roles.map((role, index) => (
                      <div
                        key={role.id}
                        className="flex items-center gap-2.5 p-3"
                        style={{ borderTop: index === 0 ? 'none' : '1px solid hsl(var(--border))' }}
                      >
                        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-secondary">
                          <ShieldCheck size={14} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px] font-medium">{role.name}</div>
                          <div className="text-[12px] text-muted-foreground">{role.description}</div>
                        </div>
                        <Switch
                          checked={grantedRoles.has(role.id)}
                          onCheckedChange={checked => toggleRole(role.id, checked)}
                          aria-label={role.name}
                        />
                      </div>
                    ))}
                  </Card>
                )}
          </TabsContent>

          <TabsContent value="logs">
            <div className="flex flex-col gap-2">
              <p className="text-[13px] text-muted-foreground">{t('targets.form.logs.empty')}</p>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <DrawerFooter
        leftAction={mode === 'edit'
          ? (
              <Button variant="ghost" size="sm" className="text-[hsl(var(--destructive))]" onClick={() => setDeleteOpen(true)}>
                <Trash2 size={13} />
                <span>{t('actions.delete')}</span>
              </Button>
            )
          : undefined}
        onCancel={onClose}
        onSave={() => { void save() }}
        isPending={createMutation.isPending || updateMutation.isPending}
      />
      {mode === 'edit'
        ? (
            <DeleteTargetDialog
              target={deleteOpen ? target : null}
              onClose={() => setDeleteOpen(false)}
              onDeleted={() => {
                onDeleted?.()
                onClose()
              }}
            />
          )
        : null}
    </div>
  )
}

function Row2({ label, hint, children }: { label: string, hint?: string, children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium">{label}</div>
        {hint ? <div className="mt-0.5 text-[12px] text-muted-foreground">{hint}</div> : null}
      </div>
      {children}
    </div>
  )
}

interface ManualAuthFieldsProps {
  draft: DraftState
  patch: <K extends keyof DraftState>(key: K, value: DraftState[K]) => void
  invalid: (label: string) => boolean
  canKeepSecret: boolean
}

function ManualAuthFields({ draft, patch, invalid, canKeepSecret }: ManualAuthFieldsProps) {
  const { t } = useTranslation()
  const secretPlaceholder = canKeepSecret ? t('targets.form.auth.keepSecret') : undefined
  const methods: InlineAuth['method'][] = draft.kind === 'ssh'
    ? ['password', 'key']
    : draft.kind === 'http' ? ['none', 'bearer'] : []

  return (
    <div className="flex flex-col gap-4">
      {draft.kind !== 'http'
        ? (
            <div>
              <Label htmlFor="target-user">{t('targets.form.auth.username')}</Label>
              <Input id="target-user" value={draft.user} onChange={event => patch('user', event.target.value)} placeholder="deploy" aria-invalid={invalid('targets.form.auth.username') || undefined} />
              {draft.kind === 'ssh'
                ? <div className="mt-1.5 text-[12px] text-muted-foreground">{t('targets.form.auth.usernameSshHint')}</div>
                : null}
            </div>
          )
        : null}
      {methods.length > 0
        ? (
            <div>
              <Label htmlFor="target-auth-method">{t('targets.form.auth.methodLabel')}</Label>
              <Select
                id="target-auth-method"
                value={draft.authMethod}
                onValueChange={value => patch('authMethod', value as InlineAuth['method'])}
                options={methods.map(method => ({ value: method, label: t(`targets.form.auth.methods.${method}`) }))}
              />
            </div>
          )
        : null}
      {draft.authMethod === 'password'
        ? (
            <div>
              <Label htmlFor="target-password">{t('targets.form.auth.password')}</Label>
              <PasswordInput id="target-password" autoComplete="new-password" value={draft.password} onChange={event => patch('password', event.target.value)} placeholder={secretPlaceholder} aria-invalid={invalid('targets.form.auth.password') || undefined} />
            </div>
          )
        : null}
      {draft.authMethod === 'key'
        ? (
            <>
              <div>
                <Label htmlFor="target-private-key">{t('targets.form.auth.privateKey')}</Label>
                <Textarea id="target-private-key" className="mono" rows={6} value={draft.privateKey} onChange={event => patch('privateKey', event.target.value)} placeholder={secretPlaceholder ?? '-----BEGIN OPENSSH PRIVATE KEY-----'} aria-invalid={invalid('targets.form.auth.privateKey') || undefined} />
              </div>
              <div>
                <Label htmlFor="target-passphrase">{t('targets.form.auth.passphrase')}</Label>
                <PasswordInput id="target-passphrase" autoComplete="new-password" value={draft.passphrase} onChange={event => patch('passphrase', event.target.value)} placeholder={secretPlaceholder} />
              </div>
            </>
          )
        : null}
      {draft.authMethod === 'bearer'
        ? (
            <div>
              <Label htmlFor="target-token">{t('targets.form.auth.token')}</Label>
              <PasswordInput id="target-token" autoComplete="off" value={draft.token} onChange={event => patch('token', event.target.value)} placeholder={secretPlaceholder} aria-invalid={invalid('targets.form.auth.token') || undefined} />
            </div>
          )
        : null}
    </div>
  )
}

interface AccountSelectProps {
  targetKind: TargetKind
  value: number | null
  onChange: (next: number | null) => void
  invalid?: boolean
}

function AccountSelect({ targetKind, value, onChange, invalid }: AccountSelectProps) {
  const { t } = useTranslation()
  const allowed = compatibleKinds(targetKind)
  const accountsQuery = useAccounts()
  const compatible = React.useMemo(
    () => (accountsQuery.data ?? []).filter(account => allowed.includes(account.kind)),
    [accountsQuery.data, allowed],
  )
  const [createOpen, setCreateOpen] = React.useState(false)
  const selected = value != null
    ? compatible.find(account => Number.parseInt(account.id, 10) === value) ?? null
    : null

  if (compatible.length === 0) {
    return (
      <>
        <Card className="flex flex-col gap-2 p-3.5">
          <div className="text-[13.5px] font-medium">{t('targets.form.auth.empty.title')}</div>
          <div className="text-[12px] text-muted-foreground">{t('targets.form.auth.empty.body')}</div>
          {invalid ? <div className="text-[12px] text-[hsl(var(--destructive))]">{t('targets.form.auth.required')}</div> : null}
          <div>
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus size={13} />
              <span>{t('targets.form.auth.empty.create')}</span>
            </Button>
          </div>
        </Card>
        <AccountFormDialog
          open={createOpen}
          mode="create"
          account={null}
          allowedKinds={allowed}
          onClose={() => setCreateOpen(false)}
          onSaved={(account: Account) => {
            if (allowed.includes(account.kind)) {
              const numeric = Number.parseInt(account.id, 10)
              if (Number.isFinite(numeric))
                onChange(numeric)
            }
          }}
        />
      </>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Label htmlFor="target-primary-account">{t('targets.form.auth.selectorLabel')}</Label>
        <Select
          id="target-primary-account"
          value={value != null ? String(value) : ''}
          onValueChange={(next) => {
            if (!next) {
              onChange(null)
              return
            }
            const numeric = Number.parseInt(next, 10)
            onChange(Number.isFinite(numeric) ? numeric : null)
          }}
          placeholder={t('targets.form.auth.selectorPlaceholder')}
          options={compatible.map(account => ({
            value: account.id,
            label: `${account.name} · ${t(`accounts.credLabels.${account.kind}`)}`,
          }))}
        />
        {invalid ? <div className="mt-1.5 text-[12px] text-[hsl(var(--destructive))]">{t('targets.form.auth.required')}</div> : null}
      </div>
      {selected
        ? (
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-muted-foreground">{selected.name}</span>
              <Badge tone="outline">{t(`accounts.credLabels.${selected.kind}`)}</Badge>
            </div>
          )
        : null}
    </div>
  )
}
