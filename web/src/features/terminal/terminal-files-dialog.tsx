import { AlertTriangle, Loader2 } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/shared/lib/api/http'
import { downloadUrl, listDirectory, sftpErrorMessage, uploadFile } from '@/shared/lib/api/sftp'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { joinPath } from '../files/lib/paths'

export type TerminalFilesMode = 'upload' | 'download'

export interface TerminalFilesDialogProps {
  mode: TerminalFilesMode | null
  targetName: string
  /** Files dropped onto the terminal, preselected for upload. */
  initialFiles?: File[]
  onClose: () => void
}

/** Upload files to, or download a file from, the SSH target over SFTP. */
export function TerminalFilesDialog({ mode, targetName, initialFiles = [], onClose }: TerminalFilesDialogProps) {
  const { t } = useTranslation()
  const [directory, setDirectory] = React.useState('')
  const [files, setFiles] = React.useState<File[]>(initialFiles)
  const [path, setPath] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [progress, setProgress] = React.useState<string | null>(null)
  const [conflict, setConflict] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const destination = directory.trim()
  const destinationValid = destination === '' || destination.startsWith('/')

  const upload = async (overwrite: boolean) => {
    setBusy(true)
    setError(null)
    setConflict(null)
    try {
      const dir = destination || (await listDirectory(targetName)).path
      for (const file of files) {
        const target = joinPath(dir, file.name)
        setProgress(`${file.name} 0%`)
        try {
          await uploadFile(targetName, target, file, {
            overwrite,
            onProgress: loaded => setProgress(`${file.name} ${file.size ? Math.round(loaded / file.size * 100) : 100}%`),
          })
        }
        catch (err) {
          if (!overwrite && err instanceof ApiError && err.status === 409) {
            setConflict(target)
            return
          }
          throw err
        }
      }
      onClose()
    }
    catch (err) {
      setError(sftpErrorMessage(err))
    }
    finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const download = () => {
    const anchor = document.createElement('a')
    anchor.href = downloadUrl(targetName, path.trim())
    anchor.download = ''
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    onClose()
  }

  return (
    <Dialog open={mode !== null} onClose={onClose} width={480}>
      <DialogHeader title={t(mode === 'download' ? 'terminal.files.downloadTitle' : 'terminal.files.uploadTitle')} onClose={onClose} />
      <DialogBody className="flex flex-col gap-4">
        {mode === 'download'
          ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="terminal-download-path">{t('terminal.files.remotePath')}</Label>
                <Input id="terminal-download-path" className="mono text-[12px]" value={path} placeholder="/var/log/syslog" onChange={event => setPath(event.target.value)} />
              </div>
            )
          : (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="terminal-upload-files">{t('terminal.files.files')}</Label>
                  <input
                    id="terminal-upload-files"
                    type="file"
                    multiple
                    className="text-[13px]"
                    onChange={event => setFiles(Array.from(event.target.files ?? []))}
                  />
                  {files.length > 0
                    ? <p className="m-0 truncate text-[12px] text-muted-foreground">{files.map(file => file.name).join(', ')}</p>
                    : null}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="terminal-upload-dir">{t('terminal.files.destination')}</Label>
                  <Input id="terminal-upload-dir" className="mono text-[12px]" value={directory} placeholder={t('terminal.files.home')} onChange={event => setDirectory(event.target.value)} />
                </div>
              </>
            )}
        {progress ? <p className="m-0 text-[12.5px] text-muted-foreground">{progress}</p> : null}
        {conflict
          ? <p role="alert" className="m-0 text-[12.5px]">{t('terminal.files.exists', { path: conflict })}</p>
          : null}
        {error
          ? (
              <div role="alert" className="flex items-start gap-2 text-[12.5px] text-destructive">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )
          : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>{t('actions.cancel')}</Button>
        {mode === 'download'
          ? <Button size="sm" onClick={download} disabled={!path.trim().startsWith('/')}>{t('terminal.files.download')}</Button>
          : conflict
            ? <Button size="sm" variant="destructive" onClick={() => void upload(true)} disabled={busy}>{t('terminal.files.overwrite')}</Button>
            : (
                <Button size="sm" onClick={() => void upload(false)} disabled={busy || files.length === 0 || !destinationValid}>
                  {busy ? <Loader2 size={13} className="animate-spin" /> : null}
                  <span>{t('terminal.files.upload')}</span>
                </Button>
              )}
      </DialogFooter>
    </Dialog>
  )
}
