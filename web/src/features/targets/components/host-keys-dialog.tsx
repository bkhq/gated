import type { Target } from '@/shared/types/domain'
import { useQuery } from '@tanstack/react-query'
import { Copy, Key } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { getTargetKnownSshHostKeys } from '@/shared/lib/api/targets'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogBody, DialogHeader } from '@/shared/ui/dialog'

export interface HostKeysDialogProps {
  open: boolean
  target: Target | null
  onClose: () => void
}

// Known SSH host keys recorded for the target's host:port on first connect.
// Admin endpoint: GET /admin/api/targets/:id/known-ssh-host-keys.
export function HostKeysDialog({ open, target, onClose }: HostKeysDialogProps) {
  const { t } = useTranslation()
  const keysQuery = useQuery({
    queryKey: ['targets', target?.id ?? null, 'known-ssh-host-keys'],
    queryFn: async ({ signal }) => getTargetKnownSshHostKeys(target!.id, signal),
    enabled: open && !!target,
  })

  const copyKey = (line: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(line).catch(() => {})
    }
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader title={t('targets.hostKeysDialog.title', { name: target?.name ?? '' })} onClose={onClose} />
      <DialogBody className="flex flex-col gap-2">
        {keysQuery.isLoading
          ? <p className="m-0 text-[13px] text-muted-foreground">{t('states.loading')}</p>
          : keysQuery.isError
            ? <p className="m-0 text-[13px] text-[hsl(var(--destructive))]">{t('targets.hostKeysDialog.error')}</p>
            : (keysQuery.data ?? []).length === 0
                ? <p className="m-0 text-[13px] text-muted-foreground">{t('targets.hostKeysDialog.empty')}</p>
                : (keysQuery.data ?? []).map(key => (
                    <div key={key.id} className="flex items-center gap-2.5 rounded-md border border-border p-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary"><Key size={15} /></div>
                      <div className="min-w-0 flex-1">
                        <div className="mono text-[13px] font-medium">{key.key_type}</div>
                        <div className="mono truncate text-[11px] text-muted-foreground">{key.key_base64}</div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('targets.hostKeysDialog.copy')}
                        title={t('targets.hostKeysDialog.copy')}
                        onClick={() => copyKey(`${key.key_type} ${key.key_base64}`)}
                      >
                        <Copy size={13} />
                      </Button>
                    </div>
                  ))}
      </DialogBody>
    </Dialog>
  )
}
