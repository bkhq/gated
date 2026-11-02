import { Tabs as TabsPrimitive } from '@base-ui/react/tabs'
import * as React from 'react'
import { cn } from '@/shared/lib/utils'

export interface TabsProps {
  value: string
  onChange: (next: string) => void
  className?: string
  children: React.ReactNode
}

export function Tabs({ value, onChange, className, children }: TabsProps) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      value={value}
      onValueChange={next => onChange(String(next))}
      className={cn('flex min-w-0 max-w-full flex-col gap-3 self-start', className)}
    >
      {children}
    </TabsPrimitive.Root>
  )
}

export function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md bg-muted p-[3px]',
        className,
      )}
      {...props}
    />
  )
}

export interface TabsTriggerProps extends Omit<TabsPrimitive.Tab.Props, 'value' | 'render'> {
  value: string
  className?: string
}

export function TabsTrigger({ value, className, children, ...props }: TabsTriggerProps) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      value={value}
      className={cn(
        'h-[30px] shrink-0 cursor-pointer whitespace-nowrap rounded-sm px-3.5 text-[13px] font-medium text-muted-foreground outline-none transition',
        'hover:text-foreground',
        'data-active:bg-background data-active:text-foreground data-active:shadow-[0_1px_2px_rgba(0,0,0,0.06)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]',
        className,
      )}
      {...props}
    >
      {children}
    </TabsPrimitive.Tab>
  )
}

export interface TabsContentProps extends Omit<TabsPrimitive.Panel.Props, 'value' | 'render'> {
  value: string
  className?: string
}

export function TabsContent({ value, className, children, ...props }: TabsContentProps) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      value={value}
      className={cn('page-enter min-w-0 outline-none', className)}
      {...props}
    >
      {children}
    </TabsPrimitive.Panel>
  )
}
