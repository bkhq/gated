import type { Target } from '@/shared/types/domain'
import * as React from 'react'
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
  const [error, setError] = React.useState<string | null>(null)

  if (!target) {
    return null
  }

  const close = () => {
    setError(null)
    onClose()
  }

  const confirm = async () => {
    setError(null)
    try {
      await deleteMutation.mutateAsync(target.id)
    }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      return
    }
    close()
    onDeleted?.()
  }

  return (
    <DeleteWithReferencesDialog
      open
      title={t('targets.delete.title')}
      body={t('targets.delete.body', { name: target.name })}
      onClose={close}
      onConfirm={() => { void confirm() }}
      isPending={deleteMutation.isPending}
      error={error}
    />
  )
}
