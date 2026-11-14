import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { StepUpDialog } from './step-up-dialog'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

it('accepts a pasted OTP code with spaces', async () => {
  const onConfirm = vi.fn().mockResolvedValue(undefined)
  render(<StepUpDialog open title="t" description="d" confirmLabel="ok" onCancel={vi.fn()} onConfirm={onConfirm} />)
  // The factor is chosen with tabs, password first.
  expect(screen.getByRole('tab', { name: 'accounts.form.reveal.password' })).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(screen.getByRole('tab', { name: 'accounts.form.reveal.otp' }))
  fireEvent.change(screen.getByLabelText('accounts.form.reveal.otp'), { target: { value: '123 456' } })
  fireEvent.click(screen.getByRole('button', { name: 'ok' }))
  await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ otp: '123456' }))
})

it('asks only for the fixed factor', async () => {
  const onConfirm = vi.fn().mockResolvedValue(undefined)
  render(<StepUpDialog open factor="otp" title="t" description="d" confirmLabel="ok" onCancel={vi.fn()} onConfirm={onConfirm} />)
  expect(screen.queryByRole('tab')).toBeNull()
  fireEvent.change(screen.getByLabelText('accounts.form.reveal.otp'), { target: { value: '123456' } })
  fireEvent.click(screen.getByRole('button', { name: 'ok' }))
  await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ otp: '123456' }))
})

it('switching the factor clears what was typed', () => {
  render(<StepUpDialog open title="t" description="d" confirmLabel="ok" onCancel={vi.fn()} onConfirm={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('accounts.form.reveal.password'), { target: { value: 'secret' } })
  fireEvent.click(screen.getByRole('tab', { name: 'accounts.form.reveal.otp' }))
  expect(screen.getByLabelText('accounts.form.reveal.otp')).toHaveValue('')
})
