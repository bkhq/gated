import type { Target } from '@/shared/types/domain'
import { useTranslation } from 'react-i18next'
import { useDeleteTarget } from '@/features/targets/hooks/use-targets-queries'
import { DeleteWithReferencesDialog } from '@/shared/components/delete-with-references-dialog'

export function DeleteTargetDialog({ target, onClose, onDeleted }: {
  target: Target | null
  onClose: () => void
  onDeleted?: () => void
}) {
  const { t } = useTranslation()
  const deleteMutation = useDeleteTarget()

  if (!target) {
    return null
  }

  const confirm = async () => {
    try {
      await deleteMutation.mutateAsync(target.id)
    }
    catch {
      // Shown by the global error toast.
      return
    }
    onClose()
    onDeleted?.()
  }

  return (
    <DeleteWithReferencesDialog
      open
      title={t('targets.delete.title')}
      body={t('targets.delete.body', { name: target.name })}
      onClose={onClose}
      onConfirm={() => { void confirm() }}
      isPending={deleteMutation.isPending}
    />
  )
}
