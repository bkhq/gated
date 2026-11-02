import type { LockStatusValue } from '@/shared/lib/api/encryption'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, KeyRound, Loader2, Lock } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useIsAdmin } from '@/shared/hooks/use-info'
import { invalidateLockStatus, useLockStatus } from '@/shared/hooks/use-lock-status'
import { lockEncryption, rekeyMasterPassword } from '@/shared/lib/api/encryption'
import { ApiError } from '@/shared/lib/api/http'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { Label } from '@/shared/ui/label'
import { PasswordInput } from '@/shared/ui/password-input'
import { Skeleton } from '@/shared/ui/skeleton'

const MASTER_PASSWORD_MIN_LENGTH = 12

const STATUS_TONE: Record<LockStatusValue, 'success' | 'info' | 'warning' | 'danger' | 'mono'> = {
  unlocked: 'success',
  locked: 'warning',
  uninitialized: 'info',
  error: 'danger',
  disabled: 'mono',
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError)
    return err.message || fallback
  if (err instanceof Error)
    return err.message || fallback
  return fallback
}

export function EncryptionAdminCard() {
  const { t } = useTranslation()
  const isAdmin = useIsAdmin()
  const statusQuery = useLockStatus()

  if (!isAdmin)
    return null

  return (
    <div className="px-6 pt-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>{t('settings.encryptionAdmin.title')}</CardTitle>
              <div className="mt-1 text-[12.5px] text-muted-foreground">
                {t('settings.encryptionAdmin.hint')}
              </div>
            </div>
            <StatusBadge query={statusQuery} />
          </div>
        </CardHeader>
        <CardContent>
          <EncryptionAdminBody query={statusQuery} />
        </CardContent>
      </Card>
    </div>
  )
}

function StatusBadge({ query }: { query: ReturnType<typeof useLockStatus> }) {
  const { t } = useTranslation()
  if (query.isLoading || !query.data) {
    return <Skeleton className="h-5 w-20" />
  }
  const status = query.data.status
  return (
    <Badge tone={STATUS_TONE[status]}>
      {t(`settings.encryptionAdmin.status.${status}`)}
    </Badge>
  )
}

function EncryptionAdminBody({ query }: { query: ReturnType<typeof useLockStatus> }) {
  const { t } = useTranslation()
  const [lockOpen, setLockOpen] = React.useState(false)
  const [rekeyOpen, setRekeyOpen] = React.useState(false)

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    )
  }

  if (query.isError || !query.data) {
    return (
      <div
        role="alert"
        className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[12.5px] text-destructive"
      >
        <AlertCircle size={14} aria-hidden="true" />
        <span>{t('settings.encryptionAdmin.loadError')}</span>
      </div>
    )
  }

  const status = query.data.status

  if (status === 'disabled') {
    return (
      <p className="text-[12.5px] text-muted-foreground">
        {t('settings.encryptionAdmin.disabledNotice')}
      </p>
    )
  }

  if (status !== 'unlocked') {
    return (
      <p className="text-[12.5px] text-muted-foreground">
        {t(`settings.encryptionAdmin.notUnlocked.${status}`)}
      </p>
    )
  }

  return (
    <>
      <p className="text-[12.5px] text-muted-foreground">
        {t('settings.encryptionAdmin.unlockedNotice')}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setRekeyOpen(true)}>
          <KeyRound size={13} />
          <span>{t('settings.encryptionAdmin.actions.rotateMaster')}</span>
        </Button>
        <Button variant="destructive" size="sm" onClick={() => setLockOpen(true)}>
          <Lock size={13} />
          <span>{t('settings.encryptionAdmin.actions.lockNow')}</span>
        </Button>
      </div>
      <LockNowDialog open={lockOpen} onClose={() => setLockOpen(false)} />
      <RekeyMasterDialog open={rekeyOpen} onClose={() => setRekeyOpen(false)} />
    </>
  )
}

function LockNowDialog({ open, onClose }: { open: boolean, onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} width={440}>
      {open ? <LockNowDialogBody key="lock-body" onClose={onClose} /> : null}
    </Dialog>
  )
}

function LockNowDialogBody({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [error, setError] = React.useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: async () => lockEncryption(),
    onSuccess: async () => {
      await invalidateLockStatus(qc)
      onClose()
    },
    onError: (err) => {
      setError(errorMessage(err, t('settings.encryptionAdmin.lockDialog.error')))
    },
  })

  const pending = mutation.isPending
  const close = () => {
    if (pending)
      return
    setError(null)
    onClose()
  }

  return (
    <>
      <DialogHeader
        title={t('settings.encryptionAdmin.lockDialog.title')}
        description={t('settings.encryptionAdmin.lockDialog.description')}
        onClose={pending ? undefined : close}
      />
      <DialogBody className="flex flex-col gap-2">
        <p className="text-[12.5px] text-muted-foreground">
          {t('settings.encryptionAdmin.lockDialog.warning')}
        </p>
        {error
          ? (
              <div
                role="alert"
                className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[12.5px] text-destructive"
              >
                <AlertCircle size={14} aria-hidden="true" />
                <span>{error}</span>
              </div>
            )
          : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={close} disabled={pending}>
          {t('settings.encryptionAdmin.lockDialog.cancel')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            setError(null)
            mutation.mutate()
          }}
          disabled={pending}
        >
          {pending
            ? (
                <>
                  <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  <span>{t('settings.encryptionAdmin.lockDialog.locking')}</span>
                </>
              )
            : (
                <>
                  <Lock size={13} />
                  <span>{t('settings.encryptionAdmin.lockDialog.confirm')}</span>
                </>
              )}
        </Button>
      </DialogFooter>
    </>
  )
}

function RekeyMasterDialog({ open, onClose }: { open: boolean, onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} width={460}>
      {open ? <RekeyMasterDialogBody key="rekey-body" onClose={onClose} /> : null}
    </Dialog>
  )
}

type RekeyFieldErrors = Partial<Record<'oldPassword' | 'newPassword' | 'confirmPassword', string>>

function RekeyMasterDialogBody({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [oldPassword, setOldPassword] = React.useState('')
  const [newPassword, setNewPassword] = React.useState('')
  const [confirmPassword, setConfirmPassword] = React.useState('')
  const [fieldErrors, setFieldErrors] = React.useState<RekeyFieldErrors>({})
  const [submitError, setSubmitError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState(false)

  const mutation = useMutation({
    mutationFn: async (req: { old_password: string, new_password: string }) => rekeyMasterPassword(req),
    onSuccess: async () => {
      setDone(true)
      await invalidateLockStatus(qc)
    },
    onError: (err) => {
      setSubmitError(errorMessage(err, t('settings.encryptionAdmin.rekeyDialog.error')))
    },
  })

  const pending = mutation.isPending

  const close = () => {
    if (pending)
      return
    onClose()
  }

  const validate = (): RekeyFieldErrors => {
    const next: RekeyFieldErrors = {}
    if (!oldPassword)
      next.oldPassword = t('settings.encryptionAdmin.rekeyDialog.errors.oldRequired')
    if (newPassword.length < MASTER_PASSWORD_MIN_LENGTH) {
      next.newPassword = t('settings.encryptionAdmin.rekeyDialog.errors.newTooShort', {
        min: MASTER_PASSWORD_MIN_LENGTH,
      })
    }
    if (newPassword && newPassword === oldPassword)
      next.newPassword = t('settings.encryptionAdmin.rekeyDialog.errors.newSameAsOld')
    if (confirmPassword !== newPassword)
      next.confirmPassword = t('settings.encryptionAdmin.rekeyDialog.errors.confirmMismatch')
    return next
  }

  const submit = () => {
    const errors = validate()
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0)
      return
    setSubmitError(null)
    mutation.mutate({ old_password: oldPassword, new_password: newPassword })
  }

  if (done) {
    return (
      <>
        <DialogHeader
          title={t('settings.encryptionAdmin.rekeyDialog.title')}
          description={t('settings.encryptionAdmin.rekeyDialog.description')}
          onClose={onClose}
        />
        <DialogBody>
          <div
            role="status"
            aria-live="polite"
            className="inline-flex items-center gap-1.5 rounded-md border border-[hsl(var(--success)/0.35)] bg-[hsl(var(--success)/0.08)] px-2.5 py-1.5 text-[12.5px] text-[hsl(var(--success))]"
          >
            <CheckCircle2 size={14} aria-hidden="true" />
            <span>{t('settings.encryptionAdmin.rekeyDialog.success')}</span>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button size="sm" onClick={onClose}>
            {t('settings.encryptionAdmin.rekeyDialog.close')}
          </Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <>
      <DialogHeader
        title={t('settings.encryptionAdmin.rekeyDialog.title')}
        description={t('settings.encryptionAdmin.rekeyDialog.description')}
        onClose={pending ? undefined : close}
      />
      <DialogBody className="flex flex-col gap-3">
        <RekeyField
          id="rekey-old"
          label={t('settings.encryptionAdmin.rekeyDialog.oldPassword')}
          value={oldPassword}
          onChange={(v) => {
            setOldPassword(v)
            if (fieldErrors.oldPassword)
              setFieldErrors(prev => ({ ...prev, oldPassword: undefined }))
            if (submitError)
              setSubmitError(null)
          }}
          disabled={pending}
          error={fieldErrors.oldPassword}
          autoComplete="current-password"
        />
        <RekeyField
          id="rekey-new"
          label={t('settings.encryptionAdmin.rekeyDialog.newPassword')}
          hint={t('settings.encryptionAdmin.rekeyDialog.newPasswordHint', { min: MASTER_PASSWORD_MIN_LENGTH })}
          value={newPassword}
          onChange={(v) => {
            setNewPassword(v)
            if (fieldErrors.newPassword)
              setFieldErrors(prev => ({ ...prev, newPassword: undefined }))
          }}
          disabled={pending}
          error={fieldErrors.newPassword}
          autoComplete="new-password"
        />
        <RekeyField
          id="rekey-confirm"
          label={t('settings.encryptionAdmin.rekeyDialog.confirmPassword')}
          value={confirmPassword}
          onChange={(v) => {
            setConfirmPassword(v)
            if (fieldErrors.confirmPassword)
              setFieldErrors(prev => ({ ...prev, confirmPassword: undefined }))
          }}
          disabled={pending}
          error={fieldErrors.confirmPassword}
          autoComplete="new-password"
        />
        {submitError
          ? (
              <div
                role="alert"
                className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[12.5px] text-destructive"
              >
                <AlertCircle size={14} aria-hidden="true" />
                <span>{submitError}</span>
              </div>
            )
          : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={close} disabled={pending}>
          {t('settings.encryptionAdmin.rekeyDialog.cancel')}
        </Button>
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending
            ? (
                <>
                  <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                  <span>{t('settings.encryptionAdmin.rekeyDialog.rotating')}</span>
                </>
              )
            : t('settings.encryptionAdmin.rekeyDialog.confirm')}
        </Button>
      </DialogFooter>
    </>
  )
}

function RekeyField({
  id,
  label,
  hint,
  value,
  onChange,
  disabled,
  error,
  autoComplete,
}: {
  id: string
  label: string
  hint?: string
  value: string
  onChange: (next: string) => void
  disabled: boolean
  error: string | undefined
  autoComplete: React.InputHTMLAttributes<HTMLInputElement>['autoComplete']
}) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-[13px]">{label}</Label>
      <PasswordInput
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        autoComplete={autoComplete}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={describedBy}
      />
      {hint ? <div id={hintId} className="text-[12px] text-muted-foreground">{hint}</div> : null}
      {error ? <div id={errorId} className="text-[12px] text-destructive">{error}</div> : null}
    </div>
  )
}
