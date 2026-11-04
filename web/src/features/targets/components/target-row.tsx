import type { Target } from '@/shared/types/domain'
import { Activity, Edit, Key, MoreHorizontal, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatTargetAddress } from '@/features/targets/lib/target-address'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Checkbox } from '@/shared/ui/checkbox'
import { DropdownMenu } from '@/shared/ui/dropdown-menu'
import { TD, TR } from '@/shared/ui/table'
import { TargetKindIcon } from './target-kind-icon'
import { TargetStatusIndicator } from './target-status-indicator'
import { TargetUserAction } from './target-user-action'

export interface TargetRowProps {
  target: Target
  mode: 'user' | 'admin'
  onOpen: (target: Target) => void
  onConnect?: (target: Target) => void
  onEdit?: (target: Target) => void
  onDelete?: (target: Target) => void
  onHostKeys?: (target: Target) => void
  onCheck?: (target: Target) => void
  groupName?: string
  /** Renders a selection checkbox when set. */
  selected?: boolean
  onSelectedChange?: (selected: boolean) => void
}

export function TargetRow({ target, mode, onOpen, onConnect, onEdit, onDelete, onHostKeys, onCheck, groupName, selected, onSelectedChange }: TargetRowProps) {
  const { t } = useTranslation()

  return (
    <TR onClick={() => onOpen(target)}>
      {onSelectedChange
        ? (
            <TD className="w-[44px] pl-5" onClick={event => event.stopPropagation()}>
              <Checkbox
                checked={selected ?? false}
                onCheckedChange={checked => onSelectedChange(checked)}
                aria-label={t('targets.selectTarget', { name: target.name })}
              />
            </TD>
          )
        : null}
      <TD className={onSelectedChange ? undefined : 'pl-5'}>
        <div className="flex items-center gap-2.5">
          <TargetKindIcon kind={target.kind} size={28} />
          <div className="min-w-0">
            <div className="truncate font-medium">{target.name}</div>
            {mode === 'admin'
              ? <div className="mono text-[11px] text-muted-foreground">{target.id}</div>
              : null}
          </div>
        </div>
      </TD>
      <TD><Badge tone="mono">{target.kind.toUpperCase()}</Badge></TD>
      <TD className="mono text-muted-foreground">
        {formatTargetAddress(target)}
      </TD>
      <TD className="text-muted-foreground">{groupName ?? target.groupName}</TD>
      <TD><TargetStatusIndicator status={target.status} /></TD>
      <TD className="pr-5 text-right" onClick={event => event.stopPropagation()}>
        {mode === 'user'
          ? <TargetUserAction target={target} variant="outline" onOpen={onOpen} onConnect={onConnect} />
          : (
              <DropdownMenu
                trigger={(
                  <Button variant="ghost" size="icon-sm" aria-label={t('actions.open')}>
                    <MoreHorizontal size={14} />
                  </Button>
                )}
                items={[
                  { label: t('actions.edit'), icon: Edit, onClick: () => onEdit?.(target) },
                  ...(onHostKeys && target.kind === 'ssh'
                    ? [{ label: t('targets.menu.hostKeys'), icon: Key, onClick: () => onHostKeys(target) }]
                    : []),
                  ...(onCheck
                    ? [{ label: t('targets.actions.checkReachability'), icon: Activity, onClick: () => onCheck(target) }]
                    : []),
                  'separator' as const,
                  { label: t('actions.delete'), icon: Trash2, danger: true, onClick: () => onDelete?.(target) },
                ]}
              />
            )}
      </TD>
    </TR>
  )
}
