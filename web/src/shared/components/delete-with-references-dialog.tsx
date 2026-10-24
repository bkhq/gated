import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'

export interface DeleteWithReferencesDialogProps {
  // Controls visibility. When false the dialog is closed; the wrapping Dialog
  // still mounts so its animation can play out.
  open: boolean
  // Dialog title (e.g. "Delete user").
  title: string
  // Main body text describing what will be deleted.
  body: string
  // Optional reverse-reference warning. When provided AND blocking is true, the
  // destructive action is replaced with the "Open instead" alternative.
  warning?: {
    title: string
    body: string
  } | null
  // Show the warning block. If false the destructive button is always shown.
  hasReferences?: boolean
  // When true (and hasReferences), show the "Open instead" CTA instead of Delete.
  // When false, Delete is shown but disabled (high-risk-only-after-cleanup case).
  showOpenInstead?: boolean
  // Label for the destructive button. Defaults to actions.delete.
  deleteLabel?: string
  // Label for the "Open instead" button. Required if showOpenInstead is true.
  openInsteadLabel?: string
  onClose: () => void
  onConfirm: () => void
  // Called when the user clicks the "Open instead" CTA.
  onOpenInstead?: () => void
  // Disables the destructive button (e.g. when a mutation is in-flight).
  isPending?: boolean
  // If true, the destructive button is rendered but disabled (e.g. builtin role).
  blockedByPolicy?: boolean
  // Optional dialog width in pixels (defaults to 440).
  width?: number
  // Failure message from the last confirm attempt.
  error?: string | null
}

// Confirm dialog for destructive actions that may have reverse references
// (sessions, role members, target group members, etc.). Shows a warning block
// summarizing those references and offers an "Open instead" branch when the
// caller wants to route the user back to the edit drawer for cleanup.
export function DeleteWithReferencesDialog({
  open,
  title,
  body,
  warning,
  hasReferences = false,
  showOpenInstead = false,
  deleteLabel,
  openInsteadLabel,
  onClose,
  onConfirm,
  onOpenInstead,
  isPending = false,
  blockedByPolicy = false,
  width = 440,
  error,
}: DeleteWithReferencesDialogProps) {
  const { t } = useTranslation()
  const shouldShowOpenInstead = hasReferences && showOpenInstead && onOpenInstead

  return (
    <Dialog open={open} onClose={onClose} width={width}>
      <div className="flex flex-col">
        <div className="px-6 pb-3 pt-5">
          <DialogPrimitive.Title className="m-0 text-[16px] font-semibold">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-2 text-[13.5px] text-muted-foreground">
            {body}
          </DialogPrimitive.Description>
          {hasReferences && warning
            ? (
                <div className="mt-3 rounded-md border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.08)] p-3 text-[13px] text-[hsl(var(--warning))]">
                  <div className="font-semibold">{warning.title}</div>
                  <div className="text-muted-foreground">{warning.body}</div>
                </div>
              )
            : null}
          {error
            ? (
                <div role="alert" className="mt-3 rounded-md border border-[hsl(var(--destructive)/0.3)] bg-[hsl(var(--destructive)/0.08)] p-3 text-[12.5px] text-[hsl(var(--destructive))]">
                  {error}
                </div>
              )
            : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-6 py-3">
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            {t('actions.cancel')}
          </Button>
          {shouldShowOpenInstead
            ? (
                <Button onClick={onOpenInstead}>
                  {openInsteadLabel}
                </Button>
              )
            : (
                <Button
                  variant="destructive"
                  onClick={onConfirm}
                  disabled={isPending || blockedByPolicy || hasReferences}
                >
                  {deleteLabel ?? t('actions.delete')}
                </Button>
              )}
        </div>
      </div>
    </Dialog>
  )
}
