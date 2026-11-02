import type { LockStatus } from '@/shared/lib/api/encryption'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import i18n from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import enCommon from '../../../../public/locales/en/common.json'

vi.mock('@/shared/hooks/use-info', () => ({
  useIsAdmin: vi.fn(),
}))

vi.mock('@/shared/hooks/use-lock-status', () => ({
  useLockStatus: vi.fn(),
  invalidateLockStatus: vi.fn(async () => {}),
}))

vi.mock('@/shared/lib/api/encryption', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/lib/api/encryption')>()
  return {
    ...actual,
    lockEncryption: vi.fn(),
    rekeyMasterPassword: vi.fn(),
  }
})

const { useIsAdmin } = await import('@/shared/hooks/use-info')
const { useLockStatus, invalidateLockStatus } = await import('@/shared/hooks/use-lock-status')
const encryptionMod = await import('@/shared/lib/api/encryption')
const { lockEncryption, rekeyMasterPassword } = encryptionMod
const { ApiError } = await import('@/shared/lib/api/http')
const { EncryptionAdminCard } = await import('./encryption-admin-card')

await i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { common: enCommon } },
  defaultNS: 'common',
  ns: ['common'],
  interpolation: { escapeValue: false },
})

function setStatus(status: LockStatus['status'] | 'loading' | 'error'): void {
  const mocked = vi.mocked(useLockStatus)
  if (status === 'loading') {
    mocked.mockReturnValue({ isLoading: true, isError: false, data: undefined } as unknown as ReturnType<typeof useLockStatus>)
    return
  }
  if (status === 'error') {
    mocked.mockReturnValue({ isLoading: false, isError: true, data: undefined } as unknown as ReturnType<typeof useLockStatus>)
    return
  }
  mocked.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { status, db_ready: true },
  } as unknown as ReturnType<typeof useLockStatus>)
}

function renderCard() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>
        <EncryptionAdminCard />
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

describe('encryptionAdminCard', () => {
  beforeEach(() => {
    vi.mocked(useIsAdmin).mockReturnValue(true)
    vi.mocked(lockEncryption).mockReset()
    vi.mocked(rekeyMasterPassword).mockReset()
    vi.mocked(invalidateLockStatus).mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing for non-admin viewers', () => {
    vi.mocked(useIsAdmin).mockReturnValue(false)
    setStatus('unlocked')
    const { container } = renderCard()
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the disabled notice when encryption is off', () => {
    setStatus('disabled')
    renderCard()
    expect(screen.getByText(enCommon.settings.encryptionAdmin.disabledNotice)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: enCommon.settings.encryptionAdmin.actions.lockNow })).not.toBeInTheDocument()
  })

  it('renders both actions only in the unlocked state', () => {
    setStatus('locked')
    const { unmount } = renderCard()
    expect(screen.queryByRole('button', { name: enCommon.settings.encryptionAdmin.actions.lockNow })).not.toBeInTheDocument()
    expect(screen.getByText(enCommon.settings.encryptionAdmin.notUnlocked.locked)).toBeInTheDocument()
    unmount()

    setStatus('unlocked')
    renderCard()
    expect(screen.getByRole('button', { name: enCommon.settings.encryptionAdmin.actions.lockNow })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: enCommon.settings.encryptionAdmin.actions.rotateMaster })).toBeInTheDocument()
  })

  it('locks the gateway and invalidates lock-status on confirm', async () => {
    vi.mocked(lockEncryption).mockResolvedValue({ status: 'locked' })
    setStatus('unlocked')
    renderCard()

    fireEvent.click(screen.getByRole('button', { name: enCommon.settings.encryptionAdmin.actions.lockNow }))
    const confirmButtons = await screen.findAllByRole('button', { name: enCommon.settings.encryptionAdmin.lockDialog.confirm })
    const dialogConfirm = confirmButtons[confirmButtons.length - 1]!
    await act(async () => {
      fireEvent.click(dialogConfirm)
    })

    await waitFor(() => expect(lockEncryption).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(invalidateLockStatus).toHaveBeenCalledTimes(1))
  })

  it('surfaces ApiError messages from the lock action', async () => {
    vi.mocked(lockEncryption).mockRejectedValue(
      new ApiError(500, 'lock service unavailable', { message: 'lock service unavailable' }),
    )
    setStatus('unlocked')
    renderCard()

    fireEvent.click(screen.getByRole('button', { name: enCommon.settings.encryptionAdmin.actions.lockNow }))
    const confirmButtons = await screen.findAllByRole('button', { name: enCommon.settings.encryptionAdmin.lockDialog.confirm })
    await act(async () => {
      fireEvent.click(confirmButtons[confirmButtons.length - 1]!)
    })

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('lock service unavailable'))
    expect(invalidateLockStatus).not.toHaveBeenCalled()
  })

  it('blocks rekey submit until validation passes, then calls the API', async () => {
    vi.mocked(rekeyMasterPassword).mockResolvedValue({ status: 'unlocked' })
    setStatus('unlocked')
    renderCard()

    fireEvent.click(screen.getByRole('button', { name: enCommon.settings.encryptionAdmin.actions.rotateMaster }))
    const confirm = await screen.findByRole('button', { name: enCommon.settings.encryptionAdmin.rekeyDialog.confirm })

    await act(async () => {
      fireEvent.click(confirm)
    })
    expect(rekeyMasterPassword).not.toHaveBeenCalled()
    expect(screen.getByText(enCommon.settings.encryptionAdmin.rekeyDialog.errors.oldRequired)).toBeInTheDocument()

    const oldInput = screen.getByLabelText(enCommon.settings.encryptionAdmin.rekeyDialog.oldPassword)
    const newInput = screen.getByLabelText(enCommon.settings.encryptionAdmin.rekeyDialog.newPassword)
    const confirmInput = screen.getByLabelText(enCommon.settings.encryptionAdmin.rekeyDialog.confirmPassword)

    fireEvent.change(oldInput, { target: { value: 'old-master-pw-1234' } })
    fireEvent.change(newInput, { target: { value: 'shiny-new-pw-5678' } })
    fireEvent.change(confirmInput, { target: { value: 'mismatch' } })

    await act(async () => {
      fireEvent.click(confirm)
    })
    expect(rekeyMasterPassword).not.toHaveBeenCalled()
    expect(screen.getByText(enCommon.settings.encryptionAdmin.rekeyDialog.errors.confirmMismatch)).toBeInTheDocument()

    fireEvent.change(confirmInput, { target: { value: 'shiny-new-pw-5678' } })
    await act(async () => {
      fireEvent.click(confirm)
    })

    await waitFor(() => expect(rekeyMasterPassword).toHaveBeenCalledTimes(1))
    expect(rekeyMasterPassword).toHaveBeenCalledWith({
      old_password: 'old-master-pw-1234',
      new_password: 'shiny-new-pw-5678',
    })
    await waitFor(() => expect(screen.getByText(enCommon.settings.encryptionAdmin.rekeyDialog.success)).toBeInTheDocument())
  })

  it('rejects a new password shorter than the minimum', async () => {
    setStatus('unlocked')
    renderCard()

    fireEvent.click(screen.getByRole('button', { name: enCommon.settings.encryptionAdmin.actions.rotateMaster }))
    const confirm = await screen.findByRole('button', { name: enCommon.settings.encryptionAdmin.rekeyDialog.confirm })
    const oldInput = screen.getByLabelText(enCommon.settings.encryptionAdmin.rekeyDialog.oldPassword)
    const newInput = screen.getByLabelText(enCommon.settings.encryptionAdmin.rekeyDialog.newPassword)
    const confirmInput = screen.getByLabelText(enCommon.settings.encryptionAdmin.rekeyDialog.confirmPassword)

    fireEvent.change(oldInput, { target: { value: 'old' } })
    fireEvent.change(newInput, { target: { value: 'short' } })
    fireEvent.change(confirmInput, { target: { value: 'short' } })
    await act(async () => {
      fireEvent.click(confirm)
    })

    expect(rekeyMasterPassword).not.toHaveBeenCalled()
    expect(screen.getByText(/New password must be at least 12 characters/i)).toBeInTheDocument()
  })
})
