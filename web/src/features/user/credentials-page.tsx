import type { OtpDevice, PublicKey } from '@/shared/types/domain'
import type { UserIdentity } from '@/store/app-store'
import { useQuery } from '@tanstack/react-query'
import {
  Copy,
  Edit3,
  Eye,
  EyeOff,
  Globe,
  Key,
  Mail,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
  X,
} from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useOtpDevices, useRemoveOtpDevice } from '@/features/otp/hooks/use-otp-queries'
import { OtpEnrollmentDrawer } from '@/features/otp/otp-enrollment-drawer'
import { usePublicKeys, useRegisterPublicKey, useRemovePublicKey } from '@/features/public-keys/hooks/use-public-keys-queries'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { StatusDot } from '@/shared/components/status-dot'
import { useIsAdmin } from '@/shared/hooks/use-info'
import { profileApi } from '@/shared/lib/api/profile'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { Drawer } from '@/shared/ui/drawer'
import { Input } from '@/shared/ui/input'
import { Textarea } from '@/shared/ui/textarea'
import { useAppStore } from '@/store/app-store'
import {
  ConfirmDialog,
  FieldGroup,
  ListSkeleton,
  RowMenu,
} from './_credential-primitives'
import { fieldAria, useReturnFocusOnClose } from './_credential-utils'

interface KeyDrawerState {
  mode: 'create' | 'rename'
  key: PublicKey | null
}

interface OtpDrawerState {
  mode: 'create' | 'rename'
  device: OtpDevice | null
}

export function CredentialsPage() {
  const { t } = useTranslation()
  const identity = useAppStore(state => state.identity)

  return (
    <>
      <PageHeader
        title={t('user.credentials.title')}
        description={t('user.credentials.description')}
      />

      <div className="flex flex-col gap-4 px-6 pb-6 pt-4">
        <IdentityCard identity={identity} />
        <div className="grid gap-4 lg:grid-cols-2">
          <PasswordCard className="lg:col-span-2" />
          <SshKeysCard />
          <OtpDevicesCard />
          <SsoBindingsCard />
        </div>
      </div>
    </>
  )
}

// ===========================================================================
// Identity card
// ===========================================================================

function IdentityCard({ identity }: { identity: UserIdentity }) {
  const { t } = useTranslation()
  const isAdmin = useIsAdmin()
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-4 p-4">
        <Avatar name={identity.name} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold">{identity.name}</span>
            <Badge tone={isAdmin ? 'info' : 'mono'}>{identity.role}</Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[12.5px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Mail size={12} aria-hidden="true" />
              {identity.email}
            </span>
            <span aria-hidden="true">·</span>
            <span className="mono">{identity.username}</span>
          </div>
        </div>
        <Badge tone="success">
          <StatusDot tone="success" />
          <span>{t('user.credentials.identity.active')}</span>
        </Badge>
        <Badge tone="outline">{t('user.credentials.identity.local')}</Badge>
      </CardContent>
    </Card>
  )
}

// ===========================================================================
// Password
// ===========================================================================

function PasswordCard({ className }: { className?: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)

  return (
    <Card className={className}>
      <CardHeader>
        <div>
          <CardTitle>{t('user.credentials.password.title')}</CardTitle>
          <CardDescription>{t('user.credentials.password.description')}</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Edit3 size={13} aria-hidden="true" />
          <span>{t('user.credentials.password.change')}</span>
        </Button>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('user.credentials.password.lastChanged')} value="2026-02-19 · 87 days ago" />
          <Field label={t('user.credentials.password.policy')} value={t('user.credentials.password.policyValue')} />
        </div>
      </CardContent>
      <PasswordDrawer open={open} onClose={() => setOpen(false)} />
    </Card>
  )
}

function Field({ label, value }: { label: string, value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
      <span className="text-[13.5px]">{value}</span>
    </div>
  )
}

interface PasswordDraft {
  current: string
  next: string
  confirm: string
}

function PasswordDrawer(props: { open: boolean, onClose: () => void }) {
  if (!props.open) {
    return null
  }
  return <PasswordDrawerBody {...props} />
}

function PasswordDrawerBody({ onClose }: { onClose: () => void }) {
  useReturnFocusOnClose()
  const { t } = useTranslation()
  const titleId = React.useId()
  const [draft, setDraft] = React.useState<PasswordDraft>(() => ({ current: '', next: '', confirm: '' }))
  const [touched, setTouched] = React.useState<Partial<Record<keyof PasswordDraft, boolean>>>(() => ({}))
  const [reveal, setReveal] = React.useState(false)

  const errors = React.useMemo<Partial<Record<keyof PasswordDraft, string>>>(() => {
    const e: Partial<Record<keyof PasswordDraft, string>> = {}
    if (!draft.current) {
      e.current = t('profile.auth.pwDrawer.validate.currentRequired')
    }
    if (!draft.next) {
      e.next = t('profile.auth.pwDrawer.validate.newRequired')
    }
    else if (draft.next.length < 12) {
      e.next = t('profile.auth.pwDrawer.validate.newTooShort')
    }
    else if (!/[a-z]/u.test(draft.next) || !/[A-Z]/u.test(draft.next) || !/\d/u.test(draft.next)) {
      e.next = t('profile.auth.pwDrawer.validate.newWeak')
    }
    else if (draft.next === draft.current && draft.current) {
      e.next = t('profile.auth.pwDrawer.validate.sameAsCurrent')
    }
    if (!draft.confirm) {
      e.confirm = t('profile.auth.pwDrawer.validate.confirmMismatch')
    }
    else if (draft.confirm !== draft.next) {
      e.confirm = t('profile.auth.pwDrawer.validate.confirmMismatch')
    }
    return e
  }, [draft, t])

  const valid = Object.keys(errors).length === 0

  function submit() {
    setTouched({ current: true, next: true, confirm: true })
    if (!valid) {
      return
    }
    onClose()
  }

  function showError(key: keyof PasswordDraft) {
    return touched[key] ? errors[key] : undefined
  }

  return (
    <Drawer open onClose={onClose} width={520}>
      <div className="flex h-full flex-col" role="region" aria-labelledby={titleId}>
        <div className="flex items-start justify-between gap-3 border-b border-border px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary text-foreground" aria-hidden="true">
              <ShieldCheck size={18} />
            </div>
            <div>
              <h2 id={titleId} className="m-0 text-[17px] font-semibold">{t('profile.auth.pwDrawer.title')}</h2>
              <p className="mt-0.5 text-[13px] text-muted-foreground">{t('profile.auth.pwDrawer.description')}</p>
            </div>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('actions.close')}>
            <X size={15} aria-hidden="true" />
          </Button>
        </div>

        <form
          className="flex flex-1 flex-col gap-4 overflow-y-auto p-6"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <FieldGroup label={t('profile.auth.pwDrawer.current')} error={showError('current')} htmlFor="ucr-pw-current" required>
            <Input
              id="ucr-pw-current"
              type={reveal ? 'text' : 'password'}
              value={draft.current}
              onChange={event => setDraft(prev => ({ ...prev, current: event.target.value }))}
              onBlur={() => setTouched(prev => ({ ...prev, current: true }))}
              aria-invalid={showError('current') ? true : undefined}
              {...fieldAria('ucr-pw-current', true, !!showError('current'))}
              suffix={(
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={reveal ? t('a11y.profile.passwordHide') : t('a11y.profile.passwordShow')}
                  aria-pressed={reveal}
                  onClick={() => setReveal(value => !value)}
                >
                  {reveal ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                </Button>
              )}
            />
          </FieldGroup>
          <FieldGroup label={t('profile.auth.pwDrawer.new')} error={showError('next')} htmlFor="ucr-pw-new" required>
            <Input
              id="ucr-pw-new"
              type={reveal ? 'text' : 'password'}
              value={draft.next}
              onChange={event => setDraft(prev => ({ ...prev, next: event.target.value }))}
              onBlur={() => setTouched(prev => ({ ...prev, next: true }))}
              aria-invalid={showError('next') ? true : undefined}
              {...fieldAria('ucr-pw-new', true, !!showError('next'))}
            />
          </FieldGroup>
          <FieldGroup label={t('profile.auth.pwDrawer.confirm')} error={showError('confirm')} htmlFor="ucr-pw-confirm" required>
            <Input
              id="ucr-pw-confirm"
              type={reveal ? 'text' : 'password'}
              value={draft.confirm}
              onChange={event => setDraft(prev => ({ ...prev, confirm: event.target.value }))}
              onBlur={() => setTouched(prev => ({ ...prev, confirm: true }))}
              aria-invalid={showError('confirm') ? true : undefined}
              {...fieldAria('ucr-pw-confirm', true, !!showError('confirm'))}
            />
          </FieldGroup>
          <button type="submit" hidden />
        </form>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-card px-6 py-3">
          <Button variant="outline" onClick={onClose}>{t('actions.cancel')}</Button>
          <Button onClick={submit} disabled={!valid}>{t('actions.save')}</Button>
        </div>
      </div>
    </Drawer>
  )
}

// ===========================================================================
// SSH keys
// ===========================================================================

function SshKeysCard() {
  const { t } = useTranslation()
  const keysQuery = usePublicKeys()
  const removeMutation = useRemovePublicKey()
  const keys = keysQuery.data ?? []

  const [drawer, setDrawer] = React.useState<KeyDrawerState | null>(null)
  const [pendingRemove, setPendingRemove] = React.useState<PublicKey | null>(null)
  const [liveMsg, setLiveMsg] = React.useState('')

  const copyFingerprint = (key: PublicKey) => {
    void navigator.clipboard?.writeText(key.fingerprint)
    setLiveMsg(t('user.credentials.copiedFingerprint'))
    window.setTimeout(setLiveMsg, 1500, '')
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t('profile.auth.sshKeys')}</CardTitle>
          <CardDescription>{t('profile.auth.sshKeysHint')}</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setDrawer({ mode: 'create', key: null })}>
          <Plus size={13} aria-hidden="true" />
          <span>{t('profile.auth.addKey')}</span>
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {keysQuery.isLoading
          ? <ListSkeleton className="px-5 pb-5" />
          : keys.length === 0
            ? (
                <div className="p-5">
                  <EmptyState
                    icon={Key}
                    title={t('profile.auth.noKeys')}
                    description={t('profile.auth.noKeysHint')}
                  />
                </div>
              )
            : (
                <ul className="m-0 list-none divide-y divide-border p-0">
                  {keys.map(key => (
                    <li key={key.id} className="flex items-center gap-3 px-5 py-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary text-foreground" aria-hidden="true">
                        <Key size={14} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[13.5px] font-medium">{key.name}</span>
                        </div>
                        <div className="mono truncate text-[11px] text-muted-foreground">{key.fingerprint}</div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {t('profile.auth.added', { when: key.added })}
                          {' · '}
                          {t('profile.auth.lastUsed', { when: key.lastUsed })}
                        </div>
                      </div>
                      <RowMenu
                        label={t('user.credentials.sshKeys.rowMenu', { name: key.name })}
                        items={[
                          { label: t('profile.actions.copy'), icon: Copy, onClick: () => copyFingerprint(key) },
                          'separator' as const,
                          { label: t('profile.actions.remove'), icon: Trash2, danger: true, onClick: () => setPendingRemove(key) },
                        ]}
                      />
                    </li>
                  ))}
                </ul>
              )}
      </CardContent>

      <span className="sr-only" role="status" aria-live="polite">{liveMsg}</span>

      <KeyDrawer state={drawer} onClose={() => setDrawer(null)} />

      <ConfirmDialog
        open={pendingRemove !== null}
        title={t('profile.auth.removeKey.title')}
        body={pendingRemove ? t('profile.auth.removeKey.body', { name: pendingRemove.name }) : ''}
        confirmLabel={t('profile.actions.remove')}
        destructive
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          if (pendingRemove) {
            void removeMutation.mutateAsync(pendingRemove.id)
          }
          setPendingRemove(null)
        }}
      />
    </Card>
  )
}

interface KeyDraft {
  name: string
  material: string
}

function KeyDrawer({ state, onClose }: { state: KeyDrawerState | null, onClose: () => void }) {
  if (!state) {
    return null
  }
  return <KeyDrawerBody state={state} onClose={onClose} />
}

function KeyDrawerBody({ state, onClose }: { state: KeyDrawerState, onClose: () => void }) {
  useReturnFocusOnClose()
  const { t } = useTranslation()
  const titleId = React.useId()
  const registerMutation = useRegisterPublicKey()

  const mode = state.mode

  const [draft, setDraft] = React.useState<KeyDraft>(() => (state.mode === 'rename' && state.key
    ? { name: state.key.name, material: '' }
    : { name: '', material: '' }))
  const [touched, setTouched] = React.useState<Partial<Record<keyof KeyDraft, boolean>>>(() => ({}))
  const [discardOpen, setDiscardOpen] = React.useState(false)

  const errors = React.useMemo<Partial<Record<keyof KeyDraft, string>>>(() => {
    const e: Partial<Record<keyof KeyDraft, string>> = {}
    if (!draft.name.trim()) {
      e.name = t('profile.auth.keyDrawer.validate.labelRequired')
    }
    if (mode === 'create') {
      const m = draft.material.trim()
      if (!m) {
        e.material = t('profile.auth.keyDrawer.validate.materialRequired')
      }
      else if (!/^(?:ssh-ed25519|ssh-rsa|ecdsa-)/u.test(m)) {
        e.material = t('profile.auth.keyDrawer.validate.materialInvalid')
      }
    }
    return e
  }, [draft, mode, t])

  const valid = Object.keys(errors).length === 0
  const dirty = mode === 'create'
    ? draft.name.trim() !== '' || draft.material.trim() !== ''
    : state.key
      ? draft.name !== state.key.name
      : false

  function submit() {
    setTouched({ name: true, material: true })
    if (!valid) {
      return
    }
    if (mode === 'create') {
      void registerMutation.mutateAsync({ name: draft.name.trim(), material: draft.material.trim() })
    }
    onClose()
  }

  function attemptClose() {
    if (dirty) {
      setDiscardOpen(true)
      return
    }
    onClose()
  }

  function showError(key: keyof KeyDraft) {
    return touched[key] ? errors[key] : undefined
  }

  return (
    <>
      <Drawer open onClose={attemptClose} width={560}>
        <div className="flex h-full flex-col" role="region" aria-labelledby={titleId}>
          <div className="flex items-start justify-between gap-3 border-b border-border px-6 py-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary text-foreground" aria-hidden="true">
                <Key size={18} />
              </div>
              <div>
                <h2 id={titleId} className="m-0 text-[17px] font-semibold">
                  {mode === 'create' ? t('profile.auth.keyDrawer.titleNew') : t('profile.auth.keyDrawer.titleEdit')}
                </h2>
                {mode === 'create'
                  ? <p className="mt-0.5 text-[13px] text-muted-foreground">{t('profile.auth.keyDrawer.description')}</p>
                  : null}
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={attemptClose} aria-label={t('actions.close')}>
              <X size={15} aria-hidden="true" />
            </Button>
          </div>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
            <FieldGroup label={t('profile.auth.keyDrawer.label')} error={showError('name')} htmlFor="ucr-key-label" required>
              <Input
                id="ucr-key-label"
                placeholder={t('profile.auth.keyDrawer.labelPlaceholder')}
                value={draft.name}
                onChange={event => setDraft(prev => ({ ...prev, name: event.target.value }))}
                onBlur={() => setTouched(prev => ({ ...prev, name: true }))}
                aria-invalid={showError('name') ? true : undefined}
                {...fieldAria('ucr-key-label', true, !!showError('name'))}
              />
            </FieldGroup>
            {mode === 'create'
              ? (
                  <FieldGroup label={t('profile.auth.keyDrawer.material')} error={showError('material')} htmlFor="ucr-key-material" required>
                    <Textarea
                      id="ucr-key-material"
                      rows={6}
                      className="mono"
                      placeholder={t('profile.auth.keyDrawer.materialPlaceholder')}
                      value={draft.material}
                      onChange={event => setDraft(prev => ({ ...prev, material: event.target.value }))}
                      onBlur={() => setTouched(prev => ({ ...prev, material: true }))}
                      aria-invalid={showError('material') ? true : undefined}
                      {...fieldAria('ucr-key-material', true, !!showError('material'))}
                    />
                  </FieldGroup>
                )
              : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border bg-card px-6 py-3">
            <Button variant="outline" onClick={attemptClose}>{t('actions.cancel')}</Button>
            <Button onClick={submit} disabled={!valid || (mode === 'rename' && !dirty)}>
              {mode === 'create' ? t('profile.auth.addKey') : t('actions.save')}
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

// ===========================================================================
// OTP devices
// ===========================================================================

function OtpDevicesCard() {
  const { t } = useTranslation()
  const devicesQuery = useOtpDevices()
  const removeMutation = useRemoveOtpDevice()
  const devices = devicesQuery.data ?? []

  const [drawer, setDrawer] = React.useState<OtpDrawerState | null>(null)
  const [pendingRemove, setPendingRemove] = React.useState<OtpDevice | null>(null)

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t('profile.auth.otp')}</CardTitle>
          <CardDescription>{t('profile.auth.otpHint')}</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => setDrawer({ mode: 'create', device: null })}>
          <Plus size={13} aria-hidden="true" />
          <span>{t('profile.auth.addOtp')}</span>
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {devicesQuery.isLoading
          ? <ListSkeleton className="px-5 pb-5" />
          : devices.length === 0
            ? (
                <div className="p-5">
                  <EmptyState
                    icon={Smartphone}
                    title={t('profile.auth.noOtp')}
                    description={t('profile.auth.noOtpHint')}
                  />
                </div>
              )
            : (
                <ul className="m-0 list-none divide-y divide-border p-0">
                  {devices.map(device => (
                    <li key={device.id} className="flex items-center gap-3 px-5 py-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary text-foreground" aria-hidden="true">
                        <Smartphone size={14} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13.5px] font-medium">{device.name}</div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          {t('profile.auth.added', { when: device.added })}
                        </div>
                      </div>
                      <RowMenu
                        label={t('user.credentials.otp.rowMenu', { name: device.name })}
                        items={[
                          { label: t('profile.actions.remove'), icon: Trash2, danger: true, onClick: () => setPendingRemove(device) },
                        ]}
                      />
                    </li>
                  ))}
                </ul>
              )}
      </CardContent>

      <OtpDrawer state={drawer} onClose={() => setDrawer(null)} />

      <RemoveOtpDialog
        device={pendingRemove}
        isLast={devices.length === 1 && pendingRemove !== null}
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          if (pendingRemove) {
            void removeMutation.mutateAsync(pendingRemove.id)
          }
          setPendingRemove(null)
        }}
      />
    </Card>
  )
}

function OtpDrawer({ state, onClose }: { state: OtpDrawerState | null, onClose: () => void }) {
  return state ? <OtpEnrollmentDrawer onClose={onClose} /> : null
}

function RemoveOtpDialog({ device, isLast, onCancel, onConfirm }: {
  device: OtpDevice | null
  isLast: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!device) {
    return null
  }
  return <RemoveOtpDialogBody device={device} isLast={isLast} onCancel={onCancel} onConfirm={onConfirm} />
}

function RemoveOtpDialogBody({ device, isLast, onCancel, onConfirm }: {
  device: OtpDevice
  isLast: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  const [accepted, setAccepted] = React.useState(false)
  const checkboxId = React.useId()

  return (
    <Dialog open onClose={onCancel} width={480}>
      <DialogHeader
        title={t('profile.auth.removeOtp.title')}
        description={t('profile.auth.removeOtp.body', { name: device.name })}
        onClose={onCancel}
      />
      {isLast
        ? (
            <DialogBody>
              <div className="rounded-md border border-[hsl(var(--destructive)/0.35)] bg-[hsl(var(--destructive)/0.08)] p-3 text-[13px]">
                <div className="flex items-center gap-2 font-semibold text-[hsl(var(--destructive))]">
                  <ShieldAlert size={14} aria-hidden="true" />
                  {t('profile.auth.removeOtp.lastWarningTitle')}
                </div>
                <p className="mt-1 text-muted-foreground">{t('profile.auth.removeOtp.lastWarningBody')}</p>
                <label htmlFor={checkboxId} className="mt-3 flex items-center gap-2 text-[13px] text-foreground">
                  <input
                    id={checkboxId}
                    type="checkbox"
                    className="size-4 cursor-pointer accent-[hsl(var(--destructive))]"
                    checked={accepted}
                    onChange={event => setAccepted(event.target.checked)}
                  />
                  <span>{t('profile.auth.removeOtp.lastConfirm')}</span>
                </label>
              </div>
            </DialogBody>
          )
        : null}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>{t('actions.cancel')}</Button>
        <Button variant="destructive" onClick={onConfirm} disabled={isLast && !accepted}>
          {t('profile.actions.remove')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

// ===========================================================================
// SSO bindings
// ===========================================================================

function SsoBindingsCard() {
  const { t } = useTranslation()
  const bindingsQuery = useQuery({ queryKey: ['sso-bindings'], queryFn: async ({ signal }) => profileApi.sso.list(signal) })
  const bindings = bindingsQuery.data ?? []
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t('user.credentials.sso.title')}</CardTitle>
          <CardDescription>{t('user.credentials.sso.description')}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {bindingsQuery.isLoading
          ? <ListSkeleton />
          : bindings.length === 0
            ? <EmptyState icon={Globe} title={t('user.credentials.sso.empty')} />
            : bindings.map(binding => (
                <div key={binding.id} className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary text-foreground" aria-hidden="true">
                    <Globe size={15} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-medium">{binding.provider ?? t('user.credentials.sso.anyProvider')}</div>
                    <div className="mono mt-0.5 truncate text-[11.5px] text-muted-foreground">{binding.email}</div>
                  </div>
                </div>
              ))}
      </CardContent>
    </Card>
  )
}
