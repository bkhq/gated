import type { ApiAuthState, LoginFailureResponse } from '@/shared/lib/api/auth'
import type { SsoProvider } from '@/shared/lib/api/sso'
import { AlertTriangle, Building2, ChevronLeft, Eye, EyeOff, Loader2 } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { BrandHero } from '@/shared/components/gated-logo'
import {
  useAuthState,
  useContinueAuth,
  useLogin,
  useSsoProviders,
  useStartSso,
  useSubmitOtp,
} from '@/shared/hooks/use-auth'
import { useSiteTitle } from '@/shared/hooks/use-site-title'
import { ApiError } from '@/shared/lib/api/http'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Separator } from '@/shared/ui/separator'
import { loginDestination } from './login-destination'

type Step = 'password' | 'otp' | 'sso' | 'web-approval'

function failureStateFromError(err: unknown): ApiAuthState | null {
  if (!(err instanceof ApiError) || err.status !== 401)
    return null
  const body = err.body as Partial<LoginFailureResponse> | undefined
  return body?.state ?? null
}

function stepForState(state: ApiAuthState | null): Step | null {
  switch (state) {
    case 'OtpNeeded': return 'otp'
    case 'SsoNeeded': return 'sso'
    case 'WebUserApprovalNeeded': return 'web-approval'
    case null:
    case 'NotStarted':
    case 'Failed':
    case 'PasswordNeeded':
    case 'PublicKeyNeeded':
    case 'Success': return null
  }
}

export function LoginPage() {
  const { t } = useTranslation()
  const loginMutation = useLogin()
  const otpMutation = useSubmitOtp()
  const startSsoMutation = useStartSso()
  const ssoProvidersQuery = useSsoProviders()
  const continueMutation = useContinueAuth()

  const [step, setStep] = React.useState<Step>('password')
  // While waiting for an out-of-band approval, poll the auth state so the
  // page can finish the login once another device approves it.
  const authStateQuery = useAuthState(step === 'web-approval' ? 2000 : false)
  const [username, setUsername] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [showPw, setShowPw] = React.useState(false)
  const [otp, setOtp] = React.useState<string[]>(['', '', '', '', '', ''])
  const [error, setError] = React.useState<string | null>(null)
  const otpInputsRef = React.useRef<Array<HTMLInputElement | null>>([])
  const usernameRef = React.useRef<HTMLInputElement | null>(null)

  // Resume an in-progress flow on first mount — e.g. user refreshed during OTP.
  // We compute the resume step from the query result rather than calling setStep
  // inside the effect to avoid a synchronous extra render.
  const initialStateRef = React.useRef<ApiAuthState | null | undefined>(undefined)
  if (initialStateRef.current === undefined && !authStateQuery.isLoading) {
    const resumed = stepForState(authStateQuery.data?.state ?? null)
    initialStateRef.current = authStateQuery.data?.state ?? null
    if (resumed && step === 'password')
      setStep(resumed)
  }

  React.useEffect(() => {
    if (step === 'otp')
      otpInputsRef.current[0]?.focus()
    else if (step === 'password')
      usernameRef.current?.focus()
  }, [step])

  const goToShell = React.useCallback(() => {
    // Full document load (not client-side navigation) so the freshly-set
    // session cookie is committed before the shell's authenticated queries
    // fire. A client-side nav races the cookie: queries like /api/targets can
    // 401, tripping the global onUnauthorized handler, which logs straight
    // back out — the sidebar then only appears after a manual refresh.
    // '/ui/' is the fixed app base (vite `base` + router `basepath`); the
    // index route redirects on to the overview.
    window.location.assign(loginDestination(window.location.search))
  }, [])

  // The approve endpoint runs in the approver's session, so the requester
  // has to ask the server to authorize its own session once the auth state
  // reports success. A rejection sends the user back to the password step.
  const approvalState = step === 'web-approval' ? authStateQuery.data?.state ?? null : null
  const { mutate: continueLogin } = continueMutation
  const continueRef = React.useRef(false)
  React.useEffect(() => {
    if (approvalState === 'Success' && !continueRef.current) {
      continueRef.current = true
      continueLogin(undefined, {
        onSuccess: () => goToShell(),
        onError: (err) => {
          continueRef.current = false
          setError(err instanceof Error ? err.message : t('login.errorCreds'))
        },
      })
    }
    else if (approvalState === 'Failed' || approvalState === 'NotStarted') {
      setStep('password')
      setError(t('login.errorFailed'))
    }
  }, [approvalState, continueLogin, goToShell, t])

  // Distinct user-facing copy for the failure states that don't transition to a
  // sub-step. Don't silently swallow `NotStarted` etc. — show why the attempt
  // didn't go through.
  const messageForState = (state: ApiAuthState | null, fallback: string): string => {
    switch (state) {
      case 'Failed': return t('login.errorFailed')
      case 'NotStarted': return t('login.errorNotStarted')
      case 'PublicKeyNeeded': return t('login.errorPublicKey')
      case 'PasswordNeeded': return t('login.errorFailed')
      case 'OtpNeeded':
      case 'SsoNeeded':
      case 'WebUserApprovalNeeded':
      case 'Success':
      case null: return fallback
    }
  }

  const submitPassword = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!username || !password) {
      setError(t('login.errorCreds'))
      return
    }
    setError(null)
    try {
      await loginMutation.mutateAsync({ username, password })
      goToShell()
    }
    catch (err) {
      const state = failureStateFromError(err)
      const next = stepForState(state)
      if (next) {
        setStep(next)
        return
      }
      const fallback = err instanceof Error ? err.message : t('login.errorCreds')
      setError(messageForState(state, fallback))
    }
  }

  const submitOtp = async () => {
    if (otp.some(digit => !digit)) {
      setError(t('login.errorOtp'))
      return
    }
    setError(null)
    try {
      await otpMutation.mutateAsync({ otp: otp.join('') })
      goToShell()
    }
    catch (err) {
      const state = failureStateFromError(err)
      const next = stepForState(state)
      if (next && next !== 'otp') {
        setStep(next)
        return
      }
      const fallback = err instanceof Error ? err.message : t('login.errorOtp')
      setError(messageForState(state, fallback))
    }
  }

  const launchSso = async (provider: SsoProvider) => {
    setError(null)
    try {
      const { url } = await startSsoMutation.mutateAsync(provider.name)
      window.location.href = url
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t('login.errorCreds'))
    }
  }

  const onOtpDigit = (index: number, value: string) => {
    const digit = value.slice(-1).replace(/\D/g, '')
    setOtp((current) => {
      const next = [...current]
      next[index] = digit
      return next
    })
    if (digit && index < 5)
      otpInputsRef.current[index + 1]?.focus()
  }

  const onOtpKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !otp[index] && index > 0)
      otpInputsRef.current[index - 1]?.focus()
  }

  const goBack = () => {
    setStep('password')
    setOtp(['', '', '', '', '', ''])
    setError(null)
  }

  const siteTitle = useSiteTitle()
  const errorId = 'login-error'
  const passwordLoading = loginMutation.isPending
  const otpLoading = otpMutation.isPending
  const ssoLoading = startSsoMutation.isPending

  return (
    <main aria-label={t('a11y.auth.mainLandmark')} className="flex min-h-screen items-center justify-center bg-background px-5 py-8">
      <div className="w-full max-w-[320px]">
        <BrandHero title={siteTitle} heading className="mb-8" />

        {step === 'password' && (
          <>
            <form onSubmit={(event) => { void submitPassword(event) }} className="flex flex-col gap-2.5">
              <div>
                <Label htmlFor="username">{t('login.username')}</Label>
                <Input
                  id="username"
                  ref={usernameRef}
                  autoComplete="username"
                  placeholder={t('login.username')}
                  value={username}
                  onChange={event => setUsername(event.target.value)}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                />
              </div>
              <div>
                <Label htmlFor="password">{t('login.password')}</Label>
                <Input
                  id="password"
                  type={showPw ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="••••••••••••"
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  suffix={(
                    <button
                      type="button"
                      onClick={() => setShowPw(value => !value)}
                      className="focus-ring inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:text-foreground"
                      aria-label={showPw ? t('a11y.auth.hidePassword') : t('a11y.auth.showPassword')}
                      aria-pressed={showPw}
                    >
                      {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  )}
                />
              </div>

              {error
                ? (
                    <div id={errorId} role="alert" className="flex items-start gap-2 rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.1)] px-2.5 py-2 text-[12px] text-destructive">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                      <span>{error}</span>
                    </div>
                  )
                : null}

              <Button type="submit" disabled={passwordLoading} className="mt-1 w-full">
                {passwordLoading
                  ? <Spinner label={t('login.signing')} />
                  : t('actions.signIn')}
              </Button>
            </form>

            <SsoSection
              providers={ssoProvidersQuery.data ?? []}
              loading={ssoProvidersQuery.isLoading}
              disabled={ssoLoading || passwordLoading}
              onChoose={(provider) => { void launchSso(provider) }}
            />
          </>
        )}

        {step === 'otp' && (
          <>
            <Button variant="ghost" size="sm" onClick={goBack} className="mb-2 px-2">
              <ChevronLeft size={14} />
              <span>{t('actions.back')}</span>
            </Button>
            <p className="m-0 mb-4 text-center text-[13.5px] text-muted-foreground">
              {t('login.otpPrompt')}
              {' '}
              <strong className="text-foreground">{username}</strong>
            </p>

            <div className="flex justify-between gap-2" role="group" aria-label={t('a11y.auth.otpGroup')}>
              {otp.map((digit, index) => (
                <input
                  // eslint-disable-next-line react/no-array-index-key
                  key={index}
                  ref={(element) => {
                    otpInputsRef.current[index] = element
                  }}
                  value={digit}
                  inputMode="numeric"
                  maxLength={1}
                  autoComplete="one-time-code"
                  aria-label={t('a11y.auth.otpDigit', { position: index + 1 })}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  onChange={event => onOtpDigit(index, event.target.value)}
                  onKeyDown={event => onOtpKeyDown(index, event)}
                  className="focus-ring mono h-[50px] w-[42px] rounded-md border border-input bg-background text-center text-[20px] font-semibold text-foreground outline-none focus:border-ring"
                />
              ))}
            </div>

            {error
              ? (
                  <div id={errorId} role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.1)] px-2.5 py-2 text-[12px] text-destructive">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{error}</span>
                  </div>
                )
              : null}

            <Button onClick={() => { void submitOtp() }} disabled={otpLoading} className="mt-4 w-full">
              {otpLoading ? <Spinner label={t('login.verifying')} /> : t('login.verifyAndSignIn')}
            </Button>
          </>
        )}

        {step === 'sso' && (
          <>
            <Button variant="ghost" size="sm" onClick={goBack} className="mb-2 px-2">
              <ChevronLeft size={14} />
              <span>{t('actions.back')}</span>
            </Button>
            <p className="m-0 mb-3 text-center text-[13.5px] text-muted-foreground">
              {t('login.ssoChoose')}
            </p>
            <SsoSection
              providers={ssoProvidersQuery.data ?? []}
              loading={ssoProvidersQuery.isLoading}
              disabled={ssoLoading}
              onChoose={(provider) => { void launchSso(provider) }}
              hideDivider
            />
            {error
              ? (
                  <div id={errorId} role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.1)] px-2.5 py-2 text-[12px] text-destructive">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{error}</span>
                  </div>
                )
              : null}
          </>
        )}

        {step === 'web-approval' && (
          <>
            <Button variant="ghost" size="sm" onClick={goBack} className="mb-2 px-2">
              <ChevronLeft size={14} />
              <span>{t('actions.back')}</span>
            </Button>
            <p className="m-0 text-center text-[13.5px] text-muted-foreground">
              {t('login.waitingApproval')}
            </p>
            {error
              ? (
                  <div id={errorId} role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.1)] px-2.5 py-2 text-[12px] text-destructive">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{error}</span>
                  </div>
                )
              : null}
          </>
        )}
      </div>
    </main>
  )
}

function SsoSection({
  providers,
  loading,
  disabled,
  onChoose,
  hideDivider,
}: {
  providers: SsoProvider[]
  loading: boolean
  disabled: boolean
  onChoose: (provider: SsoProvider) => void
  hideDivider?: boolean
}) {
  const { t } = useTranslation()
  if (!loading && providers.length === 0)
    return null

  return (
    <>
      {hideDivider
        ? null
        : (
            <div className="my-4 flex items-center gap-2.5">
              <Separator className="flex-1" />
              <span className="text-[11px] text-muted-foreground">{t('login.or')}</span>
              <Separator className="flex-1" />
            </div>
          )}

      <div className="flex flex-col gap-1.5">
        {providers.map(provider => (
          <Button
            key={provider.name}
            type="button"
            variant="outline"
            className="w-full"
            disabled={disabled}
            onClick={() => onChoose(provider)}
          >
            <Building2 size={14} />
            <span>{provider.label || provider.name}</span>
          </Button>
        ))}
      </div>
    </>
  )
}

function Spinner({ label }: { label: string }) {
  return (
    <>
      <Loader2 size={14} className="animate-spin" />
      <span>{label}</span>
    </>
  )
}
