import type { User } from '@/shared/types/domain'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { toLocalInput } from '@/shared/lib/datetime-local'
import { UserFormDialog } from './user-form-dialog'

const state = vi.hoisted(() => ({ update: vi.fn(), userRoles: [] as { id: string, name: string, expires_at: string | null }[] }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/features/roles/hooks/use-roles-queries', () => ({
  useRoles: () => ({ data: [
    { id: 'ops', name: 'ops', description: '', builtin: false },
    { id: 'dba', name: 'dba', description: '', builtin: false },
  ] }),
}))
vi.mock('@/features/sessions/hooks/use-sessions-queries', () => ({
  useLiveSessions: () => ({ data: [] }),
  usePastSessions: () => ({ data: { items: [], total: 0 } }),
}))
vi.mock('@/features/users/hooks/use-users-queries', () => ({
  useCreateUser: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useUpdateUser: () => ({ isPending: false, mutateAsync: state.update }),
  useUserRoles: () => ({ data: state.userRoles }),
}))
afterEach(() => {
  cleanup()
  state.update.mockReset()
})

const user = { id: 'u1', name: 'Alice', username: 'alice', roles: ['ops', 'dba'] } as unknown as User
const STORED = '2020-01-01T00:00:30Z'

function open() {
  state.userRoles = [
    { id: 'ops', name: 'ops', expires_at: STORED },
    { id: 'dba', name: 'dba', expires_at: null },
  ]
  render(<UserFormDialog open mode="edit" user={user} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('tab', { name: /users.form.tabs.roles|roles/i }))
}

it('shows stored expiries and sends only the one that was edited', async () => {
  state.update.mockResolvedValue(null)
  open()
  const ops = await screen.findByLabelText('users.form.roleExpires', { selector: '#user-role-expiry-ops' })
  expect(ops).toHaveValue(toLocalInput(STORED))
  expect(screen.getByText('users.form.roleExpired')).toBeInTheDocument()

  const dba = screen.getByLabelText('users.form.roleExpires', { selector: '#user-role-expiry-dba' })
  fireEvent.change(dba, { target: { value: '2999-01-01T00:00' } })
  fireEvent.click(screen.getByText('actions.save'))
  await waitFor(() => expect(state.update).toHaveBeenCalledOnce())
  // The expired assignment was not touched, so it is not sent again.
  expect(state.update.mock.calls[0]?.[0].roleExpiry).toEqual({ dba: new Date('2999-01-01T00:00').toISOString() })
})

it('holds back an expiry in the past', async () => {
  open()
  const dba = await screen.findByLabelText('users.form.roleExpires', { selector: '#user-role-expiry-dba' })
  fireEvent.change(dba, { target: { value: '2001-01-01T00:00' } })
  expect(screen.getByRole('alert')).toHaveTextContent('users.form.roleExpiresPast')
  fireEvent.click(screen.getByText('actions.save'))
  expect(state.update).not.toHaveBeenCalled()
})
