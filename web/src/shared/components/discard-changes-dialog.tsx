import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'

export interface DiscardChangesDialogProps {
  open: boolean
  title: string
  body: string
  // Label for the confirm (destructive) button, e.g. "Discard".
  discardLabel: string
  onCancel: () => void
  onDiscard: () => void
}

// Confirm dialog shown when the user tries to close a drawer/form with
// unsaved changes. Caller supplies the feature-specific i18n strings so the
// dialog can read the same copy the surrounding feature has historically used.
export function DiscardChangesDialog({
  open,
  title,
  body,
  discardLabel,
  onCancel,
  onDiscard,
}: DiscardChangesDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onClose={onCancel} width={420}>
      <div className="flex flex-col">
        <div className="px-6 pb-3 pt-5">
          <h3 className="m-0 text-[16px] font-semibold">{title}</h3>
          <p className="mt-1 text-[13px] text-muted-foreground">{body}</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-6 py-3">
          <Button variant="outline" onClick={onCancel}>{t('actions.cancel')}</Button>
          <Button variant="destructive" onClick={onDiscard}>{discardLabel}</Button>
        </div>
      </div>
    </Dialog>
  )
}
