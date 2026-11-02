import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy } from '@/shared/lib/icons'
import { shortId } from '@/shared/lib/short-id'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'

export function CopyableId({ id, className }: { id: string, className?: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = setTimeout(setCopied, 1500, false)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(id).then(() => setCopied(true), () => {})
    }
  }

  return (
    <span className={cn('inline-flex items-center gap-0.5 align-middle', className)}>
      <span className="font-mono text-xs" title={id}>{shortId(id)}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="h-5 w-5 text-muted-foreground"
        aria-label={copied ? t('events.copied') : t('events.copyId')}
        title={copied ? t('events.copied') : t('events.copyId')}
        onClick={copy}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </Button>
    </span>
  )
}
