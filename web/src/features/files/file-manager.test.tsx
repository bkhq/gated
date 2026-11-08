import type { SftpEntry, SftpListing } from '@/shared/lib/api/sftp'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/lib/api/http'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts?.name ? `${key}:${String(opts.name)}` : key) }),
}))

const toast = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

vi.mock('@/shared/lib/api/sftp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/lib/api/sftp')>()
  return {
    ...actual,
    listDirectory: vi.fn(),
    makeDirectory: vi.fn(),
    removePath: vi.fn(),
    renamePath: vi.fn(),
    uploadFile: vi.fn(),
    readFile: vi.fn(),
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

function listed(path: string | undefined): SftpListing {
  if (path === '/')
    return { path: '/', entries: [dir('root'), { ...dir('swapfile'), kind: 'file' }] }
  if (path === '/root/logs')
    return { path: '/root/logs', entries: [] }
  return HOME
}

function dir(name: string): SftpEntry {
  return { name, kind: 'dir', size: 4096, permissions: 0o40755, mtime: 1_790_000_000, user: null, group: null, uid: 0, gid: 0 }
}

function row(name: string): HTMLElement {
  return within(screen.getByRole('grid')).getByText(name).closest('[role="row"]') as HTMLElement
}

// hidden: an open context menu marks the rest of the page inert.
function selectedNames() {
  return screen.getAllByRole('row', { hidden: true })
    .filter(item => item.getAttribute('aria-selected') === 'true')
    .map(item => item.getAttribute('data-name'))
}

beforeEach(() => {
  vi.clearAllMocks()
  Element.prototype.scrollIntoView = vi.fn()
  vi.mocked(api.listDirectory).mockImplementation(async (_target, path) => listed(path))
})

describe('fileManager', () => {
  it('lists the login directory and opens a folder', async () => {
    renderManager()
    expect(await screen.findByText('notes.txt')).toBeInTheDocument()
    expect(screen.getByText('1.5 KB')).toBeInTheDocument()

    fireEvent.doubleClick(row('logs'))
    expect(await screen.findByText('files.empty')).toBeInTheDocument()
    expect(api.listDirectory).toHaveBeenCalledWith({ name: 'web-1' }, '/root/logs', expect.anything())
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

  it('overwrites in the folder the upload started in, even after navigating away', async () => {
    let reject: (reason: unknown) => void = () => {}
    vi.mocked(api.uploadFile)
      .mockImplementationOnce(async () => new Promise((_resolve, rejectUpload) => {
        reject = rejectUpload
      }))
      .mockResolvedValueOnce(undefined)
    const { container } = renderManager()
    await screen.findByText('notes.txt')
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['hello'], 'notes.txt')] } })
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(1))

    fireEvent.doubleClick(row('logs'))
    await waitFor(() => expect(api.listDirectory).toHaveBeenCalledWith(expect.anything(), '/root/logs', expect.anything()))
    reject(new ApiError(409, 'HTTP 409', { error: 'exists' }))

    fireEvent.click(await screen.findByRole('button', { name: 'files.overwrite.confirm' }))
    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.uploadFile).mock.calls[1]?.[1]).toBe('/root/notes.txt')
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
    expect(api.listDirectory).toHaveBeenCalledWith({ name: 'web-1' }, '/', expect.anything())
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
    expect(api.listDirectory).toHaveBeenCalledWith({ name: 'web-1' }, '/root/logs', expect.anything())
    expect(screen.getByRole('navigation', { name: 'files.breadcrumbs' })).toBeInTheDocument()
  })

  it('does not render an owner column', async () => {
    renderManager()
    await screen.findByText('notes.txt')
    expect(screen.queryByRole('columnheader', { name: 'files.fields.owner' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('columnheader')).toHaveLength(4)
  })

  it('selects with click, Ctrl and Shift', async () => {
    renderManager()
    await screen.findByText('notes.txt')
    fireEvent.click(row('logs'))
    expect(selectedNames()).toEqual(['logs'])
    fireEvent.click(row('notes.txt'), { ctrlKey: true })
    expect(selectedNames()).toEqual(['logs', 'notes.txt'])
    fireEvent.click(row('logs'))
    fireEvent.click(row('notes.txt'), { shiftKey: true })
    expect(selectedNames()).toEqual(['logs', 'notes.txt'])
    fireEvent.click(screen.getByRole('grid'))
    expect(selectedNames()).toEqual([])
  })

  it('sorts by a column and filters the folder', async () => {
    vi.mocked(api.listDirectory).mockResolvedValue({
      path: '/root',
      entries: [{ ...HOME.entries[1]!, name: 'a.txt', size: 1 }, { ...HOME.entries[1]!, name: 'b.txt', size: 9 }],
    })
    renderManager()
    await screen.findByText('a.txt')
    const names = () => screen.getAllByRole('row').map(item => item.getAttribute('data-name')).filter(Boolean)
    expect(names()).toEqual(['a.txt', 'b.txt'])
    fireEvent.click(screen.getByRole('button', { name: 'files.fields.size' }))
    fireEvent.click(screen.getByRole('button', { name: 'files.fields.size' }))
    expect(names()).toEqual(['b.txt', 'a.txt'])
    fireEvent.change(screen.getByLabelText('files.filter'), { target: { value: 'A.T' } })
    expect(names()).toEqual(['a.txt'])
  })

  it('renames from the context menu of an entry', async () => {
    vi.mocked(api.renamePath).mockResolvedValue()
    renderManager()
    await screen.findByText('notes.txt')
    fireEvent.contextMenu(row('notes.txt'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'files.actions.rename' }))
    const input = await screen.findByRole('textbox', { name: 'fields.name' })
    fireEvent.change(input, { target: { value: 'renamed.txt' } })
    fireEvent.submit(input)
    await waitFor(() => expect(api.renamePath).toHaveBeenCalledWith({ name: 'web-1' }, '/root/notes.txt', '/root/renamed.txt'))
  })

  it('offers folder actions on the blank area', async () => {
    renderManager()
    await screen.findByText('notes.txt')
    fireEvent.click(row('logs'))
    fireEvent.contextMenu(screen.getByRole('grid'))
    expect(await screen.findByRole('menuitem', { name: 'files.actions.newFolder' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'files.actions.rename' })).not.toBeInTheDocument()
    expect(selectedNames()).toEqual([])
  })

  it('leaves keys on the column headers to the headers', async () => {
    renderManager()
    await screen.findByText('notes.txt')
    fireEvent.click(row('notes.txt'))
    const header = screen.getByRole('button', { name: 'files.fields.size' })
    expect(fireEvent.keyDown(header, { key: 'Enter' })).toBe(true)
    expect(api.readFile).not.toHaveBeenCalled()
  })

  it('drives the list from the keyboard', async () => {
    renderManager()
    await screen.findByText('notes.txt')
    const grid = screen.getByRole('grid')
    fireEvent.keyDown(grid, { key: 'a', ctrlKey: true })
    expect(selectedNames()).toEqual(['logs', 'notes.txt'])
    fireEvent.keyDown(grid, { key: 'Escape' })
    expect(selectedNames()).toEqual([])
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(selectedNames()).toEqual(['logs'])
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(selectedNames()).toEqual(['notes.txt'])
    fireEvent.keyDown(grid, { key: 'F2' })
    expect(await screen.findByRole('textbox', { name: 'fields.name' })).toHaveValue('notes.txt')
    fireEvent.click(screen.getByRole('button', { name: 'actions.cancel' }))
    fireEvent.keyDown(grid, { key: 'Backspace' })
    await waitFor(() => expect(within(screen.getByRole('navigation', { name: 'files.breadcrumbs' })).queryByRole('button', { name: 'root' })).not.toBeInTheDocument())
  })

  it('deletes several entries and reports the ones that fail', async () => {
    vi.mocked(api.removePath)
      .mockRejectedValueOnce(new ApiError(400, 'HTTP 400', { error: 'not empty' }))
      .mockResolvedValueOnce(undefined)
    renderManager()
    await screen.findByText('notes.txt')
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'a', ctrlKey: true })
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'Delete' })
    expect(await screen.findByText('files.remove.bodyMany')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'actions.delete' }))
    await waitFor(() => expect(api.removePath).toHaveBeenCalledTimes(2))
    expect(api.removePath).toHaveBeenNthCalledWith(1, { name: 'web-1' }, '/root/logs', true)
    expect(api.removePath).toHaveBeenNthCalledWith(2, { name: 'web-1' }, '/root/notes.txt', false)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('logs: not empty'))
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('downloads the selected files but not folders', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderManager()
    await screen.findByText('notes.txt')
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'a', ctrlKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'files.actions.downloadSelected' }))
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
    expect((click.mock.contexts[0] as HTMLAnchorElement).getAttribute('href')).toBe('/api/sftp/web-1/download?path=%2Froot%2Fnotes.txt')
    click.mockRestore()
  })

  it('shows folders only in the tree and navigates from it', async () => {
    renderManager()
    await screen.findByText('notes.txt')
    const tree = screen.getByRole('navigation', { name: 'files.tree.label' })
    await within(tree).findByRole('button', { name: 'root' })
    expect(within(tree).queryByText('swapfile')).not.toBeInTheDocument()
    fireEvent.click(await within(tree).findByRole('button', { name: 'logs' }))
    expect(await screen.findByText('files.empty')).toBeInTheDocument()
  })

  it('cancels an upload from the panel', async () => {
    vi.mocked(api.uploadFile).mockImplementation(async (_target, _path, _file, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')))
    }))
    const { container } = renderManager()
    await screen.findByText('notes.txt')
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File(['x'], 'big.bin')] } })
    fireEvent.click(await screen.findByRole('button', { name: 'files.uploads.cancel:big.bin' }))
    expect(await screen.findByText('files.uploads.canceled')).toBeInTheDocument()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('shows the details of an entry', async () => {
    renderManager()
    await screen.findByText('notes.txt')
    fireEvent.contextMenu(row('notes.txt'))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'files.actions.details' }))
    const panel = await screen.findByRole('complementary', { name: 'files.details.title' })
    expect(within(panel).getByText('/root/notes.txt')).toBeInTheDocument()
    expect(within(panel).getByText('-rw-r--r--')).toBeInTheDocument()
  })

  describe('preview', () => {
    const open = async (entries?: SftpEntry[]) => {
      if (entries)
        vi.mocked(api.listDirectory).mockResolvedValue({ path: '/root', entries })
      renderManager()
      await screen.findByText(entries?.[0]?.name ?? 'notes.txt')
      fireEvent.doubleClick(row(entries?.[0]?.name ?? 'notes.txt'))
    }

    it('shows a text file', async () => {
      vi.mocked(api.readFile).mockResolvedValue(new TextEncoder().encode('hello world').buffer)
      await open()
      expect(await screen.findByText('hello world')).toBeInTheDocument()
      expect(api.readFile).toHaveBeenCalledWith({ name: 'web-1' }, '/root/notes.txt', expect.anything())
    })

    it('shows an image', async () => {
      vi.mocked(api.readFile).mockResolvedValue(new TextEncoder().encode('hi!').buffer)
      await open([{ ...HOME.entries[1]!, name: 'a.png' }])
      expect(await screen.findByRole('img', { name: 'a.png' })).toHaveAttribute('src', 'data:image/png;base64,aGkh')
    })

    it('refuses binary content', async () => {
      vi.mocked(api.readFile).mockResolvedValue(new Uint8Array([1, 0, 2]).buffer)
      await open()
      expect(await screen.findByText('files.preview.binary')).toBeInTheDocument()
    })

    it('offers a download instead of fetching a file that is too large', async () => {
      await open([{ ...HOME.entries[1]!, name: 'big.log', size: 5 * 1024 * 1024 }])
      expect(await screen.findByText('files.preview.unavailable')).toBeInTheDocument()
      expect(api.readFile).not.toHaveBeenCalled()
      expect(screen.getByRole('link', { name: 'files.preview.download' })).toHaveAttribute('href', '/api/sftp/web-1/download?path=%2Froot%2Fbig.log')
    })

    it('shows why a file could not be read', async () => {
      vi.mocked(api.readFile).mockRejectedValue(new ApiError(403, 'HTTP 403', { error: 'Permission denied' }))
      await open()
      expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied')
    })
  })
})
