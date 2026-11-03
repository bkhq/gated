import type { SetupInitRequest } from '@/shared/lib/api/setup'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { LockErrorPage, LockPendingPage } from '@/features/encryption/error-page'
import { LockErrorBanner, LockShell } from '@/features/encryption/lock-shell'
import { useRateLimitCountdown } from '@/features/encryption/use-rate-limit-countdown'
import { isRateLimited } from '@/shared/lib/api/encryption'
import { ApiError } from '@/shared/lib/api/http'
import { getSetupStatus, initSetup } from '@/shared/lib/api/setup'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { PasswordInput } from '@/shared/ui/password-input'
import { rememberBootstrapToken, rememberedBootstrapToken } from './bootstrap-token'

const SETUP_STATUS_QUERY_KEY = ['setup', 'status'] as const
const DEFAULT_RATE_LIMIT_SECONDS = 60

/**
 * First-run gate: until the first admin account exists, the gateway serves
 * only the setup screen. The setup endpoint refuses once it is done.
 */
export function SetupGate({ children }: { children: React.ReactNode }) {
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: SETUP_STATUS_QUERY_KEY,
    queryFn: async ({ signal }) => getSetupStatus(signal),
    staleTime: Infinity,
    // The gate shows its own error screen with a retry.
    meta: { inlineError: true },
  })

  if (isLoading)
    return <LockPendingPage />
  if (isError || !data) {
    return (
      <LockErrorPage
        onRetry={() => {
          void refetch()
        }}
        retrying={isFetching}
      />
    )
  }
  return data.needs_setup ? <SetupPage /> : <>{children}</>
}

function SetupPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [token, setToken] = React.useState(rememberedBootstrapToken)
  const [username, setUsername] = React.useState('admin')
  const [password, setPassword] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const countdown = useRateLimitCountdown()
  const mutation = useMutation({
    mutationFn: async (req: SetupInitRequest) => initSetup(req),
    // The setup form shows this failure itself.
    meta: { inlineError: true },
  })

  const validate = (): string | null => {
    if (!token.trim())
      return t('setup.errorTokenRequired')
    if (!username.trim())
      return t('setup.errorUsernameRequired')
    if (!password)
      return t('setup.errorPasswordRequired')
    if (password !== confirm)
      return t('setup.errorConfirmMismatch')
    return null
  }

  const done = async () => {
    rememberBootstrapToken('')
    await queryClient.invalidateQueries({ queryKey: SETUP_STATUS_QUERY_KEY })
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
      await mutation.mutateAsync({
        bootstrap_token: token.trim(),
        username: username.trim(),
        password,
      })
      setPassword('')
      setConfirm('')
      mutation.reset()
      await done()
    }
    catch (err) {
      if (isRateLimited(err)) {
        countdown.start(err.body.retry_after)
        return
      }
      if (err instanceof ApiError && err.status === 429) {
        countdown.start(DEFAULT_RATE_LIMIT_SECONDS)
        return
      }
      if (err instanceof ApiError && err.status === 403) {
        setError(t('setup.errorTokenInvalid'))
        return
      }
      if (err instanceof ApiError && err.status === 409) {
        // Someone else finished setup: continue to sign-in.
        await done()
        return
      }
      setError(t('setup.errorGeneric'))
    }
  }

  const errorId = 'setup-error'
  const describedBy = error ? errorId : undefined

  return (
    <LockShell title={t('setup.title')} description={t('setup.description')}>
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
          <Label htmlFor="setup-token">{t('encryption.bootstrap.tokenLabel')}</Label>
          <Input
            id="setup-token"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('encryption.bootstrap.tokenPlaceholder')}
            value={token}
            onChange={event => setToken(event.target.value)}
            aria-describedby={describedBy}
          />
        </div>

        <div>
          <Label htmlFor="setup-username">{t('setup.usernameLabel')}</Label>
          <Input
            id="setup-username"
            autoComplete="username"
            value={username}
            onChange={event => setUsername(event.target.value)}
            aria-describedby={describedBy}
          />
        </div>

        <div>
          <Label htmlFor="setup-password">{t('setup.passwordLabel')}</Label>
          <PasswordInput
            id="setup-password"
            autoComplete="new-password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            aria-describedby={describedBy}
            toggleLabelShow={t('encryption.passwordShow')}
            toggleLabelHide={t('encryption.passwordHide')}
          />
        </div>

        <div>
          <Label htmlFor="setup-confirm">{t('setup.confirmLabel')}</Label>
          <PasswordInput
            id="setup-confirm"
            autoComplete="new-password"
            value={confirm}
            onChange={event => setConfirm(event.target.value)}
            aria-describedby={describedBy}
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

        <Button type="submit" disabled={countdown.active || mutation.isPending} className="mt-2 w-full">
          {mutation.isPending
            ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>{t('setup.submitting')}</span>
                </>
              )
            : t('setup.submit')}
        </Button>
      </form>
    </LockShell>
  )
}
