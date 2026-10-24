import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/shared/lib/utils'
import { Button } from './button'

export interface DialogProps {
  open: boolean
  onClose: () => void
  width?: number
  children: React.ReactNode
  className?: string
}

export function Dialog({ open, onClose, width = 520, children, className }: DialogProps) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          data-slot="dialog-overlay"
          className={cn(
            'drawer-backdrop fixed inset-0 z-50 backdrop-blur-[2px]',
            'transition-opacity duration-150 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0',
          )}
        />
        <DialogPrimitive.Popup
          data-slot="dialog-content"
          style={{ maxWidth: width }}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-full -translate-x-1/2 -translate-y-1/2 overflow-auto',
            'rounded-lg border border-border bg-card text-card-foreground',
            'shadow-[0_20px_50px_rgba(0,0,0,0.25),0_8px_20px_rgba(0,0,0,0.12)]',
            'transition duration-150 ease-out data-ending-style:opacity-0 data-ending-style:scale-[0.95] data-starting-style:opacity-0 data-starting-style:scale-[0.95]',
            className,
          )}
        >
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export function DialogHeader({ title, description, onClose }: { title: React.ReactNode, description?: React.ReactNode, onClose?: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-start justify-between gap-4 px-6 pb-3 pt-5">
      <div>
        <DialogPrimitive.Title className="m-0 text-[17px] font-semibold">{title}</DialogPrimitive.Title>
        {description ? <DialogPrimitive.Description className="mt-1 text-[13px] text-muted-foreground">{description}</DialogPrimitive.Description> : null}
      </div>
      {onClose ? <Button variant="ghost" size="icon-sm" aria-label={t('actions.close')} onClick={onClose}><X size={16} /></Button> : null}
    </div>
  )
}

export function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-6 pb-4', className)} {...props} />
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex justify-end gap-2 px-6 pb-5 pt-3', className)} {...props} />
}
