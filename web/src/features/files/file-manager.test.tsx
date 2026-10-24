import type { SftpListing } from '@/shared/lib/api/sftp'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/lib/api/http'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts?.name ? `${key}:${String(opts.name)}` : key) }),
}))

vi.mock('@/shared/lib/api/sftp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/lib/api/sftp')>()
  return {
    ...actual,
    listDirectory: vi.fn(),
    makeDirectory: vi.fn(),
    removePath: vi.fn(),
    renamePath: vi.fn(),
    uploadFile: vi.fn(),
  }
})

const api = await import('@/shared/lib/api/sftp')
const { FileManager } = await import('./file-manager')

const HOME: SftpListing = {
  path: '/root',
  entries: [
    { name: 'logs', kind: 'dir', size: 4096, permissions: 0o40755, mtime: 1_790_000_000, user: null, group: null, uid: 0, gid: 0 },
    { name: 'notes.txt', kind: 'file', size: 1536, permissions: 0o100644, mtime: 1_790_000_000, user: null, group: null, uid: 0, gid: 0 },
  ],
}

function renderManager() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <FileManager targetName="web-1" />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.listDirectory).mockImplementation(async (_target, path) => (
    path === '/root/logs' ? { path: '/root/logs', entries: [] } : HOME
  ))
})

describe('fileManager', () => {
  it('lists the login directory and opens a folder', async () => {
    renderManager()
    expect(await screen.findByText('notes.txt')).toBeInTheDocument()
    expect(screen.getByText('1.5 KB')).toBeInTheDocument()
    expect(screen.getByLabelText('files.actions.download:notes.txt')).toHaveAttribute(
      'href',
      '/api/sftp/web-1/download?path=%2Froot%2Fnotes.txt',
    )

    fireEvent.click(screen.getByRole('button', { name: 'logs' }))
    expect(await screen.findByText('files.empty')).toBeInTheDocument()
    expect(api.listDirectory).toHaveBeenLastCalledWith('web-1', '/root/logs', expect.anything())
  })

  it('asks before overwriting an existing file', async () => {
    vi.mocked(api.uploadFile)
      .mockRejectedValueOnce(new ApiError(409, 'HTTP 409', { error: 'exists' }))
      .mockResolvedValueOnce(undefined)
    const { container } = renderManager()
    await screen.findByText('notes.txt')

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['hello'], 'notes.txt')
    fireEvent.change(input, { target: { files: [file] } })

    fireEvent.click(await screen.findByRole('button', { name: 'files.overwrite.confirm' }))
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.uploadFile).mock.calls[1]?.[1]).toBe('/root/notes.txt')
    expect(vi.mocked(api.uploadFile).mock.calls[1]?.[3]).toMatchObject({ overwrite: true })
  })

  it('shows the server error when listing fails', async () => {
    vi.mocked(api.listDirectory).mockRejectedValue(new ApiError(403, 'HTTP 403', { error: 'File transfer is not allowed on this target' }))
    renderManager()
    expect(await screen.findByRole('alert')).toHaveTextContent('File transfer is not allowed on this target')
  })

  it('navigates from a breadcrumb segment', async () => {
    vi.mocked(api.listDirectory).mockImplementation(async (_target, path) => (
      path === '/' ? { path: '/', entries: [] } : HOME
    ))
    renderManager()
    await screen.findByText('notes.txt')

    const crumbs = screen.getByRole('navigation', { name: 'files.breadcrumbs' })
    fireEvent.click(within(crumbs).getByRole('button', { name: '/' }))
    expect(await screen.findByText('files.empty')).toBeInTheDocument()
    expect(api.listDirectory).toHaveBeenLastCalledWith('web-1', '/', expect.anything())
  })

  it('edits the path and navigates on Enter, cancels on Escape', async () => {
    renderManager()
    await screen.findByText('notes.txt')
    expect(screen.queryByLabelText('files.pathLabel')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'files.editPath' }))
    const input = screen.getByLabelText('files.pathLabel')
    expect(input).toHaveValue('/root')
    expect(input).toHaveFocus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByLabelText('files.pathLabel')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'files.editPath' }))
    const editor = screen.getByLabelText('files.pathLabel')
    fireEvent.change(editor, { target: { value: '/root/logs' } })
    fireEvent.submit(editor)
    expect(await screen.findByText('files.empty')).toBeInTheDocument()
    expect(api.listDirectory).toHaveBeenLastCalledWith('web-1', '/root/logs', expect.anything())
    expect(screen.getByRole('navigation', { name: 'files.breadcrumbs' })).toBeInTheDocument()
  })

  it('does not render an owner column', async () => {
    renderManager()
    await screen.findByText('notes.txt')
    expect(screen.queryByRole('columnheader', { name: 'files.fields.owner' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('columnheader')).toHaveLength(5)
  })
})
