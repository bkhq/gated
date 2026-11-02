import type { CommandAclRule } from '@/shared/lib/api/command-acl'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// Stub the form dialog so the page test doesn't pull in targets/roles queries.
vi.mock('@/features/command-acl/components/command-acl-form-dialog', () => ({
  CommandAclFormDialog: () => null,
}))

vi.mock('@/features/command-acl/hooks/use-command-acl-queries', () => ({
  useCommandAclRules: vi.fn(),
  useDeleteCommandAclRule: vi.fn(),
}))

const hooks = await import('@/features/command-acl/hooks/use-command-acl-queries')
const useCommandAclRules = vi.mocked(hooks.useCommandAclRules)
const useDeleteCommandAclRule = vi.mocked(hooks.useDeleteCommandAclRule)

const { CommandAclPage } = await import('./command-acl-page')

function rule(overrides: Partial<CommandAclRule>): CommandAclRule {
  return {
    id: 1,
    name: 'rule',
    enabled: true,
    priority: 0,
    protocol: 'ssh',
    match_type: 'keyword',
    pattern: 'x',
    action: 'deny',
    target_id: null,
    role_id: null,
    description: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  }
}

const RULES: CommandAclRule[] = [
  rule({ id: 1, name: 'block rm', pattern: 'rm -rf', action: 'deny' }),
  rule({ id: 2, name: 'allow ls', pattern: 'ls', action: 'allow' }),
]

beforeEach(() => {
  vi.clearAllMocks()
  useCommandAclRules.mockReturnValue({ data: RULES, isLoading: false } as unknown as ReturnType<typeof hooks.useCommandAclRules>)
  useDeleteCommandAclRule.mockReturnValue({ mutateAsync: vi.fn(), isPending: false } as unknown as ReturnType<typeof hooks.useDeleteCommandAclRule>)
})

describe('commandAclPage', () => {
  it('renders the rules in a table', () => {
    render(<CommandAclPage />)
    expect(screen.getByText('block rm')).toBeInTheDocument()
    expect(screen.getByText('allow ls')).toBeInTheDocument()
  })

  it('filters rules by the search query', () => {
    render(<CommandAclPage />)
    const search = screen.getByLabelText('actions.search')
    fireEvent.change(search, { target: { value: 'rm' } })
    expect(screen.getByText('block rm')).toBeInTheDocument()
    expect(screen.queryByText('allow ls')).not.toBeInTheDocument()
  })
})
