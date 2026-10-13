import { Select as SelectPrimitive } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/shared/lib/utils'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps {
  'value'?: string
  'defaultValue'?: string
  'onValueChange'?: (value: string) => void
  'options': SelectOption[]
  'placeholder'?: string
  'disabled'?: boolean
  'required'?: boolean
  'className'?: string
  'name'?: string
  'id'?: string
  'aria-label'?: string
}

export function Select({
  value,
  defaultValue,
  onValueChange,
  options,
  placeholder,
  disabled,
  required,
  className,
  name,
  id,
  'aria-label': ariaLabel,
}: SelectProps) {
  return (
    <SelectPrimitive.Root<string>
      value={value}
      defaultValue={defaultValue}
      onValueChange={next => onValueChange?.(next ?? '')}
      disabled={disabled}
      required={required}
      name={name}
      items={options}
    >
      <SelectPrimitive.Trigger
        data-slot="select-trigger"
        id={id}
        aria-label={ariaLabel}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background pl-3 pr-2.5 text-left text-sm text-foreground outline-none transition',
          'hover:border-ring/60',
          'data-popup-open:border-ring data-popup-open:shadow-[0_0_0_3px_hsl(var(--ring)/0.18)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]',
          className,
        )}
      >
        <SelectPrimitive.Value
          className="min-w-0 flex-1 truncate text-left"
          placeholder={placeholder ?? ''}
        />
        <SelectPrimitive.Icon
          render={(
            <ChevronDown
              size={14}
              className="shrink-0 text-muted-foreground transition-transform data-popup-open:rotate-180"
            />
          )}
        />
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          sideOffset={6}
          align="start"
          className="z-50 outline-none"
        >
          <SelectPrimitive.Popup
            data-slot="select-content"
            className={cn(
              'max-h-[min(var(--available-height),18rem)] min-w-[var(--anchor-width)] overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground outline-none',
              'shadow-[0_8px_24px_rgba(0,0,0,0.18)]',
              'origin-(--transform-origin)',
              'transition duration-150 ease-out data-ending-style:opacity-0 data-ending-style:scale-[0.97] data-starting-style:opacity-0 data-starting-style:scale-[0.97]',
            )}
          >
            {options.map(option => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                data-slot="select-item"
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[13px] outline-none',
                  'data-highlighted:bg-accent data-highlighted:text-accent-foreground',
                  'data-disabled:cursor-not-allowed data-disabled:opacity-50',
                )}
              >
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-foreground">
                  <SelectPrimitive.ItemIndicator>
                    <Check size={12} />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <span className="flex-1 truncate">
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                </span>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}
