import { useTranslation } from 'react-i18next'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'

export interface DrawerFooterProps {
  // Optional left-side slot (e.g. destructive ghost "Delete" button in edit mode).
  leftAction?: React.ReactNode
  // Cancel button click handler.
  onCancel: () => void
  // Save button click handler (if omitted, the save button submits the surrounding form).
  onSave?: () => void
  // Cancel button label (defaults to actions.cancel).
  cancelLabel?: React.ReactNode
  // Save button label (defaults to actions.save).
  saveLabel?: React.ReactNode
  // Disables both Cancel and Save (in-flight mutation).
  isPending?: boolean
  // Disables only the Save button (validation errors).
  hideSave?: boolean
  saveDisabled?: boolean
  // When true, render the Save as type="submit"; otherwise type="button" with onSave.
  saveAsSubmit?: boolean
  // Form id the Save submit button is associated with — required when the
  // footer is rendered outside the <form> element (e.g. as a sticky slot
  // sibling to a body region containing the form).
  form?: string
  className?: string
}

// Sticky-style drawer/dialog footer with left/right action layout.
// Save is always rendered to the right; the left slot is optional for
// secondary destructive actions (e.g. "Delete" in edit mode).
export function DrawerFooter({
  leftAction,
  onCancel,
  onSave,
  cancelLabel,
  saveLabel,
  isPending,
  hideSave,
  saveDisabled,
  saveAsSubmit,
  form,
  className,
}: DrawerFooterProps) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex items-center justify-between gap-2 border-t border-border bg-card px-6 py-3', className)}>
      {leftAction ?? <span />}
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          {cancelLabel ?? t('actions.cancel')}
        </Button>
        {hideSave
          ? null
          : saveAsSubmit
            ? (
                <Button type="submit" form={form} disabled={isPending || saveDisabled}>
                  {saveLabel ?? t('actions.save')}
                </Button>
              )
            : (
                <Button type="button" onClick={onSave} disabled={isPending || saveDisabled}>
                  {saveLabel ?? t('actions.save')}
                </Button>
              )}
      </div>
    </div>
  )
}
