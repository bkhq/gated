import type { Target } from '@/shared/types/domain'
import { Edit, Key, MoreHorizontal, Terminal, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatTargetAddress } from '@/features/targets/lib/target-address'
import { targetGroupLabel } from '@/features/targets/lib/target-group'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { DropdownMenu } from '@/shared/ui/dropdown-menu'
import { TD, TR } from '@/shared/ui/table'
import { TargetKindIcon } from './target-kind-icon'

export interface TargetRowProps {
  target: Target
  mode: 'user' | 'admin'
  onOpen: (target: Target) => void
  onConnect?: (target: Target) => void
  onEdit?: (target: Target) => void
  onDelete?: (target: Target) => void
  onHostKeys?: (target: Target) => void
  groupName?: string
}

export function TargetRow({ target, mode, onOpen, onConnect, onEdit, onDelete, onHostKeys, groupName }: TargetRowProps) {
  const { t } = useTranslation()

  return (
    <TR onClick={() => onOpen(target)}>
      <TD className="pl-5">
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
      <TD className="text-muted-foreground">{groupName ?? targetGroupLabel(target, t('targets.ungrouped'))}</TD>
      <TD className="pr-5 text-right" onClick={event => event.stopPropagation()}>
        {mode === 'user'
          ? (
              <Button size="sm" variant="outline" onClick={() => onConnect?.(target)}>
                <Terminal size={12} />
                {t('actions.connect')}
              </Button>
            )
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
                  'separator' as const,
                  { label: t('actions.delete'), icon: Trash2, danger: true, onClick: () => onDelete?.(target) },
                ]}
              />
            )}
      </TD>
    </TR>
  )
}
