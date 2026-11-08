import type { Selection, SelectMode, SortKey, SortState } from './lib/entries'
import type { UploadItem } from './upload-panel'
import type { SftpEntry } from '@/shared/lib/api/sftp'
import type { DropdownItem } from '@/shared/ui/dropdown-menu'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUp,
  Copy,
  Download,
  Eye,
  FolderOpen,
  FolderPlus,
  Info,
  PanelLeft,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ApiError } from '@/shared/lib/api/http'
import {
  downloadUrl,
  listDirectory,
  makeDirectory,
  removePath,
  renamePath,
  sftpErrorMessage,
  uploadFile,
} from '@/shared/lib/api/sftp'
import { toastError } from '@/shared/lib/toast-error'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { ContextMenu } from '@/shared/ui/context-menu'
import { Dialog } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { DetailsPanel } from './details-panel'
import { FileList } from './file-list'
import { FileTree } from './file-tree'
import { applySelection, NO_SELECTION, sortEntries } from './lib/entries'
import { joinPath, parentPath } from './lib/paths'
import { PathBar } from './path-bar'
import { PreviewDialog } from './preview-dialog'
import { UploadPanel } from './upload-panel'

type PendingDialog
  = | { type: 'mkdir' }
    | { type: 'rename', entry: SftpEntry }
    | { type: 'remove', entries: SftpEntry[] }

interface PendingOverwrite {
  file: File
  /** The folder the upload started in, which may no longer be the current one. */
  dir: string
}

// Browsers drop downloads started in the same tick.
const DOWNLOAD_GAP_MS = 400

let uploadSeq = 0

export function FileManager({ targetName, account, className }: { targetName: string, account?: string, className?: string }) {
  const target = React.useMemo(() => ({ name: targetName, account }), [targetName, account])
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  // undefined = the login directory; the server answers with its canonical path.
  const [path, setPath] = React.useState<string | undefined>(undefined)
  const [dialog, setDialog] = React.useState<PendingDialog | null>(null)
  const [overwrites, setOverwrites] = React.useState<PendingOverwrite[]>([])
  const [uploads, setUploads] = React.useState<UploadItem[]>([])
  const [dragging, setDragging] = React.useState(false)
  const [treeOpen, setTreeOpen] = React.useState(true)
  const [filter, setFilter] = React.useState('')
  const [sort, setSort] = React.useState<SortState>({ key: 'name', order: 'asc' })
  const [selection, setSelection] = React.useState<Selection>(NO_SELECTION)
  const [detailsName, setDetailsName] = React.useState<string | null>(null)
  const [preview, setPreview] = React.useState<SftpEntry | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const listing = useQuery({
    queryKey: ['sftp', targetName, account ?? null, path ?? null],
    queryFn: async ({ signal }) => listDirectory(target, path, signal),
    retry: false,
    // The pane shows why the directory could not be listed.
    meta: { inlineError: true },
  })
  const cwd = listing.data?.path ?? path ?? ''

  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['sftp', targetName] })
  }, [queryClient, targetName])

  const navigate = (next: string) => {
    setSelection(NO_SELECTION)
    setDetailsName(null)
    setFilter('')
    setPath(next)
  }

  const run = async (action: () => Promise<void>) => {
    try {
      await action()
    }
    catch (err) {
      toastError(err)
    }
    refresh()
  }

  const patchUpload = (id: number, patch: Partial<UploadItem>) => {
    setUploads(items => items.map(item => (item.id === id ? { ...item, ...patch } : item)))
  }

  const startUpload = async (file: File, dir: string, overwrite: boolean) => {
    uploadSeq += 1
    const id = uploadSeq
    const controller = new AbortController()
    setUploads(items => [...items, { id, name: file.name, size: file.size, loaded: 0, status: 'uploading', controller }])
    try {
      await uploadFile(target, joinPath(dir, file.name), file, {
        overwrite,
        signal: controller.signal,
        onProgress: loaded => patchUpload(id, { loaded }),
      })
      patchUpload(id, { status: 'done', loaded: file.size })
    }
    catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        patchUpload(id, { status: 'canceled' })
        return
      }
      if (!overwrite && err instanceof ApiError && err.status === 409) {
        setUploads(items => items.filter(item => item.id !== id))
        setOverwrites(pending => [...pending, { file, dir }])
        return
      }
      patchUpload(id, { status: 'error', error: sftpErrorMessage(err) })
      toastError(err)
    }
    refresh()
  }

  const uploadFiles = (files: FileList | null) => {
    for (const file of Array.from(files ?? []))
      void startUpload(file, cwd, false)
  }

  const pathOf = (entry: SftpEntry) => joinPath(cwd, entry.name)

  const entries = React.useMemo(() => {
    const term = filter.trim().toLowerCase()
    const all = listing.data?.entries ?? []
    return sortEntries(term ? all.filter(entry => entry.name.toLowerCase().includes(term)) : all, sort)
  }, [listing.data, filter, sort])
  const order = entries.map(entry => entry.name)
  const selected = entries.filter(entry => selection.names.has(entry.name))
  const downloadable = selected.filter(entry => entry.kind !== 'dir')
  const single = selected.length === 1 ? selected[0] : undefined
  const details = detailsName === null ? undefined : entries.find(entry => entry.name === detailsName)
  const listError = listing.error ? sftpErrorMessage(listing.error) : null

  const select = (name: string, mode: SelectMode) => setSelection(current => applySelection(current, order, name, mode))

  const open = (entry: SftpEntry) => {
    // Symlinks may point at directories; opening one lists it, or shows the error.
    if (entry.kind === 'dir' || entry.kind === 'symlink')
      navigate(pathOf(entry))
    else if (entry.kind === 'file')
      setPreview(entry)
  }

  const download = (list: SftpEntry[]) => {
    list.forEach((entry, index) => {
      window.setTimeout(() => {
        const anchor = document.createElement('a')
        anchor.href = downloadUrl(target, pathOf(entry))
        anchor.download = entry.name
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      }, index * DOWNLOAD_GAP_MS)
    })
  }

  const remove = async (list: SftpEntry[]) => {
    setSelection(NO_SELECTION)
    for (const entry of list) {
      try {
        await removePath(target, pathOf(entry), entry.kind === 'dir')
      }
      catch (err) {
        toast.error(`${entry.name}: ${sftpErrorMessage(err)}`)
      }
    }
    refresh()
  }

  const copyPath = (entry: SftpEntry) => {
    void navigator.clipboard?.writeText(pathOf(entry)).catch(() => {})
  }

  const canEdit = listing.data !== undefined
  const pickFiles = () => fileInputRef.current?.click()

  const entryMenu = (): DropdownItem[] => [
    ...(single
      ? [
          { label: t(single.kind === 'file' ? 'files.actions.preview' : 'files.actions.open'), icon: single.kind === 'file' ? Eye : FolderOpen, shortcut: 'Enter', onClick: () => open(single) },
        ]
      : []),
    ...(downloadable.length > 0
      ? [{ label: t('files.actions.downloadSelected'), icon: Download, onClick: () => download(downloadable) }]
      : []),
    ...(single
      ? [
          'separator' as const,
          { label: t('files.actions.rename'), icon: Pencil, shortcut: 'F2', onClick: () => setDialog({ type: 'rename', entry: single }) },
          { label: t('files.actions.copyPath'), icon: Copy, onClick: () => copyPath(single) },
          { label: t('files.actions.details'), icon: Info, onClick: () => setDetailsName(single.name) },
        ]
      : []),
    'separator',
    { label: t('actions.delete'), icon: Trash2, danger: true, shortcut: 'Del', onClick: () => setDialog({ type: 'remove', entries: selected }) },
  ]

  const blankMenu = (): DropdownItem[] => [
    { label: t('files.actions.newFolder'), icon: FolderPlus, disabled: !canEdit, onClick: () => setDialog({ type: 'mkdir' }) },
    { label: t('files.actions.upload'), icon: Upload, disabled: !canEdit, onClick: pickFiles },
    'separator',
    { label: t('actions.refresh'), icon: RefreshCw, onClick: refresh },
  ]

  const moveSelection = (step: number) => {
    const from = selection.anchor === null ? -1 : order.indexOf(selection.anchor)
    const next = order[from === -1 ? (step > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, from + step))]
    if (next !== undefined)
      select(next, 'single')
  }

  const onListKeyDown = (event: React.KeyboardEvent) => {
    const command = event.ctrlKey || event.metaKey
    let handled = true
    if (command && event.key.toLowerCase() === 'a')
      setSelection({ names: new Set(order), anchor: order[0] ?? null })
    else if (event.key === 'Escape')
      setSelection(NO_SELECTION)
    else if (event.key === 'ArrowDown')
      moveSelection(1)
    else if (event.key === 'ArrowUp')
      moveSelection(-1)
    else if (event.key === 'Backspace' && cwd && cwd !== '/')
      navigate(parentPath(cwd))
    else if (event.key === 'Enter' && single)
      open(single)
    else if (event.key === 'F2' && single)
      setDialog({ type: 'rename', entry: single })
    else if (event.key === 'Delete' && selected.length > 0)
      setDialog({ type: 'remove', entries: selected })
    else
      handled = false
    if (handled)
      event.preventDefault()
  }

  const onSort = (key: SortKey) => {
    setSort(current => ({ key, order: current.key === key && current.order === 'asc' ? 'desc' : 'asc' }))
  }

  const removing = dialog?.type === 'remove' ? dialog.entries : null
  const onlyRemoving = removing?.length === 1 ? removing[0] : undefined
  const overwriting = overwrites[0]

  return (
    <div
      className={cn('@container relative flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card', className)}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target)
          setDragging(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        uploadFiles(event.dataTransfer.files)
      }}
    >
      <div className="flex flex-none flex-wrap items-center gap-1 border-b border-border p-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="hidden @2xl:inline-flex"
          aria-label={t('files.tree.toggle')}
          aria-pressed={treeOpen}
          title={t('files.tree.toggle')}
          onClick={() => setTreeOpen(value => !value)}
        >
          <PanelLeft size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('files.actions.up')}
          title={t('files.actions.up')}
          disabled={!cwd || cwd === '/'}
          onClick={() => navigate(parentPath(cwd))}
        >
          <ArrowUp size={14} />
        </Button>
        <PathBar cwd={cwd} onNavigate={navigate} />
        <div className="w-44">
          <Input
            icon={Search}
            wrapperClassName="h-8"
            value={filter}
            onChange={event => setFilter(event.target.value)}
            placeholder={t('files.filter')}
            aria-label={t('files.filter')}
          />
        </div>
        <Button variant="ghost" size="icon-sm" aria-label={t('actions.refresh')} title={t('actions.refresh')} onClick={refresh}>
          <RefreshCw size={14} className={cn(listing.isFetching && 'animate-spin')} />
        </Button>
        <Button variant="outline" size="sm" disabled={!canEdit} onClick={() => setDialog({ type: 'mkdir' })}>
          <FolderPlus size={14} />
          <span>{t('files.actions.newFolder')}</span>
        </Button>
        <Button size="sm" disabled={!canEdit} onClick={pickFiles}>
          <Upload size={14} />
          <span>{t('files.actions.upload')}</span>
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            uploadFiles(event.target.files)
            event.target.value = ''
          }}
        />
      </div>

      {listError
        ? (
            <div role="alert" className="flex flex-none items-start gap-2 border-b border-border bg-[hsl(var(--destructive)/0.08)] px-3 py-2 text-[12.5px] text-destructive">
              <span className="min-w-0 flex-1 break-words">{listError}</span>
            </div>
          )
        : null}

      <div className="relative flex min-h-0 flex-1">
        {treeOpen
          ? (
              <div className="hidden w-56 flex-none overflow-auto border-r border-border @2xl:block">
                <FileTree target={target} cwd={cwd} onNavigate={navigate} />
              </div>
            )
          : null}
        <ContextMenu
          items={selected.length > 0 ? entryMenu() : blankMenu()}
          className="flex min-w-0 flex-1 flex-col"
          onContextMenu={(event) => {
            if (!(event.target as HTMLElement).closest('[data-name]'))
              setSelection(NO_SELECTION)
          }}
        >
          <FileList
            entries={entries}
            loading={listing.isLoading}
            empty={listing.data
              ? <div className="flex min-h-40 flex-1 items-center justify-center text-[13px] text-muted-foreground">{t('files.empty')}</div>
              : null}
            selection={selection}
            sort={sort}
            onSort={onSort}
            onSelect={select}
            onClearSelection={() => setSelection(NO_SELECTION)}
            onOpen={open}
            onEntryContextMenu={(entry) => {
              if (!selection.names.has(entry.name))
                setSelection({ names: new Set([entry.name]), anchor: entry.name })
            }}
            onKeyDown={onListKeyDown}
          />
        </ContextMenu>
        {details
          ? <DetailsPanel entry={details} path={pathOf(details)} onCopyPath={() => copyPath(details)} onClose={() => setDetailsName(null)} />
          : null}
      </div>

      <div className="flex h-8 flex-none items-center gap-2 border-t border-border px-3 text-[12px] text-muted-foreground">
        <span>{t('files.itemCount', { count: entries.length })}</span>
        {selected.length > 0
          ? (
              <>
                <span>{`· ${t('common.selectedCount', { count: selected.length })}`}</span>
                <span className="flex-1" />
                {downloadable.length > 0
                  ? (
                      <Button variant="ghost" size="sm" onClick={() => download(downloadable)}>
                        <Download size={13} />
                        <span>{t('files.actions.downloadSelected')}</span>
                      </Button>
                    )
                  : null}
                <Button variant="ghost" size="sm" className="text-destructive" aria-label={t('files.actions.deleteSelected')} onClick={() => setDialog({ type: 'remove', entries: selected })}>
                  <Trash2 size={13} />
                  <span>{t('files.actions.deleteSelected')}</span>
                </Button>
              </>
            )
          : null}
      </div>

      <UploadPanel uploads={uploads} onClearFinished={() => setUploads(items => items.filter(item => item.status === 'uploading'))} />

      {dragging
        ? (
            <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-[hsl(var(--primary))] bg-[hsl(var(--background)/0.85)] text-[14px] font-medium">
              {t('files.dropHint', { path: cwd })}
            </div>
          )
        : null}

      {preview ? <PreviewDialog target={target} entry={preview} path={pathOf(preview)} onClose={() => setPreview(null)} /> : null}

      <NameDialog
        key={dialog?.type === 'rename' ? `rename-${dialog.entry.name}` : dialog?.type ?? 'closed'}
        open={dialog?.type === 'mkdir' || dialog?.type === 'rename'}
        title={dialog?.type === 'rename' ? t('files.rename.title') : t('files.mkdir.title')}
        initial={dialog?.type === 'rename' ? dialog.entry.name : ''}
        onCancel={() => setDialog(null)}
        onSubmit={(name) => {
          const current = dialog
          setDialog(null)
          if (current?.type === 'rename')
            void run(async () => renamePath(target, pathOf(current.entry), joinPath(cwd, name)))
          else
            void run(async () => makeDirectory(target, joinPath(cwd, name)))
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title={t('files.remove.title')}
        body={onlyRemoving
          ? t(onlyRemoving.kind === 'dir' ? 'files.remove.bodyDir' : 'files.remove.body', { name: onlyRemoving.name })
          : t('files.remove.bodyMany', { count: removing?.length ?? 0 })}
        confirmLabel={t('actions.delete')}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          setDialog(null)
          if (removing)
            void remove(removing)
        }}
      />
      <ConfirmDialog
        open={overwriting !== undefined}
        title={t('files.overwrite.title')}
        body={overwriting ? t('files.overwrite.body', { name: joinPath(overwriting.dir, overwriting.file.name) }) : ''}
        confirmLabel={t('files.overwrite.confirm')}
        onCancel={() => setOverwrites(pending => pending.slice(1))}
        onConfirm={() => {
          setOverwrites(pending => pending.slice(1))
          if (overwriting)
            void startUpload(overwriting.file, overwriting.dir, true)
        }}
      />
    </div>
  )
}

function NameDialog({ open, title, initial, onCancel, onSubmit }: {
  open: boolean
  title: string
  initial: string
  onCancel: () => void
  onSubmit: (name: string) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = React.useState(initial)
  const trimmed = name.trim()
  const valid = trimmed.length > 0 && !trimmed.includes('/') && trimmed !== '.' && trimmed !== '..'
  return (
    <Dialog open={open} onClose={onCancel} width={420}>
      <form
        className="flex flex-col"
        onSubmit={(event) => {
          event.preventDefault()
          if (valid)
            onSubmit(trimmed)
        }}
      >
        <div className="px-6 pb-3 pt-5">
          <h3 className="m-0 text-[16px] font-semibold">{title}</h3>
          <Input
            className="mono mt-3"
            autoFocus
            value={name}
            onChange={event => setName(event.target.value)}
            aria-label={t('fields.name')}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-6 py-3">
          <Button type="button" variant="outline" onClick={onCancel}>{t('actions.cancel')}</Button>
          <Button type="submit" disabled={!valid}>{t('actions.save')}</Button>
        </div>
      </form>
    </Dialog>
  )
}

function ConfirmDialog({ open, title, body, confirmLabel, onCancel, onConfirm }: {
  open: boolean
  title: string
  body: string
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onClose={onCancel} width={420}>
      <div className="flex flex-col">
        <div className="px-6 pb-3 pt-5">
          <h3 className="m-0 text-[16px] font-semibold">{title}</h3>
          <p className="mt-1 break-words text-[13px] text-muted-foreground">{body}</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-6 py-3">
          <Button variant="outline" onClick={onCancel}>{t('actions.cancel')}</Button>
          <Button variant="destructive" onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </Dialog>
  )
}
