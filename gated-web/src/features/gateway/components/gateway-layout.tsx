import { useTranslation } from 'react-i18next'
import { Link, NavLink, Outlet } from 'react-router'
import { Key, Server, User } from 'lucide-react'
import { ModeToggle } from '@/shared/components/mode-toggle'
import { AppBreadcrumb } from '@/shared/components/app-breadcrumb'
import { UserMenu } from '@/shared/components/user-menu'
import { useAuthStore } from '@/shared/stores/auth'
import { useAuthInit } from '@/shared/hooks/use-auth-init'

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-1.5 text-sm px-2 py-1 rounded transition-colors ${
    isActive
      ? 'text-foreground font-medium'
      : 'text-muted-foreground hover:text-foreground'
  }`

export function GatewayLayout() {
  const { t } = useTranslation(['gateway', 'common'])
  const { isAuthenticated } = useAuthStore()

  useAuthInit()

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="border-b border-border px-6 h-14 flex items-center gap-4">
        <Link to="/@gated/ui" className="text-lg font-heading font-semibold shrink-0 mr-2">
          {t('common:appName')}
        </Link>

        {isAuthenticated && (
          <nav className="flex items-center gap-1">
            <NavLink to="/@gated/ui" end className={navLinkClass}>
              <Server className="size-4" />
              <span>{t('gateway:nav.targets')}</span>
            </NavLink>
            <NavLink to="/@gated/ui/profile" end className={navLinkClass}>
              <User className="size-4" />
              <span>{t('gateway:nav.profile')}</span>
            </NavLink>
            <NavLink to="/@gated/ui/profile/api-tokens" className={navLinkClass}>
              <Key className="size-4" />
              <span>{t('gateway:pages.apiTokens')}</span>
            </NavLink>
          </nav>
        )}

        <div className="ml-auto flex items-center gap-2">
          <ModeToggle />
          {isAuthenticated && <UserMenu variant="button" />}
        </div>
      </header>

      {isAuthenticated && (
        <div className="border-b border-border px-6 h-9 flex items-center">
          <AppBreadcrumb />
        </div>
      )}

      <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-8">
        <Outlet />
      </main>
    </div>
  )
}
