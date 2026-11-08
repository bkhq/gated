import type { DropdownItem } from './dropdown-menu'
import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu'
import { cn } from '@/shared/lib/utils'
import { DropdownItems } from './dropdown-menu'

export interface ContextMenuProps extends ContextMenuPrimitive.Trigger.Props {
  items: DropdownItem[]
}

/** Opens `items` on right click (or long press) anywhere in its area. */
export function ContextMenu({ items, children, ...trigger }: ContextMenuProps) {
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger {...trigger}>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Positioner className="z-50 outline-none">
          <ContextMenuPrimitive.Popup
            data-slot="context-menu-content"
            className={cn(
              'min-w-[190px] rounded-md border border-border bg-popover p-1 text-popover-foreground outline-none',
              'shadow-[0_8px_24px_rgba(0,0,0,0.18)]',
              'origin-(--transform-origin)',
              'transition duration-150 ease-out data-ending-style:opacity-0 data-ending-style:scale-[0.97] data-starting-style:opacity-0 data-starting-style:scale-[0.97]',
            )}
          >
            <DropdownItems items={items} />
          </ContextMenuPrimitive.Popup>
        </ContextMenuPrimitive.Positioner>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  )
}
