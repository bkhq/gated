import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/app-store'
import { AppLayout } from './layout'

const state = vi.hoisted(() => ({
  info: { data: undefined as undefined | { username: string | null, admin: boolean }, isPending: false, isError: false },
  login: false,
  route: '/targets',
  navigate: vi.fn(),
}))
vi.mock('@/shared/hooks/use-info', () => ({ useInfo: () => state.info }))
vi.mock('@tanstack/react-router', () => ({
  Outlet: () => <div>Route content</div>,
  Navigate: () => <div>Login redirect</div>,
  useMatchRoute: () => ({ to }: { to: string }) => to === '/auth/login' ? state.login : to === state.route,
  useRouter: () => ({ navigate: state.navigate }),
}))
vi.mock('@/shared/ui/sidebar', () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarInset: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarTrigger: () => <button type="button">menu</button>,
}))
vi.mock('./sidebar', () => ({
  AppSidebar: () => <aside>{useAppStore.getState().identity.name}</aside>,
}))
vi.mock('./spotlight-dialog', () => ({ SpotlightDialog: () => null }))
vi.mock('@/features/session/sessions-page', () => ({
  SessionsPage: ({ visible }: { visible: boolean }) => <div data-testid="terminal-workspace" hidden={!visible} />,
}))

function view() {
  return <QueryClientProvider client={new QueryClient()}><AppLayout /></QueryClientProvider>
}

beforeEach(() => {
  state.info = { data: undefined, isPending: false, isError: false }
  state.login = false
  state.route = '/targets'
  useAppStore.setState(useAppStore.getInitialState())
})
afterEach(cleanup)

it('does not mount the shell for anonymous instance metadata', () => {
  state.info.data = { username: null, admin: false }
  render(view())
  expect(screen.queryByRole('complementary')).toBeNull()
  expect(screen.getByText('Login redirect')).toBeTruthy()
  expect(screen.queryByText('Route content')).toBeNull()
})

it('keeps the login route standalone even with a cached authenticated identity', () => {
  state.login = true
  state.info.data = { username: 'real-user', admin: false }
  render(view())
  expect(screen.getByText('Route content')).toBeTruthy()
  expect(screen.queryByRole('complementary')).toBeNull()
})

it('waits for identity before showing business content', () => {
  state.info.isPending = true
  render(view())
  expect(screen.queryByText('Route content')).toBeNull()
  expect(screen.queryByText('Login redirect')).toBeNull()
})

it('uses server identity and clears it when the session becomes anonymous', () => {
  useAppStore.getState().updateIdentity({ name: 'Previous User', username: 'previous', email: 'old@example.test' })
  state.info.data = { username: 'real-user', admin: true }
  const result = render(view())
  expect(screen.getByRole('complementary').textContent).toBe('real-user')
  expect(useAppStore.getState().identity.username).toBe('real-user')
  expect(useAppStore.getState().identity.email).toBe('')
  state.info.data = { username: null, admin: false }
  result.rerender(view())
  expect(screen.queryByRole('complementary')).toBeNull()
  expect(useAppStore.getState().identity.username).toBe('')
})

it('hides cached authenticated content when identity validation fails', () => {
  state.info = { data: { username: 'old-user', admin: true }, isPending: false, isError: true }
  render(view())
  expect(screen.queryByRole('complementary')).toBeNull()
  expect(screen.getByText('Login redirect')).toBeTruthy()
})

it('has no demo account in the initial store', () => {
  expect(useAppStore.getInitialState().identity.username).toBe('')
  expect(useAppStore.getInitialState().identity.name).toBe('')
})

it('exposes a menu trigger in the content area so the mobile sidebar can be opened', () => {
  state.info.data = { username: 'real-user', admin: false }
  render(view())
  expect(screen.getByRole('button', { name: 'menu' })).toBeTruthy()
})

it('shows the terminal workspace on the sessions route', () => {
  state.info.data = { username: 'real-user', admin: false }
  state.route = '/sessions'
  render(view())
  expect(screen.getByTestId('terminal-workspace').hidden).toBe(false)
})

it('does not mount the terminal workspace elsewhere when no tab is open', () => {
  state.info.data = { username: 'real-user', admin: false }
  render(view())
  expect(screen.queryByTestId('terminal-workspace')).toBeNull()
})

it('keeps open terminal tabs mounted but hidden on other routes', () => {
  state.info.data = { username: 'real-user', admin: false }
  useAppStore.getState().openTerminalTab({ type: 'terminal', kind: 'ssh', targetId: 't1', targetName: 'web-01' })
  render(view())
  expect(screen.getByTestId('terminal-workspace').hidden).toBe(true)
  expect(screen.getByText('Route content')).toBeTruthy()
})
