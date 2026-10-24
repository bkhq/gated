import type { DropdownItem } from '@/shared/ui/dropdown-menu'
import { MoreHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import { DropdownMenu } from '@/shared/ui/dropdown-menu'

export interface RowActionsMenuProps {
  items: DropdownItem[]
  // Override the default "open" aria-label (defaults to t('actions.open')).
  label?: string
  align?: 'left' | 'right'
}

// Three-dot "More" dropdown rendered at the trailing edge of table rows
// and similar contexts. Wraps DropdownMenu with the standard ghost icon button
// trigger so feature pages don't repeat the same boilerplate.
export function RowActionsMenu({ items, label, align = 'right' }: RowActionsMenuProps) {
  const { t } = useTranslation()
  return (
    <DropdownMenu
      align={align}
      trigger={(
        <Button variant="ghost" size="icon-sm" aria-label={label ?? t('actions.open')}>
          <MoreHorizontal size={14} />
        </Button>
      )}
      items={items}
    />
  )
}
