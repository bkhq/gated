import type { SftpEntry } from '@/shared/lib/api/sftp'
import { Copy, X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import { EntryIcon } from './entry-icon'
import { formatMode, formatMtime, formatSize } from './lib/paths'

function Field({ label, children }: { label: string, children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="m-0 break-all text-[13px]">{children}</dd>
    </div>
  )
}

export function DetailsPanel({ entry, path, onCopyPath, onClose }: {
  entry: SftpEntry
  path: string
  onCopyPath: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const kinds: Record<string, string> = {
    dir: t('files.kinds.dir'),
    file: t('files.kinds.file'),
    symlink: t('files.kinds.symlink'),
  }
  return (
    <aside aria-label={t('files.details.title')} className="absolute inset-y-0 right-0 z-10 flex w-72 max-w-[85%] flex-col border-l border-border bg-card shadow-lg @3xl:static @3xl:shadow-none">
      <div className="flex flex-none items-center gap-2 border-b border-border py-1.5 pl-3 pr-1.5">
        <EntryIcon entry={entry} size={17} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={entry.name}>{entry.name}</span>
        <Button variant="ghost" size="icon-sm" aria-label={t('actions.close')} onClick={onClose}><X size={14} /></Button>
      </div>
      <dl className="m-0 grid min-h-0 flex-1 content-start gap-3 overflow-auto p-3">
        <Field label={t('files.details.path')}>
          <span className="mono">{path}</span>
          <Button variant="ghost" size="icon-sm" className="ml-1 align-middle" aria-label={t('files.actions.copyPath')} title={t('files.actions.copyPath')} onClick={onCopyPath}>
            <Copy size={13} />
          </Button>
        </Field>
        <Field label={t('files.details.type')}>{kinds[entry.kind] ?? entry.kind}</Field>
        {entry.kind === 'dir' ? null : <Field label={t('files.fields.size')}><span className="mono">{formatSize(entry.size)}</span></Field>}
        <Field label={t('files.fields.modified')}><span className="mono">{formatMtime(entry.mtime)}</span></Field>
        <Field label={t('files.fields.permissions')}><span className="mono">{formatMode(entry.permissions, entry.kind)}</span></Field>
      </dl>
    </aside>
  )
}
