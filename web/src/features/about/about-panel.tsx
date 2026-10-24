import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useInfo } from '@/shared/hooks/use-info'
import { Check, Copy } from '@/shared/lib/icons'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Skeleton } from '@/shared/ui/skeleton'

// Gateway version, address and listener ports from `/api/info`; readable by
// every signed-in user.
export function AboutPanel() {
  const { t } = useTranslation()
  const info = useInfo()
  const data = info.data

  const listeners: [string, number | null][] = data
    ? [
        [t('about.listeners.admin'), data.ports.http],
        ['SSH', data.ports.ssh],
        ['MySQL', data.ports.mysql],
        ['PostgreSQL', data.ports.postgres],
        [t('about.listeners.http'), data.ports.kubernetes],
      ]
    : []

  return (
    <div className="px-6 pt-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('about.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {data
            ? (
                <dl className="m-0 grid grid-cols-[140px_1fr] items-center gap-x-4 gap-y-2.5 text-[13px]">
                  <dt className="text-muted-foreground">{t('about.version')}</dt>
                  <dd className="m-0"><Value text={data.version} /></dd>
                  <dt className="text-muted-foreground">{t('about.host')}</dt>
                  <dd className="m-0"><Value text={data.external_host} /></dd>
                  {data.http_proxy_base_domain
                    ? (
                        <>
                          <dt className="text-muted-foreground">{t('about.httpBaseDomain')}</dt>
                          <dd className="m-0"><Value text={data.http_proxy_base_domain} /></dd>
                        </>
                      )
                    : null}
                  <dt className="col-span-2 mt-2 text-[12.5px] font-medium text-foreground">{t('about.listeners.title')}</dt>
                  {listeners.map(([label, port]) => (
                    <React.Fragment key={label}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="m-0">
                        {port === null
                          ? <span className="text-muted-foreground">{t('about.disabled')}</span>
                          : <Value text={String(port)} />}
                      </dd>
                    </React.Fragment>
                  ))}
                </dl>
              )
            : <Skeleton className="h-32 w-full" />}
        </CardContent>
      </Card>
    </div>
  )
}

function Value({ text }: { text: string | null }) {
  const { t } = useTranslation()
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    if (!copied)
      return undefined
    const timer = setTimeout(setCopied, 1500, false)
    return () => clearTimeout(timer)
  }, [copied])

  if (!text)
    return <span className="text-muted-foreground">—</span>
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono">{text}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="h-5 w-5"
        aria-label={copied ? t('about.copied') : t('about.copy')}
        title={copied ? t('about.copied') : t('about.copy')}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {})
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </Button>
    </span>
  )
}
