import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Terminal, Globe, Database } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { CopyButton } from '@/shared/components/copy-button'
import { useInfoQuery, useTargetsQuery } from '@/features/gateway/api'
import { shellEscape } from '@/shared/lib/shell-escape'
import type { TargetSnapshot } from '@/features/gateway/lib/api-client'

function TargetIcon({ kind }: { kind: TargetSnapshot['kind'] }) {
  if (kind === 'Ssh') return <Terminal className="size-4" />
  if (kind === 'MySql' || kind === 'Postgres') return <Database className="size-4" />
  return <Globe className="size-4" />
}

function buildSshCommand(target: TargetSnapshot, externalHost?: string, sshPort?: number): string {
  const host = externalHost ?? 'gateway'
  const portFlag = sshPort && sshPort !== 22 ? ['-p', String(sshPort)] : []
  return shellEscape(['ssh', ...portFlag, '-l', target.name, host])
}

function TargetCard({ target, infoData }: { target: TargetSnapshot; infoData: { external_host?: string; ports?: { ssh?: number } } | undefined }) {
  const { t } = useTranslation('gateway')

  const isSsh = target.kind === 'Ssh'
  const isHttp = target.kind === 'Api' || target.kind === 'WebAdmin'

  const sshCmd = isSsh ? buildSshCommand(target, infoData?.external_host, infoData?.ports?.ssh) : null

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <TargetIcon kind={target.kind} />
            <CardTitle className="text-base truncate">{target.name}</CardTitle>
          </div>
          <Badge variant="secondary" className="shrink-0">{target.kind}</Badge>
        </div>
        {target.description && (
          <p className="text-sm text-muted-foreground truncate">{target.description}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {isSsh && sshCmd && (
          <div className="flex items-center gap-1">
            <code className="flex-1 text-xs bg-muted px-2 py-1 rounded font-mono truncate">{sshCmd}</code>
            <CopyButton value={sshCmd} label={t('targetList.copyCommand')} />
            <Button asChild size="sm" variant="outline">
              <Link to={`/ui/ssh/${encodeURIComponent(target.name)}`}>
                <Terminal className="size-3.5 mr-1" />
                {t('targetList.openTerminal')}
              </Link>
            </Button>
          </div>
        )}
        {isHttp && infoData?.external_host && (
          <a
            href={`https://${infoData.external_host}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary underline-offset-2 hover:underline"
          >
            {`https://${infoData.external_host}`}
          </a>
        )}
        {target.group && (
          <Badge variant="outline" className="text-xs">{target.group.name}</Badge>
        )}
      </CardContent>
    </Card>
  )
}

export function Component() {
  const { t } = useTranslation('gateway')
  const [search, setSearch] = useState('')
  const targetsQuery = useTargetsQuery(search || undefined)
  const infoQuery = useInfoQuery()

  const targets = targetsQuery.data ?? []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-heading font-semibold">{t('pages.targetList')}</h1>
        <Input
          placeholder={t('targetList.search')}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-xs"
        />
      </div>

      {targetsQuery.isPending && (
        <div className="text-muted-foreground text-sm">{t('common:actions.loading')}</div>
      )}

      {targetsQuery.isSuccess && targets.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">{t('targetList.empty')}</div>
      )}

      {targets.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {targets.map(target => (
            <TargetCard key={target.name} target={target} infoData={infoQuery.data} />
          ))}
        </div>
      )}
    </div>
  )
}
