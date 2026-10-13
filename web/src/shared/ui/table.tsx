import * as React from 'react'
import { cn } from '@/shared/lib/utils'

export function Table({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-card', className)} {...props}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  )
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('border-b border-border bg-[hsl(var(--muted)/0.5)]', className)} {...props} />
}

export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />
}

export function TR({ className, onClick, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      onClick={onClick}
      className={cn(
        'border-b border-border last:border-b-0',
        onClick && 'cursor-pointer transition hover:bg-[hsl(var(--accent)/0.55)]',
        className,
      )}
      {...props}
    />
  )
}

export function TH({ className, scope = 'col', ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope={scope} className={cn('whitespace-nowrap px-3.5 py-2.5 text-left text-xs font-medium text-muted-foreground', className)} {...props} />
}

export function TD({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-3.5 py-3 align-middle text-[13.5px]', className)} {...props} />
}
