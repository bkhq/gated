import type { Account } from '@/shared/types/domain'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/lib/api/http'
import { AccountFormDialog } from './account-form-dialog'

const api = vi.hoisted(() => ({
  getAdminAccount: vi.fn(),
  listAdminAccountReferences: vi.fn(),
  updateAdminAccount: vi.fn(),
  createAdminAccount: vi.fn(),
  revealAdminAccount: vi.fn(),
  getAdminAccountStepUp: vi.fn(),
}))
vi.mock('@/shared/ui/select', () => ({ Select: ({ id, value, onValueChange, options, disabled }: { id?: string, value: string, disabled?: boolean, onValueChange: (value: string) => void, options: { value: string, label: string }[] }) => <select id={id} value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> }))
vi.mock('@/shared/lib/api/accounts', async original => ({ ...await original<typeof import('@/shared/lib/api/accounts')>(), ...api }))

const account: Account = {
  id: '7',
  name: 'prod-db',
  kind: 'db-password',
  description: 'readonly',
  referenceCount: 0,
  lastUsed: null,
  rotationDueAt: null,
  tags: [],
}

const summary = { id: 7, kind: 'db-password', name: 'prod-db', description: 'readonly', reference_count: 0, created_at: '', updated_at: '' }

beforeEach(() => {
  vi.resetAllMocks()
  api.getAdminAccount.mockResolvedValue({ ...summary, credentials_schema: {}, credentials_public: { kind: 'db-password', engine: 'postgres', username: 'reader' } })
  api.listAdminAccountReferences.mockResolvedValue([])
  api.getAdminAccountStepUp.mockResolvedValue({ valid_until: null })
})
afterEach(cleanup)

function renderDialog(props: Partial<React.ComponentProps<typeof AccountFormDialog>> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AccountFormDialog open mode="view" account={account} onClose={vi.fn()} {...props} />
    </QueryClientProvider>,
  )
}

async function confirmStepUp(password = 'pw') {
  fireEvent.change(await screen.findByLabelText('accounts.form.reveal.password'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: 'accounts.stepUp.confirmSave' }))
}

it('view mode masks secrets and reveals only after step-up', async () => {
  api.revealAdminAccount.mockResolvedValue({ credentials: { kind: 'db-password', engine: 'postgres', username: 'reader', password: 'hunter2' } })
  renderDialog()
  expect(await screen.findByText('reader')).toBeInTheDocument()
  expect(screen.getByText('••••••••')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'accounts.form.reveal.show' }))
  fireEvent.change(await screen.findByLabelText('accounts.form.reveal.password'), { target: { value: 'pw' } })
  const confirm = screen.getAllByRole('button', { name: 'accounts.form.reveal.show' }).at(-1)!
  fireEvent.click(confirm)

  expect(await screen.findByText('hunter2')).toBeInTheDocument()
  expect(api.revealAdminAccount).toHaveBeenCalledWith(7, { password: 'pw' }, expect.any(AbortSignal))
})

it('edit prefills non-secret fields and saves only after step-up', async () => {
  api.updateAdminAccount.mockResolvedValue(summary)
  renderDialog()
  fireEvent.click(screen.getByRole('button', { name: 'actions.edit' }))
  const username = await screen.findByDisplayValue('reader')
  fireEvent.change(username, { target: { value: 'writer' } })

  fireEvent.click(screen.getByRole('button', { name: 'accounts.form.saveVerified' }))
  expect(api.updateAdminAccount).not.toHaveBeenCalled()

  await confirmStepUp()
  await waitFor(() => expect(api.updateAdminAccount).toHaveBeenCalledOnce())
  expect(api.updateAdminAccount).toHaveBeenCalledWith(7, expect.objectContaining({
    credentials: { kind: 'db-password', engine: 'postgres', username: 'writer', password: '' },
    confirmation: { password: 'pw' },
  }))
})

it('keeps the step-up prompt open on a wrong password', async () => {
  api.updateAdminAccount.mockRejectedValue(new ApiError(401, 'HTTP 401', null))
  renderDialog({ mode: 'edit' })
  fireEvent.change(await screen.findByDisplayValue('prod-db'), { target: { value: 'prod-db-2' } })
  fireEvent.click(screen.getByRole('button', { name: 'accounts.form.saveVerified' }))
  await confirmStepUp('wrong')
  expect(await screen.findByText('accounts.stepUp.errors.unauthorized')).toBeInTheDocument()
  expect(screen.getByLabelText('accounts.form.reveal.password')).toHaveValue('')
})

it('create validates required fields before asking for step-up', async () => {
  api.createAdminAccount.mockResolvedValue({ ...summary, kind: 'k8s-token' })
  renderDialog({ mode: 'create', account: null, allowedKinds: ['k8s-token'] })
  fireEvent.click(screen.getByRole('button', { name: 'accounts.form.saveVerified' }))
  expect(screen.getByRole('alert')).toHaveTextContent('accounts.form.missing')
  expect(screen.queryByLabelText('accounts.form.reveal.password')).toBeNull()

  expect(screen.queryByRole('tab')).toBeNull()
  fireEvent.change(screen.getByLabelText('fields.name'), { target: { value: 'k8s' } })
  fireEvent.change(screen.getByLabelText('accounts.form.cred.token'), { target: { value: 'tok' } })
  fireEvent.click(screen.getByRole('button', { name: 'accounts.form.saveVerified' }))
  await confirmStepUp()
  await waitFor(() => expect(api.createAdminAccount).toHaveBeenCalledWith(expect.objectContaining({
    kind: 'k8s-token',
    credentials: { kind: 'k8s-token', token: 'tok' },
    confirmation: { password: 'pw' },
  })))
})

it('create sends the rotation preset as a due date counted from save time', async () => {
  api.createAdminAccount.mockResolvedValue(summary)
  renderDialog({ mode: 'create', account: null, allowedKinds: ['k8s-token'] })
  fireEvent.change(screen.getByLabelText('fields.name'), { target: { value: 'k8s' } })
  fireEvent.change(screen.getByLabelText('accounts.form.cred.token'), { target: { value: 'tok' } })
  fireEvent.change(screen.getByLabelText('accounts.form.rotation.label'), { target: { value: 'd90' } })
  fireEvent.click(screen.getByRole('button', { name: 'accounts.form.saveVerified' }))
  await confirmStepUp()
  await waitFor(() => expect(api.createAdminAccount).toHaveBeenCalledOnce())
  const due = Date.parse(api.createAdminAccount.mock.calls[0]![0].rotation_due_at)
  expect(Math.round((due - Date.now()) / 86_400_000)).toBe(90)
})

function openWindow() {
  api.getAdminAccountStepUp.mockResolvedValue({ valid_until: new Date(Date.now() + 10 * 60_000).toISOString() })
}

it('saves without prompting while the step-up window is open', async () => {
  openWindow()
  api.updateAdminAccount.mockResolvedValue(summary)
  renderDialog({ mode: 'edit' })
  fireEvent.change(await screen.findByDisplayValue('prod-db'), { target: { value: 'prod-db-2' } })
  fireEvent.click(screen.getByRole('button', { name: 'accounts.form.saveVerified' }))
  await waitFor(() => expect(api.updateAdminAccount).toHaveBeenCalledWith(7, expect.objectContaining({ confirmation: {} })))
  expect(screen.queryByLabelText('accounts.form.reveal.password')).toBeNull()
})

it('reveals without prompting while the step-up window is open', async () => {
  openWindow()
  api.revealAdminAccount.mockResolvedValue({ credentials: { kind: 'db-password', engine: 'postgres', username: 'reader', password: 'hunter2' } })
  renderDialog()
  fireEvent.click(await screen.findByRole('button', { name: 'accounts.form.reveal.show' }))
  expect(await screen.findByText('hunter2')).toBeInTheDocument()
  expect(api.revealAdminAccount).toHaveBeenCalledWith(7, {}, expect.any(AbortSignal))
})

it('falls back to the prompt when the window lapsed before the save landed', async () => {
  openWindow()
  api.updateAdminAccount.mockRejectedValueOnce(new ApiError(400, 'confirmation is required', 'confirmation is required')).mockResolvedValue(summary)
  renderDialog({ mode: 'edit' })
  fireEvent.change(await screen.findByDisplayValue('prod-db'), { target: { value: 'prod-db-2' } })
  fireEvent.click(screen.getByRole('button', { name: 'accounts.form.saveVerified' }))
  await confirmStepUp()
  await waitFor(() => expect(api.updateAdminAccount).toHaveBeenLastCalledWith(7, expect.objectContaining({ confirmation: { password: 'pw' } })))
  expect(screen.queryByRole('alert')).toBeNull()
})
