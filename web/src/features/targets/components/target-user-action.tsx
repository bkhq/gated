import type { Target } from '@/shared/types/domain'
import { Info, Monitor, Terminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'

// Primary action of a target in the user's lists: terminal targets connect
// straight away; HTTP targets are opened from their detail page, which holds
// the token needed for the proxy URL.
export function TargetUserAction({ target, variant, onOpen, onConnect }: {
  target: Target
  variant?: 'default' | 'outline'
  onOpen: (target: Target) => void
  onConnect?: (target: Target) => void
}) {
  const { t } = useTranslation()
  const http = target.kind === 'http'
  const desktop = target.kind === 'rdp' || target.kind === 'vnc'
  return (
    <Button
      size="sm"
      variant={variant}
      onClick={(event) => {
        event.stopPropagation()
        if (http)
          onOpen(target)
        else
          onConnect?.(target)
      }}
    >
      {http ? <Info size={13} /> : desktop ? <Monitor size={13} /> : <Terminal size={13} />}
      <span>{http ? t('actions.details') : t('actions.connect')}</span>
    </Button>
  )
}
