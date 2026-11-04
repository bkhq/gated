import type { AddSshKnownHostRequest } from '@/shared/lib/api/known-hosts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Download, Loader2 } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { addKnownHost, checkSshHostKey } from '@/shared/lib/api/known-hosts'
import { describeError } from '@/shared/lib/error-message'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Textarea } from '@/shared/ui/textarea'
import { parseHostKeyLine } from '../host-key-line'

export interface TrustHostKeyDialogProps {
  open: boolean
  host?: string
  port?: number
  onClose: () => void
}

/**
 * Trust an SSH host key: fetch it through the gateway and compare the
 * fingerprint, or paste an OpenSSH / known_hosts / ssh-keyscan line.
 */
export function TrustHostKeyDialog({ open, host: initialHost = '', port: initialPort = 22, onClose }: TrustHostKeyDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [host, setHost] = React.useState(initialHost)
  const [port, setPort] = React.useState(String(initialPort))
  const [keyLine, setKeyLine] = React.useState('')
  const [fingerprint, setFingerprint] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const fetchKey = useMutation({
    mutationFn: async () => checkSshHostKey({ host: host.trim(), port: Number(port) }),
    meta: { inlineError: true },
    onSuccess: (key) => {
      setKeyLine(`${key.remote_key_type} ${key.remote_key_base64}`)
      setFingerprint(key.fingerprint)
      setError(null)
    },
    onError: err => setError(describeError(err, t)),
  })

  const trust = useMutation({
    mutationFn: async (req: AddSshKnownHostRequest) => addKnownHost(req),
    meta: { inlineError: true },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['known-hosts'] })
      await queryClient.invalidateQueries({ queryKey: ['targets'] })
      onClose()
    },
    onError: err => setError(describeError(err, t)),
  })

  const portNumber = Number(port)
  const endpointValid = host.trim() !== '' && Number.isInteger(portNumber) && portNumber > 0 && portNumber < 65536

  const submit = () => {
    const key = parseHostKeyLine(keyLine)
    if (!key) {
      setError(t('knownHosts.trust.invalidKey'))
      return
    }
    setError(null)
    trust.mutate({ host: host.trim(), port: portNumber, ...key })
  }

  return (
    <Dialog open={open} onClose={onClose} width={560}>
      <DialogHeader title={t('knownHosts.trust.title')} description={t('knownHosts.trust.description')} onClose={onClose} />
      <DialogBody className="flex flex-col gap-4">
        <div className="grid grid-cols-[1fr_110px] gap-3">
          <div>
            <Label htmlFor="trust-host">{t('knownHosts.trust.host')}</Label>
            <Input id="trust-host" value={host} onChange={event => setHost(event.target.value)} placeholder="10.0.0.1" />
          </div>
          <div>
            <Label htmlFor="trust-port">{t('knownHosts.trust.port')}</Label>
            <Input id="trust-port" inputMode="numeric" value={port} onChange={event => setPort(event.target.value)} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-end justify-between gap-2">
            <Label htmlFor="trust-key">{t('knownHosts.trust.key')}</Label>
            <Button variant="outline" size="sm" onClick={() => fetchKey.mutate()} disabled={!endpointValid || fetchKey.isPending}>
              {fetchKey.isPending ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              <span>{t('knownHosts.trust.fetch')}</span>
            </Button>
          </div>
          <Textarea
            id="trust-key"
            rows={3}
            className="mono text-[12px]"
            value={keyLine}
            placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA…"
            onChange={(event) => {
              setKeyLine(event.target.value)
              setFingerprint(null)
            }}
          />
          <p className="m-0 text-[12px] text-muted-foreground">{t('knownHosts.trust.keyHint')}</p>
        </div>
        {fingerprint
          ? (
              <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-[12.5px]">
                <div className="text-muted-foreground">{t('knownHosts.trust.fingerprint')}</div>
                <div className="mono mt-0.5 break-all">{fingerprint}</div>
                <div className="mt-1 text-muted-foreground">{t('knownHosts.trust.compareHint')}</div>
              </div>
            )
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
        <Button size="sm" onClick={submit} disabled={!endpointValid || keyLine.trim() === '' || trust.isPending}>
          {t('knownHosts.trust.submit')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
