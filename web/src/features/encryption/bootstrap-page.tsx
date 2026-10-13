import type { InitRequest, InitResponse } from '@/shared/lib/api/encryption'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { invalidateLockStatus, setLockStatusUnlocked } from '@/shared/hooks/use-lock-status'
import { initEncryption, isRateLimited } from '@/shared/lib/api/encryption'
import { ApiError } from '@/shared/lib/api/http'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { PasswordInput } from '@/shared/ui/password-input'
import { LockErrorBanner, LockShell } from './lock-shell'
import { useRateLimitCountdown } from './use-rate-limit-countdown'

interface InitFailureBodyPartial {
  code?: string
}

function failureCode(err: unknown): string | null {
  if (!(err instanceof ApiError))
    return null
  const body = err.body
  if (!body || typeof body !== 'object')
    return null
  const candidate = body as InitFailureBodyPartial
  return candidate.code ?? null
}

const MIN_PASSWORD_LENGTH = 12

// Wire contract says 429 always carries retry_after; this is a defensive
// fallback so a malformed body still produces a usable countdown instead
// of a generic "HTTP 429" error.
const DEFAULT_RATE_LIMIT_SECONDS = 60

export function BootstrapPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [token, setToken] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [plaintextBackup, setPlaintextBackup] = React.useState<string | null>(null)
  const countdown = useRateLimitCountdown()
  const tokenRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    tokenRef.current?.focus()
  }, [])

  const mutation = useMutation<InitResponse, unknown, InitRequest>({
    mutationFn: async req => initEncryption(req),
  })

  const validate = (): string | null => {
    if (!token.trim())
      return t('encryption.bootstrap.errorTokenRequired')
    if (!password)
      return t('encryption.bootstrap.errorPasswordRequired')
    if (password.length < MIN_PASSWORD_LENGTH)
      return t('encryption.bootstrap.errorPasswordTooShort', { min: MIN_PASSWORD_LENGTH })
    if (password !== confirm)
      return t('encryption.bootstrap.errorConfirmMismatch')
    return null
  }

  const codeToMessage = (code: string): string | null => {
    switch (code) {
      case 'encryption_disabled': return t('encryption.bootstrap.errorEncryptionDisabled')
      case 'already_initialized': return t('encryption.bootstrap.errorAlreadyInitialized')
      case 'database_detection_failed': return t('encryption.bootstrap.errorDbDetectionFailed')
      case 'database_not_plaintext': return t('encryption.bootstrap.errorDbNotPlaintext')
      case 'init_failed': return t('encryption.bootstrap.errorInitFailed')
      default: return null
    }
  }

  const finish = async () => {
    // Optimistically transition the gate so the UI doesn't briefly
    // re-render the bootstrap screen during the post-success refetch.
    setLockStatusUnlocked(queryClient)
    await invalidateLockStatus(queryClient)
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (countdown.active || mutation.isPending)
      return
    const validation = validate()
    if (validation) {
      setError(validation)
      return
    }
    setError(null)
    try {
      const response = await mutation.mutateAsync({
        bootstrap_token: token.trim(),
        master_password: password,
      })
      // Clear sensitive material from component state, then drop the
      // mutation cache (which retains the request body until the next call).
      setToken('')
      setPassword('')
      setConfirm('')
      mutation.reset()
      // A retained plaintext copy must be acknowledged before leaving this
      // screen, so the operator learns it needs deleting.
      if (response.plaintext_backup) {
        setPlaintextBackup(response.plaintext_backup)
        return
      }
      await finish()
    }
    catch (err) {
      if (isRateLimited(err)) {
        countdown.start(err.body.retry_after)
        setError(null)
        return
      }
      if (err instanceof ApiError && err.status === 429) {
        countdown.start(DEFAULT_RATE_LIMIT_SECONDS)
        setError(null)
        return
      }
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setError(t('encryption.bootstrap.errorTokenInvalid'))
        return
      }
      const code = failureCode(err)
      const mapped = code ? codeToMessage(code) : null
      if (mapped) {
        setError(mapped)
        return
      }
      const fallback = err instanceof Error ? err.message : t('encryption.bootstrap.errorGeneric')
      setError(fallback)
    }
  }

  if (plaintextBackup) {
    return (
      <LockShell title={t('encryption.bootstrap.backupTitle')} description={t('encryption.bootstrap.backupDescription')}>
        <div role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-[12px] text-foreground">
          <p className="m-0">{t('encryption.bootstrap.backupBody')}</p>
          <code className="mt-2 block break-all font-mono text-[12px]">{plaintextBackup}</code>
        </div>
        <Button className="w-full" onClick={() => { void finish() }}>
          {t('encryption.bootstrap.backupContinue')}
        </Button>
      </LockShell>
    )
  }

  const errorId = 'encryption-bootstrap-error'
  const submitDisabled = countdown.active || mutation.isPending

  return (
    <LockShell title={t('encryption.bootstrap.title')} description={t('encryption.bootstrap.description')}>
      <div className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-[12px] text-muted-foreground">
        <p className="mb-1 font-medium text-foreground">{t('encryption.bootstrap.tokenHelpTitle')}</p>
        <p className="m-0">{t('encryption.bootstrap.tokenHelpBody')}</p>
      </div>

      <form
        onSubmit={(event) => {
          void submit(event)
        }}
        className="flex flex-col gap-2.5"
      >
        <div>
          <Label htmlFor="encryption-bootstrap-token">{t('encryption.bootstrap.tokenLabel')}</Label>
          <Input
            id="encryption-bootstrap-token"
            ref={tokenRef}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('encryption.bootstrap.tokenPlaceholder')}
            value={token}
            onChange={event => setToken(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
        </div>

        <div>
          <Label htmlFor="encryption-bootstrap-password">{t('encryption.bootstrap.passwordLabel')}</Label>
          <PasswordInput
            id="encryption-bootstrap-password"
            autoComplete="new-password"
            placeholder={t('encryption.bootstrap.passwordPlaceholder')}
            value={password}
            onChange={event => setPassword(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            toggleLabelShow={t('encryption.passwordShow')}
            toggleLabelHide={t('encryption.passwordHide')}
          />
          <p className="mt-1 text-[12px] text-muted-foreground">
            {t('encryption.bootstrap.passwordHint', { min: MIN_PASSWORD_LENGTH })}
          </p>
        </div>

        <div>
          <Label htmlFor="encryption-bootstrap-confirm">{t('encryption.bootstrap.confirmLabel')}</Label>
          <PasswordInput
            id="encryption-bootstrap-confirm"
            autoComplete="new-password"
            placeholder={t('encryption.bootstrap.confirmPlaceholder')}
            value={confirm}
            onChange={event => setConfirm(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            toggleLabelShow={t('encryption.passwordShow')}
            toggleLabelHide={t('encryption.passwordHide')}
          />
        </div>

        {error ? <LockErrorBanner id={errorId} message={error} /> : null}

        {countdown.active
          ? (
              <div role="status" aria-live="polite" className="mt-1 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-[12px] text-muted-foreground">
                {t('encryption.rateLimited', { seconds: countdown.seconds })}
              </div>
            )
          : null}

        <Button type="submit" disabled={submitDisabled} className="mt-2 w-full">
          {mutation.isPending
            ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>{t('encryption.bootstrap.submitting')}</span>
                </>
              )
            : t('encryption.bootstrap.submit')}
        </Button>
      </form>
    </LockShell>
  )
}
