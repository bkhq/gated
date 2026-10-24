import type { SftpEntry } from '@/shared/lib/api/sftp'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUp,
  Download,
  File,
  FileSymlink,
  Folder,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { RowActionsMenu } from '@/shared/components/row-actions-menu'
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
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Skeleton } from '@/shared/ui/skeleton'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'
import { formatMode, formatSize, joinPath, parentPath, pathSegments } from './lib/paths'

interface UploadItem {
  id: number
  name: string
  size: number
  loaded: number
  status: 'uploading' | 'done' | 'error'
  error?: string
}

type PendingDialog
  = | { type: 'mkdir' }
    | { type: 'rename', entry: SftpEntry }
    | { type: 'remove', entry: SftpEntry }
    | { type: 'overwrite', file: File }

let uploadSeq = 0

function formatMtime(seconds: number | null | undefined): string {
  if (seconds == null)
    return '—'
  return new Date(seconds * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function EntryIcon({ kind }: { kind: string }) {
  if (kind === 'dir')
    return <Folder size={15} className="text-[hsl(var(--primary))]" />
  if (kind === 'symlink')
    return <FileSymlink size={15} className="text-muted-foreground" />
  return <File size={15} className="text-muted-foreground" />
}

export function FileManager({ targetName, className }: { targetName: string, className?: string }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  // undefined = the login directory; the server answers with its canonical path.
  const [path, setPath] = React.useState<string | undefined>(undefined)
  // null = show the current directory; a string while the user edits the path.
  const [pathDraft, setPathDraft] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [dialog, setDialog] = React.useState<PendingDialog | null>(null)
  const [uploads, setUploads] = React.useState<UploadItem[]>([])
  const [dragging, setDragging] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const listing = useQuery({
    queryKey: ['sftp', targetName, path ?? null],
    queryFn: async ({ signal }) => listDirectory(targetName, path, signal),
    retry: false,
  })
  const cwd = listing.data?.path ?? path ?? ''

  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['sftp', targetName] })
  }, [queryClient, targetName])

  const navigate = (next: string) => {
    setActionError(null)
    setPathDraft(null)
    setPath(next)
  }

  const run = async (action: () => Promise<void>) => {
    setActionError(null)
    try {
      await action()
    }
    catch (err) {
      setActionError(sftpErrorMessage(err))
    }
    refresh()
  }

  const patchUpload = (id: number, patch: Partial<UploadItem>) => {
    setUploads(items => items.map(item => (item.id === id ? { ...item, ...patch } : item)))
  }

  const startUpload = async (file: File, overwrite: boolean) => {
    uploadSeq += 1
    const id = uploadSeq
    setUploads(items => [...items, { id, name: file.name, size: file.size, loaded: 0, status: 'uploading' }])
    try {
      await uploadFile(targetName, joinPath(cwd, file.name), file, {
        overwrite,
        onProgress: loaded => patchUpload(id, { loaded }),
      })
      patchUpload(id, { status: 'done', loaded: file.size })
    }
    catch (err) {
      if (!overwrite && err instanceof ApiError && err.status === 409) {
        setUploads(items => items.filter(item => item.id !== id))
        setDialog({ type: 'overwrite', file })
        return
      }
      patchUpload(id, { status: 'error', error: sftpErrorMessage(err) })
    }
    refresh()
  }

  const uploadFiles = (files: FileList | null) => {
    for (const file of Array.from(files ?? []))
      void startUpload(file, false)
  }

  const entries = listing.data?.entries ?? []
  const listError = listing.error ? sftpErrorMessage(listing.error) : null

  return (
    <div
      className={cn('relative flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card', className)}
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
      <div className="flex flex-none flex-wrap items-center gap-1.5 border-b border-border p-2">
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
        {pathDraft === null
          ? (
              <div
                className="flex h-8 min-w-[160px] flex-1 cursor-text items-center gap-1 rounded-md border border-input bg-background pl-1 pr-0.5"
                onClick={(event) => {
                  // Only clicks on the empty area switch to editing; segments navigate.
                  if (event.target === event.currentTarget)
                    setPathDraft(cwd)
                }}
              >
                <nav aria-label={t('files.breadcrumbs')} className="flex min-w-0 items-center overflow-hidden text-[12.5px]">
                  {pathSegments(cwd).map((segment, index) => (
                    <React.Fragment key={segment.path}>
                      {index > 1 ? <span className="shrink-0 px-0.5 text-muted-foreground">/</span> : null}
                      <button
                        type="button"
                        className="focus-ring mono min-w-0 truncate rounded px-1 py-0.5 hover:bg-accent"
                        onClick={() => navigate(segment.path)}
                      >
                        {segment.name}
                      </button>
                    </React.Fragment>
                  ))}
                </nav>
                <button
                  type="button"
                  className="focus-ring ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={t('files.editPath')}
                  title={t('files.editPath')}
                  onClick={() => setPathDraft(cwd)}
                >
                  <Pencil size={13} />
                </button>
              </div>
            )
          : (
              <form
                className="min-w-[160px] flex-1"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (pathDraft.trim())
                    navigate(pathDraft.trim())
                }}
              >
                <Input
                  className="mono text-[12.5px]"
                  wrapperClassName="h-8"
                  autoFocus
                  value={pathDraft}
                  onChange={event => setPathDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape')
                      setPathDraft(null)
                  }}
                  onBlur={() => setPathDraft(null)}
                  aria-label={t('files.pathLabel')}
                />
              </form>
            )}
        <Button variant="ghost" size="icon-sm" aria-label={t('actions.refresh')} title={t('actions.refresh')} onClick={refresh}>
          <RefreshCw size={14} className={cn(listing.isFetching && 'animate-spin')} />
        </Button>
        <Button variant="outline" size="sm" disabled={!listing.data} onClick={() => setDialog({ type: 'mkdir' })}>
          <FolderPlus size={14} />
          <span>{t('files.actions.newFolder')}</span>
        </Button>
        <Button size="sm" disabled={!listing.data} onClick={() => fileInputRef.current?.click()}>
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

      {listError || actionError
        ? (
            <div role="alert" className="flex flex-none items-start gap-2 border-b border-border bg-[hsl(var(--destructive)/0.08)] px-3 py-2 text-[12.5px] text-destructive">
              <span className="min-w-0 flex-1 break-words">{actionError ?? listError}</span>
              {actionError
                ? (
                    <button type="button" aria-label={t('actions.close')} onClick={() => setActionError(null)}>
                      <X size={13} />
                    </button>
                  )
                : null}
            </div>
          )
        : null}

      <div className="min-h-0 flex-1 overflow-auto">
        <Table className="rounded-none border-0">
          <THead>
            <TR>
              <TH className="pl-4">{t('fields.name')}</TH>
              <TH className="w-[100px] text-right">{t('files.fields.size')}</TH>
              <TH className="hidden w-[160px] md:table-cell">{t('files.fields.modified')}</TH>
              <TH className="hidden w-[110px] lg:table-cell">{t('files.fields.permissions')}</TH>
              <TH className="w-[48px] pr-3" aria-label={t('fields.actions')} />
            </TR>
          </THead>
          <TBody>
            {listing.isLoading
              ? Array.from({ length: 6 }, (_, index) => (
                  <TR key={`files-skeleton-${String(index)}`} className="h-9">
                    <TD className="py-1.5 pl-4"><Skeleton className="h-3.5 w-40" /></TD>
                    <TD className="py-1.5"><Skeleton className="ml-auto h-3.5 w-12" /></TD>
                    <TD className="hidden py-1.5 md:table-cell"><Skeleton className="h-3.5 w-28" /></TD>
                    <TD className="hidden py-1.5 lg:table-cell"><Skeleton className="h-3.5 w-20" /></TD>
                    <TD className="py-1.5" />
                  </TR>
                ))
              : entries.length === 0 && listing.data
                ? (
                    <TR>
                      <TD colSpan={5} className="py-10 text-center text-[13px] text-muted-foreground">
                        {t('files.empty')}
                      </TD>
                    </TR>
                  )
                : entries.map(entry => (
                    <EntryRow
                      key={entry.name}
                      entry={entry}
                      href={downloadUrl(targetName, joinPath(cwd, entry.name))}
                      onOpen={() => navigate(joinPath(cwd, entry.name))}
                      onRename={() => setDialog({ type: 'rename', entry })}
                      onRemove={() => setDialog({ type: 'remove', entry })}
                    />
                  ))}
          </TBody>
        </Table>
      </div>

      {uploads.length > 0
        ? (
            <div className="flex max-h-40 flex-none flex-col gap-1 overflow-auto border-t border-border px-3 py-2" aria-label={t('files.uploads.title')}>
              <div className="flex items-center justify-between text-[12px] font-medium">
                <span>{t('files.uploads.title')}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setUploads(items => items.filter(item => item.status === 'uploading'))}
                >
                  {t('files.uploads.clear')}
                </Button>
              </div>
              {uploads.map(item => (
                <div key={item.id} className="flex items-center gap-2 text-[12px]">
                  <span className="mono min-w-0 flex-1 truncate" title={item.name}>{item.name}</span>
                  {item.status === 'error'
                    ? <span className="min-w-0 max-w-[50%] truncate text-destructive" title={item.error}>{item.error}</span>
                    : (
                        <span className="tabular text-muted-foreground">
                          {item.status === 'done'
                            ? t('files.uploads.done')
                            : `${formatSize(item.loaded)} / ${formatSize(item.size)}`}
                        </span>
                      )}
                </div>
              ))}
            </div>
          )
        : null}

      {dragging
        ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border-2 border-dashed border-[hsl(var(--primary))] bg-[hsl(var(--background)/0.85)] text-[14px] font-medium">
              {t('files.dropHint', { path: cwd })}
            </div>
          )
        : null}

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
            void run(async () => renamePath(targetName, joinPath(cwd, current.entry.name), joinPath(cwd, name)))
          else
            void run(async () => makeDirectory(targetName, joinPath(cwd, name)))
        }}
      />
      <ConfirmDialog
        open={dialog?.type === 'remove' || dialog?.type === 'overwrite'}
        title={dialog?.type === 'overwrite' ? t('files.overwrite.title') : t('files.remove.title')}
        body={dialog?.type === 'overwrite'
          ? t('files.overwrite.body', { name: dialog.file.name })
          : dialog?.type === 'remove'
            ? t(dialog.entry.kind === 'dir' ? 'files.remove.bodyDir' : 'files.remove.body', { name: dialog.entry.name })
            : ''}
        confirmLabel={dialog?.type === 'overwrite' ? t('files.overwrite.confirm') : t('actions.delete')}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          const current = dialog
          setDialog(null)
          if (current?.type === 'overwrite')
            void startUpload(current.file, true)
          else if (current?.type === 'remove')
            void run(async () => removePath(targetName, joinPath(cwd, current.entry.name), current.entry.kind === 'dir'))
        }}
      />
    </div>
  )
}

interface EntryRowProps {
  entry: SftpEntry
  href: string
  onOpen: () => void
  onRename: () => void
  onRemove: () => void
}

function EntryRow({ entry, href, onOpen, onRename, onRemove }: EntryRowProps) {
  const { t } = useTranslation()
  // Symlinks may point at directories; opening one lists it, or shows the error.
  const navigable = entry.kind === 'dir' || entry.kind === 'symlink'
  const downloadable = entry.kind !== 'dir'
  return (
    <TR className="h-9">
      <TD className="py-1.5 pl-4">
        <div className="flex min-w-0 items-center gap-2">
          <EntryIcon kind={entry.kind} />
          {navigable
            ? (
                <button type="button" className="focus-ring mono truncate rounded text-left text-[13px] hover:underline" onClick={onOpen}>
                  {entry.name}
                </button>
              )
            : <span className="mono truncate text-[13px]">{entry.name}</span>}
        </div>
      </TD>
      <TD className="mono tabular py-1.5 text-right text-[12px] text-muted-foreground">
        {entry.kind === 'dir' ? '—' : formatSize(entry.size)}
      </TD>
      <TD className="mono tabular hidden py-1.5 text-[12px] text-muted-foreground md:table-cell">{formatMtime(entry.mtime)}</TD>
      <TD className="mono hidden py-1.5 text-[12px] text-muted-foreground lg:table-cell">{formatMode(entry.permissions, entry.kind)}</TD>
      <TD className="py-1 pr-3 text-right">
        <div className="flex items-center justify-end gap-0.5">
          {downloadable
            ? (
                <a
                  href={href}
                  download={entry.name}
                  className="focus-ring inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={t('files.actions.download', { name: entry.name })}
                  title={t('files.actions.download', { name: entry.name })}
                >
                  <Download size={14} />
                </a>
              )
            : null}
          <RowActionsMenu
            label={t('files.actions.more', { name: entry.name })}
            items={[
              { label: t('files.actions.rename'), icon: Pencil, onClick: onRename },
              'separator',
              { label: t('actions.delete'), icon: Trash2, danger: true, onClick: onRemove },
            ]}
          />
        </div>
      </TD>
    </TR>
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
