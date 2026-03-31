import type { TargetSnapshot } from '@/features/gateway/lib/api-client'
import { Database, Globe, Search, Terminal } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useInfoQuery, useTargetsQuery } from '@/features/gateway/api'
import { CopyButton } from '@/shared/components/copy-button'
import { EmptyState } from '@/shared/components/empty-state'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Skeleton } from '@/shared/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table'
import { shellEscape } from '@/shared/lib/shell-escape'

function TargetIcon({ kind }: { kind: TargetSnapshot['kind'] }) {
  if (kind === 'Ssh')
    return <Terminal className="size-4" />
  if (kind === 'MySql' || kind === 'Postgres')
    return <Database className="size-4" />
  return <Globe className="size-4" />
}

function buildSshCommand(target: TargetSnapshot, username?: string, externalHost?: string, sshPort?: number): string {
  const host = externalHost ?? 'gateway'
  const portFlag = sshPort != null && sshPort !== 0 && sshPort !== 22 ? ['-p', String(sshPort)] : []
  const loginName = username != null && username !== '' ? `${username}:${target.name}` : target.name
  return shellEscape(['ssh', ...portFlag, '-l', loginName, host])
}

function TargetRow({ target, infoData }: { target: TargetSnapshot, infoData: { username?: string, external_host?: string, ports?: { ssh?: number } } | undefined }) {
  const { t } = useTranslation('gateway')

  const isSsh = target.kind === 'Ssh'
  const isHttp = target.kind === 'Api' || target.kind === 'WebAdmin'
  const sshCmd = isSsh ? buildSshCommand(target, infoData?.username, infoData?.external_host, infoData?.ports?.ssh) : null

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <TargetIcon kind={target.kind} />
          <span className="font-medium">{target.name}</span>
        </div>
      </TableCell>
      <TableCell>
        <Badge variant="secondary">{target.kind}</Badge>
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">
        {target.description ?? ''}
      </TableCell>
      <TableCell>
        {target.group != null && (
          <Badge variant="outline" className="text-xs">{target.group.name}</Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          {isSsh && sshCmd != null && sshCmd !== '' && (
            <>
              <code className="text-xs bg-muted px-2 py-1 rounded font-mono truncate max-w-[200px] hidden lg:inline-block">{sshCmd}</code>
              <CopyButton value={sshCmd} label={t('targetList.copyCommand')} />
              <Button render={<Link to={`/ui/ssh/${encodeURIComponent(target.name)}`} />} size="sm" variant="outline">
                <Terminal className="size-3.5 mr-1" />
                {t('targetList.openTerminal')}
              </Button>
            </>
          )}
          {isHttp && infoData?.external_host != null && infoData.external_host !== '' && (
            <a
              href={`https://${infoData.external_host}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary underline-offset-2 hover:underline"
            >
              {`https://${infoData.external_host}`}
            </a>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

function TableSkeleton() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead><Skeleton className="h-4 w-20" /></TableHead>
          <TableHead><Skeleton className="h-4 w-12" /></TableHead>
          <TableHead><Skeleton className="h-4 w-32" /></TableHead>
          <TableHead><Skeleton className="h-4 w-16" /></TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: 5 }).map((_, i) => (
          <TableRow key={`skeleton-${String(i)}`}>
            <TableCell><Skeleton className="h-4 w-28" /></TableCell>
            <TableCell><Skeleton className="h-5 w-12 rounded-full" /></TableCell>
            <TableCell><Skeleton className="h-4 w-40" /></TableCell>
            <TableCell><Skeleton className="h-5 w-16 rounded-full" /></TableCell>
            <TableCell><Skeleton className="h-8 w-24 ml-auto" /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function Component() {
  const { t } = useTranslation('gateway')
  const [search, setSearch] = useState('')
  const targetsQuery = useTargetsQuery(search || undefined)
  const infoQuery = useInfoQuery()

  const targets = (targetsQuery.data ?? []).filter(t => t.kind !== 'WebAdmin')

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight">{t('pages.targetList')}</h1>
        <div className="relative max-w-xs w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('targetList.search')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {targetsQuery.isPending && <TableSkeleton />}

      {targetsQuery.isSuccess && targets.length === 0 && (
        <EmptyState
          icon={Terminal}
          title={t('targetList.empty')}
        />
      )}

      {targets.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('targetList.colName', 'Name')}</TableHead>
              <TableHead>{t('targetList.colType', 'Type')}</TableHead>
              <TableHead>{t('targetList.colDescription', 'Description')}</TableHead>
              <TableHead>{t('targetList.colGroup', 'Group')}</TableHead>
              <TableHead className="text-right">{t('targetList.colActions', 'Actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {targets.map(target => (
              <TargetRow key={target.name} target={target} infoData={infoQuery.data} />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
