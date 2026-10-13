import type { BreadcrumbItem } from '@/shared/components/page-header'
import type { Target } from '@/shared/types/domain'
import { Copy, Database, Edit, Play, RefreshCw, Star, Terminal, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatTargetAddress } from '@/features/targets/lib/target-address'
import { PageHeader } from '@/shared/components/page-header'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { TargetKindIcon } from './target-kind-icon'

export interface TargetDetailHeaderProps {
  target: Target
  mode: 'user' | 'admin'
  breadcrumbs: BreadcrumbItem[]
  tabs?: React.ReactNode
  lastUpdated?: string
  refreshing?: boolean
  favorite?: boolean
  replayLastDisabled?: boolean
  onRefresh?: () => void
  onToggleFavorite?: (next: boolean) => void
  onReplayLast?: (target: Target) => void
  onConnect?: (target: Target) => void
  onCopyConnect?: (target: Target) => void
  onEdit?: (target: Target) => void
  onDelete?: (target: Target) => void
  onOpenSqlConsole?: (target: Target) => void
}

export function TargetDetailHeader({
  target,
  mode,
  breadcrumbs,
  tabs,
  lastUpdated,
  refreshing,
  favorite,
  replayLastDisabled,
  onRefresh,
  onToggleFavorite,
  onReplayLast,
  onConnect,
  onCopyConnect,
  onEdit,
  onDelete,
  onOpenSqlConsole,
}: TargetDetailHeaderProps) {
  const { t } = useTranslation()
  const sqlConsoleButton = onOpenSqlConsole && (target.kind === 'mysql' || target.kind === 'postgres')
    ? (
        <Button variant="outline" size="sm" onClick={() => onOpenSqlConsole(target)}>
          <Database size={13} />
          <span>{t('targets.detail.actions.openSqlConsole')}</span>
        </Button>
      )
    : null

  const title = (
    <span className="inline-flex max-w-full flex-wrap items-center gap-3">
      <TargetKindIcon kind={target.kind} size={32} />
      <span>{target.name}</span>
      <Badge tone="mono">{target.kind.toUpperCase()}</Badge>
      {target.readonly ? <Badge tone="warning">read-only</Badge> : null}
    </span>
  )

  const description = (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="mono">
        {formatTargetAddress(target)}
      </span>
      {lastUpdated
        ? (
            <span className="text-[12px] text-muted-foreground">
              {t('targets.detail.lastUpdated', { time: lastUpdated })}
            </span>
          )
        : null}
    </span>
  )

  const userActions = (
    <>
      {onRefresh
        ? (
            <Button
              variant="outline"
              size="icon-sm"
              onClick={onRefresh}
              aria-label={t('targets.detail.actions.refresh')}
              title={t('targets.detail.actions.refresh')}
            >
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : undefined} />
            </Button>
          )
        : null}
      {onToggleFavorite
        ? (
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => onToggleFavorite(!favorite)}
              aria-pressed={!!favorite}
              aria-label={favorite ? t('targets.detail.actions.favoriteOn') : t('targets.detail.actions.favoriteOff')}
              title={favorite ? t('targets.detail.actions.favoriteOn') : t('targets.detail.actions.favoriteOff')}
            >
              <Star size={13} className={favorite ? 'fill-[hsl(var(--warning))] text-[hsl(var(--warning))]' : undefined} />
            </Button>
          )
        : null}
      {onReplayLast
        ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onReplayLast(target)}
              disabled={replayLastDisabled}
              title={t('targets.detail.actions.replayLast')}
            >
              <Play size={13} />
              <span>{t('targets.detail.actions.replayLast')}</span>
            </Button>
          )
        : null}
      <Button variant="outline" size="sm" onClick={() => onCopyConnect?.(target)}>
        <Copy size={13} />
        <span>{t('targets.detail.copyConnectCmd')}</span>
      </Button>
      {sqlConsoleButton}
      {onConnect
        ? (
            <Button onClick={() => onConnect(target)}>
              <Terminal size={14} />
              <span>{t('actions.connect')}</span>
            </Button>
          )
        : null}
    </>
  )

  const adminActions = (
    <>
      {sqlConsoleButton}
      <Button variant="outline" size="sm" onClick={() => onDelete?.(target)}>
        <Trash2 size={13} />
        <span>{t('actions.delete')}</span>
      </Button>
      <Button size="sm" onClick={() => onEdit?.(target)}>
        <Edit size={13} />
        <span>{t('actions.edit')}</span>
      </Button>
    </>
  )

  return (
    <PageHeader
      breadcrumbs={breadcrumbs}
      title={title}
      description={description}
      actions={mode === 'user' ? userActions : adminActions}
      tabs={tabs}
    />
  )
}
