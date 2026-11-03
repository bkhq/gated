import type { ImportSSHKeyRequest, StoredSSHKey } from '@/shared/lib/api/ssh-keys'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, KeyRound, Upload } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/shared/lib/api/http'
import { generateSshKeys, importSshKey, listSshKeys } from '@/shared/lib/api/ssh-keys'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { Label } from '@/shared/ui/label'
import { PasswordInput } from '@/shared/ui/password-input'
import { Skeleton } from '@/shared/ui/skeleton'
import { Textarea } from '@/shared/ui/textarea'

const SSH_KEYS_QUERY_KEY = ['ssh-keys'] as const

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && typeof err.body === 'string' && err.body)
    return err.body
  if (err instanceof Error && err.message)
    return err.message
  return fallback
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[12.5px] text-destructive"
    >
      <AlertCircle size={14} aria-hidden="true" />
      <span>{message}</span>
    </div>
  )
}

/** The gateway's SSH host keys, stored in the database. */
export function SshKeysCard() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: SSH_KEYS_QUERY_KEY,
    queryFn: async ({ signal }) => listSshKeys(signal),
  })
  const [importOpen, setImportOpen] = React.useState(false)
  const generate = useMutation({
    mutationFn: async () => generateSshKeys(),
    onSuccess: async () => qc.invalidateQueries({ queryKey: SSH_KEYS_QUERY_KEY }),
  })

  const keys = query.data ?? []
  const hasKeys = keys.length > 0

  return (
    <div className="px-6 pt-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>{t('settings.sshKeys.title')}</CardTitle>
              <div className="mt-1 text-[12.5px] text-muted-foreground">{t('settings.sshKeys.hint')}</div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => generate.mutate()}
                disabled={query.isLoading || hasKeys || generate.isPending}
              >
                <KeyRound size={13} />
                <span>{t('settings.sshKeys.generate')}</span>
              </Button>
              <Button variant="outline" size="sm" onClick={() => setImportOpen(true)} disabled={query.isLoading}>
                <Upload size={13} />
                <span>{t('settings.sshKeys.import')}</span>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {query.isLoading
            ? <Skeleton className="h-4 w-full" />
            : query.isError
              ? <ErrorBanner message={t('settings.sshKeys.loadError')} />
              : (
                  hasKeys ? <KeyList keys={keys} /> : <ErrorBanner message={t('settings.sshKeys.noHostKeys')} />
                )}
          {generate.isError ? <ErrorBanner message={errorMessage(generate.error, t('settings.sshKeys.generateError'))} /> : null}
        </CardContent>
      </Card>
      <Dialog open={importOpen} onClose={() => setImportOpen(false)} width={520}>
        {importOpen ? <ImportDialogBody onClose={() => setImportOpen(false)} /> : null}
      </Dialog>
    </div>
  )
}

function KeyList({ keys }: { keys: StoredSSHKey[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {keys.map(key => (
        <li key={key.id} className="flex flex-wrap items-center gap-2 text-[12.5px]">
          <span className="font-mono">{key.algorithm}</span>
          <span className="font-mono text-muted-foreground" title={key.public_key_openssh}>{key.fingerprint}</span>
        </li>
      ))}
    </ul>
  )
}

function ImportDialogBody({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [pem, setPem] = React.useState('')
  const [passphrase, setPassphrase] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: async (req: ImportSSHKeyRequest) => importSshKey(req),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: SSH_KEYS_QUERY_KEY })
      onClose()
    },
    onError: err => setError(errorMessage(err, t('settings.sshKeys.importDialog.error'))),
  })

  const submit = () => {
    if (!pem.trim()) {
      setError(t('settings.sshKeys.importDialog.required'))
      return
    }
    setError(null)
    mutation.mutate({ private_key_pem: pem, passphrase: passphrase || null })
  }

  return (
    <>
      <DialogHeader
        title={t('settings.sshKeys.importDialog.title')}
        description={t('settings.sshKeys.importDialog.description')}
        onClose={mutation.isPending ? undefined : onClose}
      />
      <DialogBody className="flex flex-col gap-2.5">
        <div>
          <Label htmlFor="ssh-key-pem">{t('settings.sshKeys.importDialog.privateKey')}</Label>
          <Textarea
            id="ssh-key-pem"
            rows={8}
            spellCheck={false}
            className="font-mono text-[12px]"
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            value={pem}
            onChange={event => setPem(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="ssh-key-passphrase">{t('settings.sshKeys.importDialog.passphrase')}</Label>
          <PasswordInput
            id="ssh-key-passphrase"
            autoComplete="off"
            value={passphrase}
            onChange={event => setPassphrase(event.target.value)}
            toggleLabelShow={t('encryption.passwordShow')}
            toggleLabelHide={t('encryption.passwordHide')}
          />
        </div>
        {error ? <ErrorBanner message={error} /> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose} disabled={mutation.isPending}>
          {t('settings.sshKeys.importDialog.cancel')}
        </Button>
        <Button size="sm" onClick={submit} disabled={mutation.isPending}>
          {t('settings.sshKeys.importDialog.submit')}
        </Button>
      </DialogFooter>
    </>
  )
}
