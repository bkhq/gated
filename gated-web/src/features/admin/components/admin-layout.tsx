import { useTranslation } from 'react-i18next'
import { NavLink, Outlet } from 'react-router'
import { ModeToggle } from '@/shared/components/mode-toggle'

const navItems = [
  { to: '/@gated/admin', key: 'nav.sessions', end: true },
  { to: '/@gated/admin/log', key: 'nav.log' },
  { to: '/@gated/admin/config/targets', key: 'nav.targets' },
  { to: '/@gated/admin/config/users', key: 'nav.users' },
  { to: '/@gated/admin/config/roles', key: 'nav.roles' },
  { to: '/@gated/admin/config/tickets', key: 'nav.tickets' },
  { to: '/@gated/admin/config/ssh-keys', key: 'nav.sshKeys' },
  { to: '/@gated/admin/config/ldap', key: 'nav.ldap' },
  { to: '/@gated/admin/config/target-groups', key: 'nav.groups' },
  { to: '/@gated/admin/config/parameters', key: 'nav.parameters' },
]

export function AdminLayout() {
  const { t } = useTranslation(['admin', 'common'])

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      <aside className="w-56 shrink-0 border-r border-border p-4">
        <div className="flex items-center justify-between mb-6">
          <a href="/@gated/admin" className="text-xl font-heading font-semibold">
            {t('common:adminTitle')}
          </a>
          <ModeToggle />
        </div>
        <nav className="flex flex-col gap-1">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `px-3 py-1.5 rounded text-sm ${isActive ? 'bg-accent font-medium' : 'hover:bg-accent/50'}`}
            >
              {t(item.key)}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 p-6 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
