import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AuditPage, validateAuditSearch } from './audit-page'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/features/admin/monitor/admin-audit-page', () => ({
  AdminAuditPage: ({ embedded }: { embedded?: boolean }) => <div>{`log-tab embedded=${String(embedded)}`}</div>,
}))
vi.mock('@/features/command-records/command-records-page', () => ({
  CommandRecordsPage: ({ embedded }: { embedded?: boolean }) => <div>{`commands-tab embedded=${String(embedded)}`}</div>,
}))
vi.mock('@/features/file-records/file-records-page', () => ({
  FileRecordsPage: ({ embedded }: { embedded?: boolean }) => <div>{`files-tab embedded=${String(embedded)}`}</div>,
}))

afterEach(cleanup)

async function renderAt(url: string) {
  const rootRoute = createRootRoute()
  const auditRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/audit',
    validateSearch: validateAuditSearch,
    component: AuditPage,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([auditRoute]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  await act(async () => {
    render(<RouterProvider router={router} />)
    await router.load()
  })
  return router
}

it('defaults to the audit log tab with a single page header', async () => {
  await renderAt('/admin/audit')
  expect(await screen.findByRole('heading', { level: 1, name: 'nav.adminAudit' })).toBeTruthy()
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  expect(screen.getByText('log-tab embedded=true')).toBeTruthy()
  expect(screen.getByRole('tab', { name: 'audit.tabs.log' }).getAttribute('aria-selected')).toBe('true')
})

it('deep links to the command records tab', async () => {
  await renderAt('/admin/audit?tab=commands')
  expect(await screen.findByText('commands-tab embedded=true')).toBeTruthy()
  expect(screen.queryByText(/log-tab/)).toBeNull()
})

it('switching tabs replaces the tab search param', async () => {
  const router = await renderAt('/admin/audit')
  await act(async () => {
    fireEvent.click(await screen.findByRole('tab', { name: 'audit.tabs.files' }))
  })
  expect(router.state.location.search).toEqual({ tab: 'files' })
  expect(router.history.length).toBe(1)
  expect(await screen.findByText('files-tab embedded=true')).toBeTruthy()
})

it('drops unknown tab values', () => {
  expect(validateAuditSearch({ tab: 'nope' }).tab).toBeUndefined()
  expect(validateAuditSearch({ tab: 'files' })).toEqual({ tab: 'files' })
})
