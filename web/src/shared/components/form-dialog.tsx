import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { DiscardChangesDialog } from '@/shared/components/discard-changes-dialog'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'

export type FormDialogWidth = 'sm' | 'md' | 'lg' | 'xl'

const WIDTH_PX: Record<FormDialogWidth, number> = {
  sm: 480,
  md: 640,
  lg: 800,
  xl: 960,
}

// Fixed dialog heights stop the body from collapsing/growing with tab content,
// removing the visual jump users see when switching between tabs of different
// length. The outer max-h-[90vh] caps it on short viewports.
const HEIGHT_PX: Record<FormDialogWidth, number> = {
  sm: 520,
  md: 600,
  lg: 680,
  xl: 680,
}

export interface FormDialogProps {
  open: boolean
  // Caller close handler. FormDialog runs the dirty-check first and only
  // calls onClose once the user confirms (or there's no dirty state).
  onClose: () => void
  // Title + optional description rendered inside the default header. When
  // a custom `header` is supplied these are ignored; the caller is then
  // responsible for rendering FormDialogTitle/Description.
  title?: React.ReactNode
  description?: React.ReactNode
  width?: FormDialogWidth
  dirty?: boolean
  // i18n labels for the discard-changes confirmation (feature-supplied).
  // If any is missing the dialog closes immediately even when dirty.
  discardTitle?: string
  discardBody?: string
  discardLabel?: string
  // Element that triggered the dialog; focus is restored to it on close.
  finalFocusRef?: React.RefObject<HTMLElement | null>
  // Header slot: when provided, replaces the default title/description block.
  // The custom header should render FormDialogTitle/Description from this
  // module so base-ui can wire aria-labelledby/describedby on the popup.
  header?: React.ReactNode
  // Sticky/anchored row directly below the header (e.g. a tabs strip).
  belowHeader?: React.ReactNode
  // Optional sticky footer; ideally a FormFooter. Pass a render function to
  // receive the dialog's dirty-aware `requestClose` (e.g. to wire a Cancel
  // button that also triggers the discard confirmation).
  footer?: React.ReactNode | ((requestClose: () => void) => React.ReactNode)
  // When this value changes, the body scroll position is reset to the top.
  // Use it on tab-switch keys so users always see the new tab from the start.
  scrollResetKey?: string | number
  className?: string
  // Body slot. Wrapped in a scroll container that sits between the header
  // (or belowHeader) and the footer.
  children: React.ReactNode
}

// FormDialog wraps a centered modal dialog around a feature form. It
// owns the discard-changes confirmation that fires whenever the user
// tries to close the dialog while `dirty` is true (Esc, backdrop click,
// header close button). Cmd/Ctrl+Enter submission is left to the form
// inside `children`.
export function FormDialog({
  open,
  onClose,
  title,
  description,
  width = 'md',
  dirty,
  discardTitle,
  discardBody,
  discardLabel,
  finalFocusRef,
  header,
  belowHeader,
  footer,
  scrollResetKey,
  className,
  children,
}: FormDialogProps) {
  const { t } = useTranslation()
  const [discardOpen, setDiscardOpen] = React.useState(false)
  const bodyRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0
    }
  }, [scrollResetKey])

  const canConfirmDiscard = Boolean(dirty) && Boolean(discardTitle) && Boolean(discardBody) && Boolean(discardLabel)

  const requestClose = React.useCallback(() => {
    if (canConfirmDiscard) {
      setDiscardOpen(true)
      return
    }
    onClose()
  }, [canConfirmDiscard, onClose])

  const handleOpenChange = React.useCallback((next: boolean) => {
    if (!next) {
      requestClose()
    }
  }, [requestClose])

  return (
    <>
      <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
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
            finalFocus={finalFocusRef}
            style={{ maxWidth: WIDTH_PX[width], height: HEIGHT_PX[width] }}
            className={cn(
              'fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden',
              'rounded-lg border border-border bg-card text-card-foreground',
              'shadow-[0_20px_50px_rgba(0,0,0,0.25),0_8px_20px_rgba(0,0,0,0.12)]',
              'transition duration-150 ease-out data-ending-style:opacity-0 data-ending-style:scale-[0.95] data-starting-style:opacity-0 data-starting-style:scale-[0.95]',
              className,
            )}
          >
            {header ?? (
              <FormDialogDefaultHeader
                title={title}
                description={description}
                onClose={requestClose}
                closeLabel={t('actions.close')}
              />
            )}

            {belowHeader}

            <div
              ref={bodyRef}
              className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5"
            >
              {children}
            </div>

            {typeof footer === 'function' ? footer(requestClose) : footer}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <DiscardChangesDialog
        open={discardOpen}
        title={discardTitle ?? ''}
        body={discardBody ?? ''}
        discardLabel={discardLabel ?? ''}
        onCancel={() => setDiscardOpen(false)}
        onDiscard={() => {
          setDiscardOpen(false)
          onClose()
        }}
      />
    </>
  )
}

interface FormDialogDefaultHeaderProps {
  title?: React.ReactNode
  description?: React.ReactNode
  onClose: () => void
  closeLabel: string
}

function FormDialogDefaultHeader({
  title,
  description,
  onClose,
  closeLabel,
}: FormDialogDefaultHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border px-6 py-5">
      <div className="min-w-0">
        <DialogPrimitive.Title className="m-0 text-[17px] font-semibold leading-tight">
          {title}
        </DialogPrimitive.Title>
        {description
          ? (
              <DialogPrimitive.Description className="mt-1 text-[13px] text-muted-foreground">
                {description}
              </DialogPrimitive.Description>
            )
          : null}
      </div>
      <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label={closeLabel}>
        <X size={15} aria-hidden="true" />
      </Button>
    </div>
  )
}

// Thin wrappers around the base-ui primitives so feature headers can
// compose them without importing @base-ui/react directly. Wiring them
// inside FormDialog keeps aria-labelledby/describedby connected on the
// popup (base-ui finds them via context).
export function FormDialogTitle(props: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title {...props} />
}

export function FormDialogDescription(props: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description {...props} />
}
