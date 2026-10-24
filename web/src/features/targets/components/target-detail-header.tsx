import type { BreadcrumbItem } from '@/shared/components/page-header'
import type { Target } from '@/shared/types/domain'
import type { DropdownItem } from '@/shared/ui/dropdown-menu'
import { Copy, Database, Edit, FolderOpen, MoreHorizontal, Play, RefreshCw, Star, Terminal, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatTargetAddress } from '@/features/targets/lib/target-address'
import { PageHeader } from '@/shared/components/page-header'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { DropdownMenu } from '@/shared/ui/dropdown-menu'
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
  onOpenFiles?: (target: Target) => void
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
  onOpenFiles,
}: TargetDetailHeaderProps) {
  const { t } = useTranslation()
  // Connect plus the protocol's second tool (files for SSH, SQL console for
  // databases), shown as buttons in both modes so nothing hides in a menu.
  const openActions = (
    <>
      {onConnect && target.kind !== 'http'
        ? (
            <Button onClick={() => onConnect(target)}>
              <Terminal size={14} />
              <span>{t('actions.connect')}</span>
            </Button>
          )
        : null}
      {onOpenFiles && target.kind === 'ssh'
        ? (
            <Button variant="outline" onClick={() => onOpenFiles(target)}>
              <FolderOpen size={14} />
              <span>{t('targets.detail.actions.openFiles')}</span>
            </Button>
          )
        : null}
      {onOpenSqlConsole && (target.kind === 'mysql' || target.kind === 'postgres')
        ? (
            <Button variant="outline" onClick={() => onOpenSqlConsole(target)}>
              <Database size={14} />
              <span>{t('targets.detail.actions.openSqlConsole')}</span>
            </Button>
          )
        : null}
    </>
  )

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

  const moreMenu = (items: DropdownItem[]) => items.length > 0
    ? (
        <DropdownMenu
          trigger={(
            <Button
              variant="outline"
              className="w-9 px-0"
              aria-label={t('targets.detail.actions.more')}
              title={t('targets.detail.actions.more')}
            >
              <MoreHorizontal size={14} />
            </Button>
          )}
          items={items}
        />
      )
    : null

  const userMoreItems: DropdownItem[] = []
  if (onRefresh) {
    userMoreItems.push({ label: t('targets.detail.actions.refresh'), icon: RefreshCw, disabled: refreshing, onClick: onRefresh })
  }
  if (onToggleFavorite) {
    userMoreItems.push({
      label: favorite ? t('targets.detail.actions.favoriteOn') : t('targets.detail.actions.favoriteOff'),
      icon: Star,
      onClick: () => onToggleFavorite(!favorite),
    })
  }
  if (onReplayLast) {
    userMoreItems.push({
      label: t('targets.detail.actions.replayLast'),
      icon: Play,
      disabled: replayLastDisabled,
      onClick: () => onReplayLast(target),
    })
  }
  if (onCopyConnect) {
    userMoreItems.push({ label: t('targets.detail.copyConnectCmd'), icon: Copy, onClick: () => onCopyConnect(target) })
  }

  const userActions = (
    <>
      {openActions}
      {moreMenu(userMoreItems)}
    </>
  )

  const adminMoreItems: DropdownItem[] = [
    { label: t('actions.delete'), icon: Trash2, danger: true, onClick: () => onDelete?.(target) },
  ]

  const adminActions = (
    <>
      <Button variant="outline" onClick={() => onEdit?.(target)}>
        <Edit size={14} />
        <span>{t('actions.edit')}</span>
      </Button>
      {openActions}
      {moreMenu(adminMoreItems)}
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
