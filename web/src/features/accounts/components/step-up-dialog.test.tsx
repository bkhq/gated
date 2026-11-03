import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { StepUpDialog } from './step-up-dialog'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/shared/ui/select', () => ({ Select: ({ id, value, onValueChange, options }: { id?: string, value: string, onValueChange: (value: string) => void, options: { value: string, label: string }[] }) => <select id={id} value={value} onChange={event => onValueChange(event.target.value)}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> }))
afterEach(cleanup)

it('accepts a pasted OTP code with spaces', async () => {
  const onConfirm = vi.fn().mockResolvedValue(undefined)
  render(<StepUpDialog open title="t" description="d" confirmLabel="ok" onCancel={vi.fn()} onConfirm={onConfirm} />)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'otp' } })
  fireEvent.change(screen.getByLabelText('accounts.form.reveal.otp'), { target: { value: '123 456' } })
  fireEvent.click(screen.getByRole('button', { name: 'ok' }))
  await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ otp: '123456' }))
})
