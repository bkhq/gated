import type { Target } from '@/shared/types/domain'
import { Activity, Edit, Key, MoreHorizontal, Terminal, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { buildConnectCommand } from '@/features/targets/lib/connect-command'
import { formatTargetAddress } from '@/features/targets/lib/target-address'
import { useInfo } from '@/shared/hooks/use-info'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import { Checkbox } from '@/shared/ui/checkbox'
import { DropdownMenu } from '@/shared/ui/dropdown-menu'
import { TargetKindIcon } from './target-kind-icon'
import { TargetStatusIndicator } from './target-status-indicator'
import { TargetUserAction } from './target-user-action'

export interface TargetCardProps {
  target: Target
  mode: 'user' | 'admin'
  onOpen: (target: Target) => void
  onConnect?: (target: Target) => void
  onEdit?: (target: Target) => void
  onDelete?: (target: Target) => void
  onHostKeys?: (target: Target) => void
  onCheck?: (target: Target) => void
  /** Renders a selection checkbox when set. */
  selected?: boolean
  onSelectedChange?: (selected: boolean) => void
}

export function TargetCard({ target, mode, onOpen, onConnect, onEdit, onDelete, onHostKeys, onCheck, selected, onSelectedChange }: TargetCardProps) {
  const { t } = useTranslation()
  const info = useInfo().data

  const copyConnect = () => {
    const cmd = buildConnectCommand(target, info) ?? target.name
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(cmd).catch(() => {})
    }
  }

  const menuItems = mode === 'admin'
    ? [
        { label: t('actions.edit'), icon: Edit, onClick: () => onEdit?.(target) },
        ...(onHostKeys && target.kind === 'ssh'
          ? [{ label: t('targets.menu.hostKeys'), icon: Key, onClick: () => onHostKeys(target) }]
          : []),
        ...(onCheck
          ? [{ label: t('targets.actions.checkReachability'), icon: Activity, onClick: () => onCheck(target) }]
          : []),
        'separator' as const,
        { label: t('actions.delete'), icon: Trash2, danger: true, onClick: () => onDelete?.(target) },
      ]
    : target.kind === 'http'
      ? []
      : [
          { label: t('targets.menu.copyConnect'), icon: Terminal, onClick: copyConnect },
        ]

  return (
    <Card
      onClick={() => onOpen(target)}
      className="cursor-pointer transition hover:border-[hsl(var(--ring)/0.6)] hover:shadow-[0_4px_12px_rgba(0,0,0,0.04)]"
    >
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-2.5">
          {onSelectedChange
            ? (
                <span className="pt-1" onClick={event => event.stopPropagation()}>
                  <Checkbox
                    checked={selected ?? false}
                    onCheckedChange={checked => onSelectedChange(checked)}
                    aria-label={t('targets.selectTarget', { name: target.name })}
                  />
                </span>
              )
            : null}
          <TargetKindIcon kind={target.kind} />
          <div className="min-w-0 flex-1">
            <span className="truncate text-[14px] font-semibold">{target.name}</span>
            {target.groupName
              ? <div className="text-[12px] text-muted-foreground">{target.groupName}</div>
              : null}
          </div>
          {menuItems.length > 0
            ? (
                <span onClick={event => event.stopPropagation()}>
                  <DropdownMenu
                    trigger={(
                      <Button variant="ghost" size="icon-sm" aria-label={t('actions.open')}>
                        <MoreHorizontal size={14} />
                      </Button>
                    )}
                    items={menuItems}
                  />
                </span>
              )
            : null}
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="mono min-w-0 truncate text-[12px] text-muted-foreground">
            {formatTargetAddress(target)}
          </div>
          <TargetStatusIndicator status={target.status} />
        </div>
        {target.readonly
          ? (
              <div>
                <Badge tone="warning">read-only</Badge>
              </div>
            )
          : null}
        <div className="mt-1 flex items-center justify-end">
          {mode === 'user'
            ? <TargetUserAction target={target} onOpen={onOpen} onConnect={onConnect} />
            : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={(event) => {
                    event.stopPropagation()
                    onEdit?.(target)
                  }}
                >
                  <Edit size={13} />
                  <span>{t('actions.edit')}</span>
                </Button>
              )}
        </div>
      </CardContent>
    </Card>
  )
}
