import type { Target } from '@/shared/types/domain'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TargetDetailHeader } from './target-detail-header'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))

function makeTarget(kind: Target['kind']): Target {
  return { id: 't1', name: 'web-1', kind, host: '10.0.0.1', port: 22, user: 'root', group: '' }
}

function userHandlers() {
  return {
    onRefresh: vi.fn(),
    onToggleFavorite: vi.fn(),
    onReplayLast: vi.fn(),
    onCopyConnect: vi.fn(),
    onOpenFiles: vi.fn(),
    onOpenSqlConsole: vi.fn(),
  }
}

function visibleButtonNames() {
  return screen.getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent)
}

async function openMenu(name: string) {
  fireEvent.click(screen.getByRole('button', { name }))
  return screen.findByRole('menu')
}

describe('targetDetailHeader', () => {
  it('shows connect, files and the more menu for SSH targets', () => {
    const handlers = userHandlers()
    const onConnect = vi.fn()
    render(<TargetDetailHeader target={makeTarget('ssh')} mode="user" breadcrumbs={[]} favorite onConnect={onConnect} {...handlers} />)

    expect(visibleButtonNames()).toEqual([
      'actions.connect',
      'targets.detail.actions.openFiles',
      'targets.detail.actions.more',
    ])

    fireEvent.click(screen.getByRole('button', { name: 'actions.connect' }))
    expect(onConnect).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'targets.detail.actions.openFiles' }))
    expect(handlers.onOpenFiles).toHaveBeenCalledOnce()
  })

  it('lists the secondary actions in the more menu', async () => {
    const handlers = userHandlers()
    render(<TargetDetailHeader target={makeTarget('ssh')} mode="user" breadcrumbs={[]} favorite replayLastDisabled onConnect={vi.fn()} {...handlers} />)

    await openMenu('targets.detail.actions.more')
    expect(screen.getByRole('menuitem', { name: 'targets.detail.actions.refresh' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'targets.detail.copyConnectCmd' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'targets.detail.actions.replayLast' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(screen.getByRole('menuitem', { name: 'targets.detail.actions.favoriteOn' }))
    expect(handlers.onToggleFavorite).toHaveBeenCalledWith(false)
  })

  it.each(['mysql', 'postgres'] as const)('shows the SQL console next to connect for %s targets', (kind) => {
    const handlers = userHandlers()
    render(<TargetDetailHeader target={makeTarget(kind)} mode="user" breadcrumbs={[]} onConnect={vi.fn()} {...handlers} />)

    expect(visibleButtonNames()).toEqual([
      'actions.connect',
      'targets.detail.actions.openSqlConsole',
      'targets.detail.actions.more',
    ])
    fireEvent.click(screen.getByRole('button', { name: 'targets.detail.actions.openSqlConsole' }))
    expect(handlers.onOpenSqlConsole).toHaveBeenCalledOnce()
  })

  it('omits connect and open actions for HTTP targets', () => {
    render(<TargetDetailHeader target={makeTarget('http')} mode="user" breadcrumbs={[]} {...userHandlers()} />)

    expect(visibleButtonNames()).toEqual(['targets.detail.actions.more'])
  })

  it('shows edit, connect and files plus a more menu with delete in admin mode', async () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    const onConnect = vi.fn()
    const onOpenFiles = vi.fn()
    render(<TargetDetailHeader target={makeTarget('ssh')} mode="admin" breadcrumbs={[]} onEdit={onEdit} onDelete={onDelete} onConnect={onConnect} onOpenFiles={onOpenFiles} onOpenSqlConsole={vi.fn()} />)

    expect(visibleButtonNames()).toEqual(['actions.edit', 'actions.connect', 'targets.detail.actions.openFiles', 'targets.detail.actions.more'])
    fireEvent.click(screen.getByRole('button', { name: 'actions.edit' }))
    expect(onEdit).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'actions.connect' }))
    expect(onConnect).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'targets.detail.actions.openFiles' }))
    expect(onOpenFiles).toHaveBeenCalledOnce()

    await openMenu('targets.detail.actions.more')
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['actions.delete'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'actions.delete' }))
    expect(onDelete).toHaveBeenCalledOnce()
  })
})
