import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/lib/api/http'
import { LoginPage } from './login-page'

const state = vi.hoisted(() => ({
  authState: null as null | { state: string },
  authStateIntervals: [] as (number | false)[],
  continueMutate: vi.fn(),
  loginMutateAsync: vi.fn(),
  otpMutateAsync: vi.fn(),
  siteTitle: null as string | null,
}))

vi.mock('@/shared/hooks/use-info', () => ({
  useInfo: () => ({ data: { site_title: state.siteTitle } }),
}))

vi.mock('@/shared/hooks/use-auth', () => ({
  useLogin: () => ({ mutateAsync: state.loginMutateAsync, isPending: false }),
  useSubmitOtp: () => ({ mutateAsync: state.otpMutateAsync, isPending: false }),
  useStartSso: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSsoProviders: () => ({ data: [], isLoading: false }),
  useAuthState: (interval: number | false) => {
    state.authStateIntervals.push(interval)
    return { data: state.authState, isLoading: false }
  },
  useContinueAuth: () => ({ mutate: state.continueMutate }),
}))

const assign = vi.fn()

beforeEach(() => {
  state.authState = null
  state.authStateIntervals = []
  state.siteTitle = null
  vi.clearAllMocks()
  state.loginMutateAsync.mockRejectedValue(new ApiError(401, 'HTTP 401', { state: 'WebUserApprovalNeeded' }))
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign, search: '' },
  })
})
afterEach(cleanup)

async function submitCredentials() {
  fireEvent.change(screen.getByLabelText('login.username'), { target: { value: 'alice' } })
  fireEvent.change(screen.getByLabelText('login.password'), { target: { value: 'pw' } })
  fireEvent.click(screen.getByRole('button', { name: 'actions.signIn' }))
  await waitFor(() => expect(screen.getByText('login.waitingApproval')).toBeTruthy())
}

it('polls the auth state while waiting for approval and finishes the login on success', async () => {
  const view = render(<LoginPage />)
  await submitCredentials()
  expect(state.authStateIntervals.at(-1)).toBe(2000)

  state.continueMutate.mockImplementation((_: unknown, opts: { onSuccess: () => void }) => opts.onSuccess())
  state.authState = { state: 'Success' }
  await act(async () => {
    view.rerender(<LoginPage />)
  })

  await waitFor(() => expect(state.continueMutate).toHaveBeenCalledTimes(1))
  expect(assign).toHaveBeenCalledWith('/ui/')
})

it('returns to the password step when the approval is rejected', async () => {
  const view = render(<LoginPage />)
  await submitCredentials()

  state.authState = { state: 'Failed' }
  await act(async () => {
    view.rerender(<LoginPage />)
  })

  await waitFor(() => expect(screen.getByLabelText('login.username')).toBeTruthy())
  expect(screen.getByRole('alert').textContent).toContain('login.errorFailed')
  expect(state.continueMutate).not.toHaveBeenCalled()
})

it('shows only the logo and the configured site title above the form', () => {
  state.siteTitle = 'Ops Bastion'
  render(<LoginPage />)
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Ops Bastion')
})

it('falls back to the built-in title when none is configured', () => {
  render(<LoginPage />)
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Gated')
})

function otpBoxes() {
  return screen.getAllByLabelText<HTMLInputElement>('a11y.auth.otpDigit')
}

it('fills every OTP box from a pasted code, ignoring spaces', async () => {
  state.authState = { state: 'OtpNeeded' }
  state.otpMutateAsync.mockResolvedValue(undefined)
  render(<LoginPage />)
  await waitFor(() => expect(otpBoxes()).toHaveLength(6))
  fireEvent.paste(otpBoxes()[0]!, { clipboardData: { getData: () => '123 456' } })
  expect(otpBoxes().map(box => box.value).join('')).toBe('123456')
  fireEvent.click(screen.getByRole('button', { name: 'login.verifyAndSignIn' }))
  await waitFor(() => expect(state.otpMutateAsync).toHaveBeenCalledWith({ otp: '123456' }))
})

it('accepts a whole code autofilled into one OTP box', async () => {
  state.authState = { state: 'OtpNeeded' }
  render(<LoginPage />)
  await waitFor(() => expect(otpBoxes()).toHaveLength(6))
  fireEvent.change(otpBoxes()[0]!, { target: { value: '654321' } })
  expect(otpBoxes().map(box => box.value).join('')).toBe('654321')
})
