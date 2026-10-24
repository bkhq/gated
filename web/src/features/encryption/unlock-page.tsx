import type { UnlockedResponse, UnlockRequest } from '@/shared/lib/api/encryption'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { invalidateLockStatus, setLockStatusUnlocked } from '@/shared/hooks/use-lock-status'
import { isRateLimited, unlockEncryption } from '@/shared/lib/api/encryption'
import { ApiError } from '@/shared/lib/api/http'
import { Button } from '@/shared/ui/button'
import { Label } from '@/shared/ui/label'
import { PasswordInput } from '@/shared/ui/password-input'
import { LockErrorBanner, LockShell } from './lock-shell'
import { MIN_PASSWORD_LENGTH } from './master-password'
import { useRateLimitCountdown } from './use-rate-limit-countdown'

// Fallback used when the gateway returns 429 without a numeric `retry_after`
// — the wire contract says it always includes one (60s), but defending
// against a malformed body keeps the UI from collapsing to "HTTP 429".
const DEFAULT_RATE_LIMIT_SECONDS = 60

export function UnlockPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [password, setPassword] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const countdown = useRateLimitCountdown()
  const passwordRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    passwordRef.current?.focus()
  }, [])

  const mutation = useMutation<UnlockedResponse, unknown, UnlockRequest>({
    mutationFn: async req => unlockEncryption(req),
  })

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (countdown.active || mutation.isPending)
      return
    if (!password) {
      setError(t('encryption.unlock.errorPasswordRequired'))
      return
    }
    setError(null)
    try {
      await mutation.mutateAsync({ master_password: password })
      // Clear cleartext from component state, then drop the mutation cache
      // (which retains `variables.master_password` until the next call).
      setPassword('')
      mutation.reset()
      // Optimistically transition the gate so the UI doesn't briefly
      // re-render the unlock screen during the post-success refetch.
      setLockStatusUnlocked(queryClient)
      await invalidateLockStatus(queryClient)
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
      if (err instanceof ApiError && err.status === 401) {
        setError(t('encryption.unlock.errorInvalid', { min: MIN_PASSWORD_LENGTH }))
        return
      }
      const fallback = err instanceof Error ? err.message : t('encryption.unlock.errorGeneric')
      setError(fallback)
    }
  }

  const errorId = 'encryption-unlock-error'
  const submitDisabled = countdown.active || mutation.isPending

  return (
    <LockShell title={t('encryption.unlock.title')} description={t('encryption.unlock.description')}>
      <form
        onSubmit={(event) => {
          void submit(event)
        }}
        className="flex flex-col gap-2.5"
      >
        <div>
          <Label htmlFor="encryption-master-password">{t('encryption.unlock.passwordLabel')}</Label>
          <PasswordInput
            id="encryption-master-password"
            ref={passwordRef}
            autoComplete="current-password"
            placeholder={t('encryption.unlock.passwordPlaceholder')}
            value={password}
            onChange={event => setPassword(event.target.value)}
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
                  <span>{t('encryption.unlock.submitting')}</span>
                </>
              )
            : t('encryption.unlock.submit')}
        </Button>
      </form>
    </LockShell>
  )
}
