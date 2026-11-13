import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useLogout } from '@/shared/hooks/use-auth'
import { OtpEnrollmentForm } from './otp-enrollment-drawer'

/** Shown instead of the app while the gateway requires an OTP device the user has not enrolled. */
export function MfaSetupPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const logout = useLogout()

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md rounded-lg border bg-card">
        <p className="px-6 pt-6 text-sm text-muted-foreground">{t('mfaSetup.hint')}</p>
        <OtpEnrollmentForm
          title={t('mfaSetup.title')}
          cancelLabel={t('actions.signOut')}
          onCancel={() => logout.mutate(undefined, {
            onSettled: () => {
              void navigate({ to: '/auth/login' })
            },
          })}
          onDone={() => {
            void queryClient.invalidateQueries({ queryKey: ['info'] })
          }}
        />
      </div>
    </main>
  )
}
