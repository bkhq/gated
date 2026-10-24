import type { LucideIcon } from 'lucide-react'
import type * as React from 'react'
import { MoreHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Label } from '@/shared/ui/label'
import { Skeleton } from '@/shared/ui/skeleton'

export function FieldGroup({ label, htmlFor, required, hint, error, children }: {
  label: string
  htmlFor?: string
  required?: boolean
  hint?: string
  error?: string
  children: React.ReactNode
}) {
  const errorId = error && htmlFor ? `${htmlFor}-error` : undefined
  const hintId = hint && htmlFor ? `${htmlFor}-hint` : undefined
  return (
    <div className="flex flex-col">
      <Label htmlFor={htmlFor}>
        {label}
        {required
          ? <span className="ml-0.5 text-[hsl(var(--destructive))]" aria-hidden="true">*</span>
          : null}
      </Label>
      {children}
      {error
        ? <div id={errorId} className="mt-1 text-[11.5px] text-[hsl(var(--destructive))]">{error}</div>
        : hint
          ? <div id={hintId} className="mt-1 text-[11.5px] text-muted-foreground">{hint}</div>
          : null}
    </div>
  )
}

export function ConfirmDialog({ open, title, body, confirmLabel, cancelLabel, destructive, onCancel, onConfirm, children }: {
  open: boolean
  title: string
  body?: string
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
  onCancel: () => void
  onConfirm: () => void
  children?: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onClose={onCancel} width={440}>
      <DialogHeader title={title} description={body} onClose={onCancel} />
      {children}
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>{cancelLabel ?? t('actions.cancel')}</Button>
        <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm}>{confirmLabel}</Button>
      </DialogFooter>
    </Dialog>
  )
}

export function RowMenu({ items, label }: {
  items: ({ label: React.ReactNode, icon?: LucideIcon, shortcut?: string, danger?: boolean, onClick?: () => void } | 'separator')[]
  label?: string
}) {
  const { t } = useTranslation()
  return (
    <DropdownMenu
      trigger={(
        <Button variant="ghost" size="icon-sm" aria-label={label ?? t('actions.open')}>
          <MoreHorizontal size={14} />
        </Button>
      )}
      items={items}
    />
  )
}

export function ListSkeleton({ className, rows = 3 }: { className?: string, rows?: number }) {
  return (
    <div className={className}>
      <div className="flex flex-col gap-3">
        {Array.from({ length: rows }).map((_, idx) => (
          <div key={`ls-${String(idx)}`} className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-lg" />
            <div className="flex-1">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="mt-2 h-3 w-3/5" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
