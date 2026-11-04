import type { KnownHost } from '@/shared/types/domain'
import { Copy } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useTargets } from '@/features/targets/hooks/use-targets-queries'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogBody, DialogHeader } from '@/shared/ui/dialog'
import { sha256Fingerprint } from '../host-key-fingerprint'

/** Everything known about one trusted host key, and the SSH targets that rely on it. */
export function KnownHostDetailsDialog({ host, onClose }: { host: KnownHost, onClose: () => void }) {
  const { t } = useTranslation()
  const targets = useTargets().data ?? []
  const [fingerprint, setFingerprint] = React.useState<string | null>(null)
  const keyLine = `${host.algo} ${host.fingerprint}`
  const users = targets.filter(target => target.kind === 'ssh' && target.host === host.hostname && target.port === host.port)

  React.useEffect(() => {
    let current = true
    void sha256Fingerprint(host.fingerprint).then((value) => {
      if (current)
        setFingerprint(value)
    })
    return () => {
      current = false
    }
  }, [host.fingerprint])

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {})
  }

  return (
    <Dialog open onClose={onClose} width={600}>
      <DialogHeader title={t('knownHosts.details.title', { host: host.host })} onClose={onClose} />
      <DialogBody className="flex flex-col gap-4 text-[13px]">
        <dl className="m-0 grid grid-cols-[130px_1fr] gap-x-4 gap-y-2.5">
          <dt className="text-muted-foreground">{t('knownHosts.trust.host')}</dt>
          <dd className="m-0 font-mono">{host.hostname}</dd>
          <dt className="text-muted-foreground">{t('knownHosts.trust.port')}</dt>
          <dd className="m-0 font-mono">{host.port}</dd>
          <dt className="text-muted-foreground">{t('knownHosts.details.keyType')}</dt>
          <dd className="m-0 font-mono">{host.algo}</dd>
          <dt className="text-muted-foreground">{t('knownHosts.trust.fingerprint')}</dt>
          <dd className="m-0 break-all font-mono">{fingerprint ?? '—'}</dd>
        </dl>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-muted-foreground">{t('knownHosts.trust.key')}</span>
            <Button variant="ghost" size="sm" onClick={() => copy(keyLine)}>
              <Copy size={13} />
              <span>{t('knownHosts.details.copy')}</span>
            </Button>
          </div>
          <pre className="m-0 whitespace-pre-wrap break-all rounded-md border border-border bg-secondary/40 p-2.5 font-mono text-[11.5px]">{keyLine}</pre>
        </div>
        <div>
          <div className="mb-1 text-muted-foreground">{t('knownHosts.details.targets')}</div>
          {users.length === 0
            ? <p className="m-0 text-muted-foreground">{t('knownHosts.details.noTargets')}</p>
            : (
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {users.map(target => <li key={target.id} className="font-medium">{target.name}</li>)}
                </ul>
              )}
        </div>
      </DialogBody>
    </Dialog>
  )
}
