import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Outlet, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { ModeToggle } from '@/shared/components/mode-toggle'
import { useAuthStore } from '@/shared/stores/auth'
import { useInfoQuery, useLogoutMutation } from '@/features/gateway/api'

export function GatewayLayout() {
  const { t } = useTranslation(['gateway', 'common'])
  const navigate = useNavigate()
  const { setAuth, clearAuth, isAuthenticated } = useAuthStore()

  const infoQuery = useInfoQuery()
  const logoutMutation = useLogoutMutation()

  useEffect(() => {
    if (infoQuery.isSuccess) {
      const info = infoQuery.data
      if (info.username) {
        setAuth(info.username, false)
      } else {
        clearAuth()
      }
    } else if (infoQuery.isError) {
      clearAuth()
    }
  }, [infoQuery.isSuccess, infoQuery.isError, infoQuery.data, setAuth, clearAuth])

  function handleLogout() {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        clearAuth()
        void navigate('/@gated/login')
      },
      onError: () => {
        toast.error(t('gateway:nav.logoutError'))
      },
    })
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <Link to="/@gated" className="text-xl font-heading font-semibold">
          {t('common:appName')}
        </Link>
        <nav className="flex items-center gap-4">
          {isAuthenticated && (
            <>
              <Link to="/@gated/profile" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                {t('gateway:nav.profile')}
              </Link>
              <Button variant="ghost" size="sm" onClick={handleLogout} disabled={logoutMutation.isPending}>
                {t('gateway:nav.logout')}
              </Button>
            </>
          )}
          <ModeToggle />
        </nav>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}
