import type { LucideIcon } from 'lucide-react'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import * as React from 'react'
import { cn } from '@/shared/lib/utils'

export type DropdownItem
  = | 'separator'
    | {
      label: React.ReactNode
      icon?: LucideIcon
      shortcut?: string
      danger?: boolean
      onClick?: () => void
    }

export interface DropdownMenuProps {
  trigger: React.ReactNode
  items: DropdownItem[]
  align?: 'left' | 'right'
}

export function DropdownMenu({ trigger, items, align = 'right' }: DropdownMenuProps) {
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger
        data-slot="dropdown-trigger"
        render={trigger as React.ReactElement}
      />
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          align={align === 'right' ? 'end' : 'start'}
          side="bottom"
          sideOffset={6}
          className="z-50 outline-none"
        >
          <MenuPrimitive.Popup
            data-slot="dropdown-content"
            className={cn(
              'min-w-[180px] rounded-md border border-border bg-popover p-1 text-popover-foreground outline-none',
              'shadow-[0_8px_24px_rgba(0,0,0,0.18)]',
              'origin-(--transform-origin)',
              'transition duration-150 ease-out data-ending-style:opacity-0 data-ending-style:scale-[0.97] data-starting-style:opacity-0 data-starting-style:scale-[0.97]',
            )}
          >
            {items.map((item, index) => {
              if (item === 'separator') {
                return <div key={`sep-${String(index)}`} className="my-1 h-px bg-border" />
              }
              const Icon = item.icon
              return (
                <MenuPrimitive.Item
                  key={`it-${String(index)}`}
                  data-slot="dropdown-item"
                  onClick={() => item.onClick?.()}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded px-2.5 py-2 text-left text-[13px] outline-none transition',
                    'data-highlighted:bg-accent data-highlighted:text-accent-foreground',
                    'data-disabled:cursor-not-allowed data-disabled:opacity-50',
                    item.danger && 'text-destructive data-highlighted:text-destructive',
                  )}
                >
                  {Icon ? <Icon size={14} /> : null}
                  <span className="flex-1">{item.label}</span>
                  {item.shortcut ? <span className="text-[11px] text-muted-foreground">{item.shortcut}</span> : null}
                </MenuPrimitive.Item>
              )
            })}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  )
}
