import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const choices = vi.hoisted(() => ({ value: { isPending: false, data: [] as string[] } }))
vi.mock('@/features/targets/hooks/use-targets-queries', () => ({ useTargetAccountChoices: () => choices.value }))

const { TargetAccountGate } = await import('./target-account-gate')

function renderGate() {
  return render(<TargetAccountGate targetName="web">{account => <div>{`connected as ${account ?? 'default'}`}</div>}</TargetAccountGate>)
}

beforeEach(() => {
  choices.value = { isPending: false, data: [] }
})

it('connects straight away when there is nothing to choose', () => {
  renderGate()
  expect(screen.getByText('connected as default')).toBeInTheDocument()
})

it('asks for the account first when several apply', () => {
  choices.value = { isPending: false, data: ['deploy', 'root'] }
  renderGate()
  expect(screen.queryByText(/connected as/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'root' }))
  expect(screen.getByText('connected as root')).toBeInTheDocument()
})
