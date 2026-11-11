import { Copy } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useTargets } from '@/features/targets/hooks/use-targets-queries'
import { useInfo } from '@/shared/hooks/use-info'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { claimLink, connectionCommand } from '../lib/handoff'

export interface TicketShareDialogProps {
  /** The one-time secret of the ticket just created; null closes the dialog. */
  secret: string | null
  targetName: string | null
  onClose: () => void
}

function Row({ label, value, hint, onCopy }: { label: string, value: string, hint?: string, onCopy: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
        <Button variant="ghost" size="sm" aria-label={t('tickets.share.copyLabel', { what: label })} onClick={onCopy}>
          <Copy size={13} />
          <span>{t('tickets.share.copy')}</span>
        </Button>
      </div>
      <div className="mono break-all rounded-md border border-border bg-[hsl(var(--muted)/0.4)] p-3 text-[12.5px]">{value}</div>
      {hint ? <div className="text-[12px] text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

/** Everything the recipient needs, shown once right after a ticket is created. */
export function TicketShareDialog({ secret, targetName, onClose }: TicketShareDialogProps) {
  const { t } = useTranslation()
  const info = useInfo()
  const targets = useTargets()
  const [copied, setCopied] = React.useState('')

  const copy = (label: string, value: string) => {
    void navigator.clipboard?.writeText(value)
    setCopied(t('tickets.share.copied', { what: label }))
    window.setTimeout(setCopied, 1500, '')
  }

  const kind = targets.data?.find(target => target.name === targetName)?.kind
  const command = secret && kind && info.data
    ? connectionCommand(kind, { host: info.data.external_host, ports: info.data.ports }, secret)
    : null

  return (
    <Dialog open={secret !== null} onClose={onClose} width={600}>
      <DialogHeader title={t('tickets.share.title', { target: targetName ?? '' })} description={t('tickets.share.oneTimeHint')} onClose={onClose} />
      {secret
        ? (
            <DialogBody className="grid gap-4">
              <Row label={t('tickets.share.link')} value={claimLink(window.location.origin, secret)} hint={t('tickets.share.linkHint')} onCopy={() => copy(t('tickets.share.link'), claimLink(window.location.origin, secret))} />
              {command
                ? <Row label={t('tickets.share.command')} value={command} hint={t('tickets.share.anyPassword')} onCopy={() => copy(t('tickets.share.command'), command)} />
                : null}
              <Row label={t('tickets.share.secret')} value={secret} onCopy={() => copy(t('tickets.share.secret'), secret)} />
              <div role="status" aria-live="polite" className="min-h-4 text-[12px] text-muted-foreground">{copied}</div>
            </DialogBody>
          )
        : null}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{t('actions.close')}</Button>
      </DialogFooter>
    </Dialog>
  )
}
