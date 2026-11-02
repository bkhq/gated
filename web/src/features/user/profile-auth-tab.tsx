import type { OtpDevice, PublicKey } from '@/shared/types/domain'
import { useMutation } from '@tanstack/react-query'
import {
  Copy,
  Eye,
  EyeOff,
  Key,
  Plus,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
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
import { profileApi } from '@/shared/lib/api/profile'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { Drawer } from '@/shared/ui/drawer'
import { Input } from '@/shared/ui/input'
import { Textarea } from '@/shared/ui/textarea'
import { ConfirmDialog, FieldGroup, ListSkeleton, RowMenu } from './profile-shared'
import { fieldAria, useReturnFocusOnClose } from './profile-utils'

interface KeyDrawerState {
  mode: 'create' | 'rename'
  key: PublicKey | null
}

interface OtpDrawerState {
  mode: 'create' | 'rename'
  device: OtpDevice | null
}

export function AuthTab() {
  const { t } = useTranslation()
  const publicKeysQuery = usePublicKeys()
  const otpDevicesQuery = useOtpDevices()
  const removeKeyMutation = useRemovePublicKey()
  const removeOtpMutation = useRemoveOtpDevice()

  const publicKeys = publicKeysQuery.data ?? []
  const otpDevices = otpDevicesQuery.data ?? []

  const [pwOpen, setPwOpen] = React.useState(false)
  const [keyDrawer, setKeyDrawer] = React.useState<KeyDrawerState | null>(null)
  const [otpDrawer, setOtpDrawer] = React.useState<OtpDrawerState | null>(null)
  const [pendingKey, setPendingKey] = React.useState<PublicKey | null>(null)
  const [pendingOtp, setPendingOtp] = React.useState<OtpDevice | null>(null)

  const otpIsLast = otpDevices.length === 1

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader>
          <div>
            <CardTitle>{t('profile.auth.password')}</CardTitle>
            <CardDescription>{t('profile.auth.passwordPolicy')}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setPwOpen(true)}>
            <ShieldOff size={13} aria-hidden="true" />
            <span>{t('profile.auth.passwordChange')}</span>
          </Button>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary" aria-hidden="true">
              <ShieldCheck size={14} />
            </div>
            <div>
              <div className="text-[13.5px] font-medium">{t('profile.auth.password')}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t('profile.auth.sshKeys')}</CardTitle>
            <CardDescription>{t('profile.auth.sshKeysHint')}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setKeyDrawer({ mode: 'create', key: null })}>
            <Plus size={13} aria-hidden="true" />
            <span>{t('profile.auth.addKey')}</span>
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {publicKeysQuery.isLoading
            ? <ListSkeleton className="px-5 pb-5" />
            : publicKeys.length === 0
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
                    {publicKeys.map(key => (
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
                          items={[
                            { label: t('profile.actions.copy'), icon: Copy, onClick: () => void navigator.clipboard.writeText(key.fingerprint) },
                            'separator' as const,
                            { label: t('profile.actions.remove'), icon: Trash2, danger: true, onClick: () => setPendingKey(key) },
                          ]}
                        />
                      </li>
                    ))}
                  </ul>
                )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t('profile.auth.otp')}</CardTitle>
            <CardDescription>{t('profile.auth.otpHint')}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setOtpDrawer({ mode: 'create', device: null })}>
            <Plus size={13} aria-hidden="true" />
            <span>{t('profile.auth.addOtp')}</span>
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {otpDevicesQuery.isLoading
            ? <ListSkeleton className="px-5 pb-5" />
            : otpDevices.length === 0
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
                    {otpDevices.map(device => (
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
                          items={[
                            { label: t('profile.actions.remove'), icon: Trash2, danger: true, onClick: () => setPendingOtp(device) },
                          ]}
                        />
                      </li>
                    ))}
                  </ul>
                )}
        </CardContent>
      </Card>

      <PasswordDrawer open={pwOpen} onClose={() => setPwOpen(false)} />

      <KeyDrawer
        state={keyDrawer}
        onClose={() => setKeyDrawer(null)}
      />

      <OtpDrawer
        state={otpDrawer}
        onClose={() => setOtpDrawer(null)}
      />

      <ConfirmDialog
        open={pendingKey !== null}
        title={t('profile.auth.removeKey.title')}
        body={pendingKey ? t('profile.auth.removeKey.body', { name: pendingKey.name }) : ''}
        confirmLabel={t('profile.actions.remove')}
        destructive
        onCancel={() => setPendingKey(null)}
        onConfirm={() => {
          if (pendingKey) {
            void removeKeyMutation.mutateAsync(pendingKey.id)
          }
          setPendingKey(null)
        }}
      />

      <RemoveOtpDialog
        device={pendingOtp}
        isLast={otpIsLast && pendingOtp !== null}
        onCancel={() => setPendingOtp(null)}
        onConfirm={() => {
          if (pendingOtp) {
            void removeOtpMutation.mutateAsync(pendingOtp.id)
          }
          setPendingOtp(null)
        }}
      />
    </div>
  )
}

// ----- Password drawer -----

interface PasswordDraft {
  current: string
  next: string
  confirm: string
}

function PasswordDrawer(props: { open: boolean, onClose: () => void }) {
  if (!props.open)
    return null
  return <PasswordDrawerBody {...props} />
}

export function PasswordDrawerBody({ onClose }: { onClose: () => void }) {
  useReturnFocusOnClose()
  const { t } = useTranslation()
  const titleId = React.useId()
  const mutation = useMutation({ mutationFn: async (body: Parameters<typeof profileApi.changePassword>[0]) => profileApi.changePassword(body), onSuccess: onClose })
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
    if (!valid || mutation.isPending) {
      return
    }
    mutation.mutate({ old_password: draft.current, password: draft.next })
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
          <FieldGroup label={t('profile.auth.pwDrawer.current')} error={showError('current')} htmlFor="pw-current" required>
            <Input
              id="pw-current"
              type={reveal ? 'text' : 'password'}
              value={draft.current}
              onChange={event => setDraft(prev => ({ ...prev, current: event.target.value }))}
              onBlur={() => setTouched(prev => ({ ...prev, current: true }))}
              aria-invalid={showError('current') ? true : undefined}
              {...fieldAria('pw-current', true, !!showError('current'))}
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
          <FieldGroup label={t('profile.auth.pwDrawer.new')} error={showError('next')} htmlFor="pw-new" required>
            <Input
              id="pw-new"
              type={reveal ? 'text' : 'password'}
              value={draft.next}
              onChange={event => setDraft(prev => ({ ...prev, next: event.target.value }))}
              onBlur={() => setTouched(prev => ({ ...prev, next: true }))}
              aria-invalid={showError('next') ? true : undefined}
              {...fieldAria('pw-new', true, !!showError('next'))}
            />
          </FieldGroup>
          <FieldGroup label={t('profile.auth.pwDrawer.confirm')} error={showError('confirm')} htmlFor="pw-confirm" required>
            <Input
              id="pw-confirm"
              type={reveal ? 'text' : 'password'}
              value={draft.confirm}
              onChange={event => setDraft(prev => ({ ...prev, confirm: event.target.value }))}
              onBlur={() => setTouched(prev => ({ ...prev, confirm: true }))}
              aria-invalid={showError('confirm') ? true : undefined}
              {...fieldAria('pw-confirm', true, !!showError('confirm'))}
            />
          </FieldGroup>
          {mutation.error && <p role="alert">{mutation.error.message}</p>}
          <button type="submit" hidden />
        </form>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-card px-6 py-3">
          <Button variant="outline" onClick={onClose}>{t('actions.cancel')}</Button>
          <Button onClick={submit} disabled={!valid || mutation.isPending}>{t('actions.save')}</Button>
        </div>
      </div>
    </Drawer>
  )
}

// ----- Key drawer -----

interface KeyDraft {
  name: string
  material: string
}

function KeyDrawer({ state, onClose }: { state: KeyDrawerState | null, onClose: () => void }) {
  if (!state)
    return null
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
    : state.key ? draft.name !== state.key.name : false

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

  function confirmDiscard() {
    setDiscardOpen(false)
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
            <FieldGroup label={t('profile.auth.keyDrawer.label')} error={showError('name')} htmlFor="key-label" required>
              <Input
                id="key-label"
                placeholder={t('profile.auth.keyDrawer.labelPlaceholder')}
                value={draft.name}
                onChange={event => setDraft(prev => ({ ...prev, name: event.target.value }))}
                onBlur={() => setTouched(prev => ({ ...prev, name: true }))}
                aria-invalid={showError('name') ? true : undefined}
                {...fieldAria('key-label', true, !!showError('name'))}
              />
            </FieldGroup>
            {mode === 'create'
              ? (
                  <FieldGroup label={t('profile.auth.keyDrawer.material')} error={showError('material')} htmlFor="key-material" required>
                    <Textarea
                      id="key-material"
                      rows={6}
                      className="mono"
                      placeholder={t('profile.auth.keyDrawer.materialPlaceholder')}
                      value={draft.material}
                      onChange={event => setDraft(prev => ({ ...prev, material: event.target.value }))}
                      onBlur={() => setTouched(prev => ({ ...prev, material: true }))}
                      aria-invalid={showError('material') ? true : undefined}
                      {...fieldAria('key-material', true, !!showError('material'))}
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
        onConfirm={confirmDiscard}
      />
    </>
  )
}

// ----- OTP drawer -----

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
                <label className="mt-3 flex items-center gap-2 text-[13px] text-foreground">
                  <input
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
        <Button
          variant="destructive"
          onClick={onConfirm}
          disabled={isLast && !accepted}
        >
          {t('profile.actions.remove')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

// ===========================================================================
// ApiTokensTab
// ===========================================================================
