import type { SftpEntry } from '@/shared/lib/api/sftp'
import type { TargetRef } from '@/shared/lib/api/target-ref'
import { useQuery } from '@tanstack/react-query'
import { Download, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { downloadUrl, readFile, sftpErrorMessage } from '@/shared/lib/api/sftp'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { bytesToDataUrl, imageMime, isBinary, previewMode } from './lib/entries'
import { formatSize } from './lib/paths'

type PreviewContent = { kind: 'text', text: string } | { kind: 'image', src: string } | { kind: 'binary' }

function Message({ children }: { children: string }) {
  return <p className="m-0 py-10 text-center text-[13px] text-muted-foreground">{children}</p>
}

export function PreviewDialog({ target, entry, path, onClose }: {
  target: TargetRef
  entry: SftpEntry
  path: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const mode = previewMode(entry)
  const content = useQuery<PreviewContent>({
    // Outside the `sftp` key: refreshing the listing must not read the file
    // again, since each read is audited as a download.
    queryKey: ['sftp-preview', target, path],
    queryFn: async ({ signal }) => {
      const bytes = new Uint8Array(await readFile(target, path, signal))
      if (mode === 'image')
        return { kind: 'image', src: bytesToDataUrl(bytes, imageMime(entry.name)) }
      return isBinary(bytes) ? { kind: 'binary' } : { kind: 'text', text: new TextDecoder().decode(bytes) }
    },
    enabled: mode !== null,
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    // The dialog shows why the file could not be read.
    meta: { inlineError: true },
  })

  return (
    <Dialog open onClose={onClose} width={960}>
      <DialogHeader title={entry.name} onClose={onClose} />
      <DialogBody>
        {mode === null ? <Message>{t('files.preview.unavailable')}</Message> : null}
        {mode !== null && content.isPending
          ? (
              <div role="status" className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
                <Loader2 size={14} className="animate-spin" />
                <span>{t('states.loading')}</span>
              </div>
            )
          : null}
        {content.error ? <p role="alert" className="m-0 py-10 text-center text-[13px] text-destructive">{sftpErrorMessage(content.error)}</p> : null}
        {content.data?.kind === 'binary' ? <Message>{t('files.preview.binary')}</Message> : null}
        {content.data?.kind === 'text'
          ? <pre className="mono m-0 max-h-[65vh] overflow-auto whitespace-pre text-[12px]">{content.data.text}</pre>
          : null}
        {content.data?.kind === 'image'
          ? <img src={content.data.src} alt={entry.name} className="mx-auto max-h-[65vh] max-w-full object-contain" />
          : null}
      </DialogBody>
      <DialogFooter>
        <span className="mono mr-auto text-[12px] text-muted-foreground">{formatSize(entry.size)}</span>
        <a
          href={downloadUrl(target, path)}
          download={entry.name}
          className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md border border-input px-3 text-[13px] hover:bg-accent"
        >
          <Download size={14} />
          <span>{t('files.preview.download')}</span>
        </a>
        <Button size="sm" variant="outline" onClick={onClose}>{t('actions.close')}</Button>
      </DialogFooter>
    </Dialog>
  )
}
