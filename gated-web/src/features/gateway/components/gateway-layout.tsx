import { Key, Server, ShieldCheck, User } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, NavLink, Outlet } from 'react-router'
import { AppBreadcrumb } from '@/shared/components/app-breadcrumb'
import { LanguageToggle } from '@/shared/components/language-toggle'
import { ModeToggle } from '@/shared/components/mode-toggle'
import { UserMenu } from '@/shared/components/user-menu'
import { useAuthInit } from '@/shared/hooks/use-auth-init'
import { useAuthStore } from '@/shared/stores/auth'

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md transition-colors ${
    isActive
      ? 'bg-primary/10 text-primary font-medium'
      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
  }`
}

export function GatewayLayout() {
  const { t } = useTranslation(['gateway', 'common'])
  const { isAuthenticated } = useAuthStore()

  useAuthInit()

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-4 h-12 flex items-center gap-4">
        <Link to="/ui" className="flex items-center gap-2 shrink-0 mr-2">
          <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ShieldCheck className="size-3.5" />
          </div>
          <span className="text-lg font-semibold tracking-tight">{t('common:appName')}</span>
        </Link>

        {isAuthenticated && (
          <nav className="flex items-center gap-1">
            <NavLink to="/ui" end className={navLinkClass}>
              <Server className="size-4" />
              <span>{t('gateway:nav.targets')}</span>
            </NavLink>
            <NavLink to="/ui/profile" end className={navLinkClass}>
              <User className="size-4" />
              <span>{t('gateway:nav.profile')}</span>
            </NavLink>
            <NavLink to="/ui/profile/api-tokens" className={navLinkClass}>
              <Key className="size-4" />
              <span>{t('gateway:pages.apiTokens')}</span>
            </NavLink>
          </nav>
        )}

        <div className="ml-auto flex items-center gap-1">
          <LanguageToggle />
          <ModeToggle />
          {isAuthenticated && <UserMenu variant="button" />}
        </div>
      </header>

      {isAuthenticated && (
        <div className="border-b border-border px-4 h-8 flex items-center">
          <AppBreadcrumb />
        </div>
      )}

      <main className="flex-1 max-w-5xl mx-auto w-full px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}
