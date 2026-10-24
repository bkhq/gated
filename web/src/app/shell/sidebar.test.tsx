import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AppSidebar } from './sidebar'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...props }: { to: string, children?: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
  useRouterState: () => '/overview',
}))
vi.mock('@/features/auth-requests/hooks/use-auth-requests-queries', () => ({ useAuthRequests: () => ({ data: [] }) }))
vi.mock('@/features/sessions/hooks/use-sessions-queries', () => ({ useMyLiveSessions: () => ({ data: [] }) }))
vi.mock('@/shared/hooks/use-info', () => ({ useIsAdmin: () => true }))
vi.mock('@/shared/hooks/use-site-title', () => ({ useSiteTitle: () => 'Gated' }))
vi.mock('./user-menu', () => ({ UserMenu: () => null }))
vi.mock('@/shared/ui/sidebar', async () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    Sidebar: passthrough,
    SidebarContent: passthrough,
    SidebarFooter: passthrough,
    SidebarGroup: passthrough,
    SidebarGroupContent: passthrough,
    SidebarGroupLabel: passthrough,
    SidebarHeader: passthrough,
    SidebarMenu: passthrough,
    SidebarMenuItem: passthrough,
    SidebarMenuButton: ({ render, children }: { render?: React.ReactElement<{ children?: React.ReactNode }>, children?: React.ReactNode }) =>
      render ? <render.type {...render.props}>{children}</render.type> : <button type="button">{children}</button>,
    useSidebar: () => ({ state: 'expanded', toggleSidebar: vi.fn() }),
  }
})

afterEach(cleanup)

it('lists only routed entries with a single audit item for admins', () => {
  render(<AppSidebar />)
  const hrefs = screen.getAllByRole('link').map(link => link.getAttribute('href'))
  expect(hrefs).toHaveLength(4 + 11)
  expect(hrefs).toContain('/admin/audit')
  expect(hrefs).not.toContain('/admin/command-records')
  expect(hrefs).not.toContain('/admin/file-records')
  expect(screen.queryByText('nav.search')).toBeNull()
  expect(screen.queryByText('nav.adminCommandRecords')).toBeNull()
  expect(screen.queryByText('nav.adminFileRecords')).toBeNull()
})

it('shows group labels without the standalone admin header', () => {
  render(<AppSidebar />)
  expect(screen.queryByText('section.admin')).toBeNull()
  expect(screen.getByText('section.adminResources')).toBeTruthy()
})
