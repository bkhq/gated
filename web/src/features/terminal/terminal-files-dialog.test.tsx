import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/lib/api/http'

vi.mock('@/shared/lib/api/sftp', async importOriginal => ({
  ...(await importOriginal<typeof import('@/shared/lib/api/sftp')>()),
  listDirectory: vi.fn(),
  uploadFile: vi.fn(),
}))

const api = await import('@/shared/lib/api/sftp')
const { TerminalFilesDialog } = await import('./terminal-files-dialog')

const file = new File(['hello'], 'notes.txt')

describe('terminalFilesDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.listDirectory).mockResolvedValue({ path: '/root', entries: [] })
  })

  it('uploads dropped files to the home directory by default', async () => {
    vi.mocked(api.uploadFile).mockResolvedValue()
    const onClose = vi.fn()
    render(<TerminalFilesDialog mode="upload" targetName="box" initialFiles={[file]} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'terminal.files.upload' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(vi.mocked(api.uploadFile).mock.calls[0]?.slice(0, 2)).toEqual(['box', '/root/notes.txt'])
  })

  it('asks before overwriting an existing file', async () => {
    vi.mocked(api.uploadFile).mockRejectedValueOnce(new ApiError(409, 'HTTP 409', { error: 'exists' })).mockResolvedValue()
    render(<TerminalFilesDialog mode="upload" targetName="box" initialFiles={[file]} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('terminal.files.destination'), { target: { value: '/tmp' } })
    fireEvent.click(screen.getByRole('button', { name: 'terminal.files.upload' }))
    fireEvent.click(await screen.findByRole('button', { name: 'terminal.files.overwrite' }))
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.uploadFile).mock.calls[1]?.[1]).toBe('/tmp/notes.txt')
    expect(vi.mocked(api.uploadFile).mock.calls[1]?.[3]).toMatchObject({ overwrite: true })
    expect(api.listDirectory).not.toHaveBeenCalled()
  })

  it('downloads an absolute path only', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<TerminalFilesDialog mode="download" targetName="box" onClose={vi.fn()} />)
    const button = screen.getByRole('button', { name: 'terminal.files.download' })
    fireEvent.change(screen.getByLabelText('terminal.files.remotePath'), { target: { value: 'etc/hosts' } })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText('terminal.files.remotePath'), { target: { value: '/etc/hosts' } })
    fireEvent.click(button)
    expect(click).toHaveBeenCalled()
    expect((click.mock.contexts[0] as HTMLAnchorElement).getAttribute('href')).toBe('/api/sftp/box/download?path=%2Fetc%2Fhosts')
    click.mockRestore()
  })
})
