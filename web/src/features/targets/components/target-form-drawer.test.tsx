import type { TargetWithAccounts } from '@/features/targets/hooks/use-targets-queries'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/lib/api/http'
import { TargetFormDrawer } from './target-form-drawer'

const api = vi.hoisted(() => ({
  createAdminTarget: vi.fn(),
  deleteAdminTarget: vi.fn(),
  getAdminTarget: vi.fn(),
  updateAdminTarget: vi.fn(),
  listTargetRoles: vi.fn(),
  listAdminAccounts: vi.fn(),
}))
vi.mock('@/shared/ui/select', () => ({ Select: ({ id, value, onValueChange, options, disabled }: { id?: string, value: string, disabled?: boolean, onValueChange: (value: string) => void, options: { value: string, label: string }[] }) => <select id={id} value={value} disabled={disabled} onChange={event => onValueChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> }))
vi.mock('@/shared/lib/api/targets', async original => ({ ...await original<typeof import('@/shared/lib/api/targets')>(), createAdminTarget: api.createAdminTarget, deleteAdminTarget: api.deleteAdminTarget, getAdminTarget: api.getAdminTarget, updateAdminTarget: api.updateAdminTarget, listTargetRoles: api.listTargetRoles }))
vi.mock('@/shared/lib/api/accounts', async original => ({ ...await original<typeof import('@/shared/lib/api/accounts')>(), listAdminAccounts: api.listAdminAccounts }))
vi.mock('@/features/roles/hooks/use-roles-queries', () => ({ useRoles: () => ({ data: [] }) }))
vi.mock('@/features/target-groups/hooks/use-target-groups-queries', () => ({ useTargetGroups: () => ({ data: [] }) }))

const sshAccount = { id: 3, kind: 'ssh-password', name: 'deploy-pw', description: '', reference_count: 0, created_at: '', updated_at: '' }

const target: TargetWithAccounts = {
  id: 't-1',
  name: 'prod-api',
  kind: 'ssh',
  host: '10.0.0.1',
  port: 22,
  user: 'deploy',
  group: '',
  accounts: [{ account_id: 3, role: 'primary' } as NonNullable<TargetWithAccounts['accounts']>[number]],
}

beforeEach(() => {
  vi.resetAllMocks()
  api.listAdminAccounts.mockResolvedValue([sshAccount])
  api.listTargetRoles.mockResolvedValue([])
})
afterEach(cleanup)

function renderDrawer(props: Partial<React.ComponentProps<typeof TargetFormDrawer>> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TargetFormDrawer open mode="create" target={null} onClose={vi.fn()} {...props} />
    </QueryClientProvider>,
  )
}

function fillGeneral() {
  fireEvent.change(screen.getByLabelText('fields.name'), { target: { value: 'prod-api' } })
  fireEvent.change(screen.getByLabelText('targets.detail.overview.host'), { target: { value: '10.0.0.1' } })
}

it('blocks create without a primary account and points to the auth tab', async () => {
  renderDrawer()
  fillGeneral()
  fireEvent.click(screen.getByRole('button', { name: 'actions.save' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('targets.form.missing')
  expect(await screen.findByLabelText('targets.form.auth.selectorLabel')).toBeInTheDocument()
  expect(api.createAdminTarget).not.toHaveBeenCalled()
})

it('blocks create with empty required general fields', async () => {
  renderDrawer()
  fireEvent.click(screen.getByRole('button', { name: 'actions.save' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('targets.form.missing')
  expect(screen.getByLabelText('fields.name')).toHaveAttribute('aria-invalid', 'true')
  expect(screen.getByLabelText('targets.detail.overview.host')).toHaveAttribute('aria-invalid', 'true')
  expect(api.createAdminTarget).not.toHaveBeenCalled()
})

it('shows the server error when create fails and keeps the drawer open', async () => {
  api.createAdminTarget.mockRejectedValue(new ApiError(409, 'Name already exists', null))
  const onClose = vi.fn()
  renderDrawer({ onClose })
  fillGeneral()
  fireEvent.click(screen.getByRole('tab', { name: 'targets.form.tabs.auth' }))
  fireEvent.change(await screen.findByLabelText('targets.form.auth.selectorLabel'), { target: { value: '3' } })
  fireEvent.click(screen.getByRole('button', { name: 'actions.save' }))

  expect(await screen.findByText('Name already exists')).toBeInTheDocument()
  expect(api.createAdminTarget).toHaveBeenCalledWith(expect.objectContaining({ accounts: [{ account_id: 3, role: 'primary' }] }))
  expect(onClose).not.toHaveBeenCalled()
})

it('locks the protocol in edit mode', () => {
  renderDrawer({ mode: 'edit', target })
  expect(screen.getByLabelText('fields.protocol')).toBeDisabled()
})

it('confirms before deleting from the drawer', async () => {
  api.deleteAdminTarget.mockResolvedValue(undefined)
  const onDeleted = vi.fn()
  renderDrawer({ mode: 'edit', target, onDeleted })
  fireEvent.click(screen.getByRole('button', { name: 'actions.delete' }))
  expect(await screen.findByText('targets.delete.title')).toBeInTheDocument()
  expect(api.deleteAdminTarget).not.toHaveBeenCalled()

  fireEvent.click(screen.getAllByRole('button', { name: 'actions.delete' }).at(-1)!)
  await waitFor(() => expect(api.deleteAdminTarget).toHaveBeenCalledWith('t-1'))
  await waitFor(() => expect(onDeleted).toHaveBeenCalled())
})

it('shows the server error when delete fails', async () => {
  api.deleteAdminTarget.mockRejectedValue(new ApiError(500, 'database is locked', null))
  const onDeleted = vi.fn()
  renderDrawer({ mode: 'edit', target, onDeleted })
  fireEvent.click(screen.getByRole('button', { name: 'actions.delete' }))
  fireEvent.click((await screen.findAllByRole('button', { name: 'actions.delete' })).at(-1)!)

  expect(await screen.findByText('database is locked')).toBeInTheDocument()
  expect(onDeleted).not.toHaveBeenCalled()
})

function switchToManualCredentials() {
  fireEvent.click(screen.getByRole('tab', { name: 'targets.form.tabs.auth' }))
  fireEvent.change(screen.getByLabelText('targets.form.auth.source'), { target: { value: 'manual' } })
}

const createdSsh = { id: 't-2', name: 'prod-api', description: '', group_id: null, accounts: [], options: { kind: 'Ssh', host: '10.0.0.1', port: 22, username: 'root', auth: { kind: 'Password', password: '' } } }

it('creates a target with manually entered credentials and no account', async () => {
  api.createAdminTarget.mockResolvedValue(createdSsh)
  const onClose = vi.fn()
  renderDrawer({ onClose })
  fillGeneral()
  switchToManualCredentials()
  fireEvent.change(screen.getByLabelText('targets.form.auth.username'), { target: { value: 'root' } })
  fireEvent.change(screen.getByLabelText('targets.form.auth.password'), { target: { value: 'hunter2' } })
  fireEvent.click(screen.getByRole('button', { name: 'actions.save' }))

  await waitFor(() => expect(onClose).toHaveBeenCalled())
  expect(api.createAdminTarget).toHaveBeenCalledWith(expect.objectContaining({
    accounts: [],
    options: expect.objectContaining({ kind: 'Ssh', username: 'root', auth: { kind: 'Password', password: 'hunter2' } }),
  }))
})

it('requires the secret for manual credentials on create', async () => {
  renderDrawer()
  fillGeneral()
  switchToManualCredentials()
  fireEvent.change(screen.getByLabelText('targets.form.auth.methodLabel'), { target: { value: 'key' } })
  fireEvent.click(screen.getByRole('button', { name: 'actions.save' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('targets.form.missing')
  expect(screen.getByLabelText('targets.form.auth.privateKey')).toHaveAttribute('aria-invalid', 'true')
  expect(api.createAdminTarget).not.toHaveBeenCalled()
})

it('keeps the stored secret when editing an inline target with a blank field', async () => {
  const inlineTarget: TargetWithAccounts = { ...target, accounts: [], inlineAuth: { method: 'key', privateKey: '', passphrase: '' } }
  api.getAdminTarget.mockResolvedValue(createdSsh)
  api.updateAdminTarget.mockResolvedValue(createdSsh)
  const onClose = vi.fn()
  renderDrawer({ mode: 'edit', target: inlineTarget, onClose })
  fireEvent.click(screen.getByRole('tab', { name: 'targets.form.tabs.auth' }))
  expect(screen.getByLabelText('targets.form.auth.source')).toHaveValue('manual')
  expect(screen.getByLabelText('targets.form.auth.methodLabel')).toHaveValue('key')
  fireEvent.click(screen.getByRole('button', { name: 'actions.save' }))

  await waitFor(() => expect(onClose).toHaveBeenCalled())
  expect(api.updateAdminTarget).toHaveBeenCalledWith('t-1', expect.objectContaining({
    accounts: [],
    options: expect.objectContaining({ auth: { kind: 'PublicKey', private_key_pem: undefined, passphrase: undefined } }),
  }))
})
