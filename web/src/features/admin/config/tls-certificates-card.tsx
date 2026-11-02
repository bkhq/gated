import type { ListenerCertificate, TlsListener } from '@/shared/lib/api/tls-certificates'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, RefreshCw, Upload } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/shared/lib/api/http'
import { generateTlsCertificate, importTlsCertificate, listTlsCertificates } from '@/shared/lib/api/tls-certificates'
import { formatFullDateTime } from '@/shared/lib/format-time'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { Label } from '@/shared/ui/label'
import { Skeleton } from '@/shared/ui/skeleton'
import { Textarea } from '@/shared/ui/textarea'

const TLS_CERTIFICATES_QUERY_KEY = ['tls-certificates'] as const

interface Action { kind: 'import' | 'generate', listener: TlsListener }

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

/** Certificates of the HTTP proxy, MySQL and PostgreSQL listeners, stored in the database. */
export function TlsCertificatesCard() {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: TLS_CERTIFICATES_QUERY_KEY,
    queryFn: async ({ signal }) => listTlsCertificates(signal),
  })
  const [action, setAction] = React.useState<Action | null>(null)
  const close = () => setAction(null)

  return (
    <div className="px-6 pt-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.tlsCertificates.title')}</CardTitle>
          <div className="mt-1 text-[12.5px] text-muted-foreground">{t('settings.tlsCertificates.hint')}</div>
        </CardHeader>
        <CardContent>
          {query.isLoading
            ? <Skeleton className="h-4 w-full" />
            : query.isError
              ? <ErrorBanner message={t('settings.tlsCertificates.loadError')} />
              : (
                  <ul className="m-0 flex list-none flex-col divide-y p-0">
                    {(query.data ?? []).map(cert => (
                      <CertificateRow key={cert.listener} cert={cert} onAction={kind => setAction({ kind, listener: cert.listener })} />
                    ))}
                  </ul>
                )}
        </CardContent>
      </Card>
      <Dialog open={action !== null} onClose={close} width={action?.kind === 'import' ? 560 : 440}>
        {action?.kind === 'import' ? <ImportDialogBody listener={action.listener} onClose={close} /> : null}
        {action?.kind === 'generate' ? <GenerateDialogBody listener={action.listener} onClose={close} /> : null}
      </Dialog>
    </div>
  )
}

function CertificateRow({ cert, onAction }: { cert: ListenerCertificate, onAction: (kind: Action['kind']) => void }) {
  const { t, i18n } = useTranslation()
  const name = t(`settings.tlsCertificates.listener.${cert.listener}`)
  const leaf = cert.chain[0]
  return (
    <li aria-label={name} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-col gap-1 text-[12.5px]">
        <span className="text-[13px] font-medium">{name}</span>
        {leaf
          ? (
              <>
                <span>{leaf.subject_alt_names.join(', ') || leaf.subject}</span>
                <span className="text-muted-foreground">
                  {t('settings.tlsCertificates.expires', { when: formatFullDateTime(leaf.not_after, i18n.language) })}
                </span>
                <span className="font-mono break-all text-muted-foreground">{leaf.sha256_fingerprint}</span>
              </>
            )
          : <span className="text-muted-foreground">{t('settings.tlsCertificates.none')}</span>}
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant="outline" size="sm" onClick={() => onAction('generate')}>
          <RefreshCw size={13} />
          <span>{t('settings.tlsCertificates.generate')}</span>
        </Button>
        <Button variant="outline" size="sm" onClick={() => onAction('import')}>
          <Upload size={13} />
          <span>{t('settings.tlsCertificates.import')}</span>
        </Button>
      </div>
    </li>
  )
}

function GenerateDialogBody({ listener, onClose }: { listener: TlsListener, onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: async () => generateTlsCertificate(listener),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: TLS_CERTIFICATES_QUERY_KEY })
      onClose()
    },
  })
  const name = t(`settings.tlsCertificates.listener.${listener}`)
  return (
    <>
      <DialogHeader
        title={t('settings.tlsCertificates.generateDialog.title', { name })}
        description={t('settings.tlsCertificates.generateDialog.description')}
        onClose={mutation.isPending ? undefined : onClose}
      />
      {mutation.isError
        ? <DialogBody><ErrorBanner message={errorMessage(mutation.error, t('settings.tlsCertificates.generateDialog.error'))} /></DialogBody>
        : null}
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose} disabled={mutation.isPending}>
          {t('settings.tlsCertificates.cancel')}
        </Button>
        <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {t('settings.tlsCertificates.generateDialog.submit')}
        </Button>
      </DialogFooter>
    </>
  )
}

function ImportDialogBody({ listener, onClose }: { listener: TlsListener, onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [certificate, setCertificate] = React.useState('')
  const [privateKey, setPrivateKey] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: async () => importTlsCertificate(listener, { certificate_pem: certificate, private_key_pem: privateKey }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: TLS_CERTIFICATES_QUERY_KEY })
      onClose()
    },
    onError: err => setError(errorMessage(err, t('settings.tlsCertificates.importDialog.error'))),
  })

  const submit = () => {
    if (!certificate.trim() || !privateKey.trim()) {
      setError(t('settings.tlsCertificates.importDialog.required'))
      return
    }
    setError(null)
    mutation.mutate()
  }

  const name = t(`settings.tlsCertificates.listener.${listener}`)
  return (
    <>
      <DialogHeader
        title={t('settings.tlsCertificates.importDialog.title', { name })}
        description={t('settings.tlsCertificates.importDialog.description')}
        onClose={mutation.isPending ? undefined : onClose}
      />
      <DialogBody className="flex flex-col gap-2.5">
        <div>
          <Label htmlFor="tls-certificate-pem">{t('settings.tlsCertificates.importDialog.certificate')}</Label>
          <Textarea
            id="tls-certificate-pem"
            rows={6}
            spellCheck={false}
            className="font-mono text-[12px]"
            placeholder="-----BEGIN CERTIFICATE-----"
            value={certificate}
            onChange={event => setCertificate(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="tls-private-key-pem">{t('settings.tlsCertificates.importDialog.privateKey')}</Label>
          <Textarea
            id="tls-private-key-pem"
            rows={6}
            spellCheck={false}
            className="font-mono text-[12px]"
            placeholder="-----BEGIN PRIVATE KEY-----"
            value={privateKey}
            onChange={event => setPrivateKey(event.target.value)}
          />
        </div>
        {error ? <ErrorBanner message={error} /> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose} disabled={mutation.isPending}>
          {t('settings.tlsCertificates.cancel')}
        </Button>
        <Button size="sm" onClick={submit} disabled={mutation.isPending}>
          {t('settings.tlsCertificates.importDialog.submit')}
        </Button>
      </DialogFooter>
    </>
  )
}
