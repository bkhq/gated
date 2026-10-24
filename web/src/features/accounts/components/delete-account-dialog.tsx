import type { Account } from '@/shared/types/domain'
import { useTranslation } from 'react-i18next'
import { useAccountReferences, useDeleteAccount } from '@/features/accounts/hooks/use-accounts-queries'
import { DeleteWithReferencesDialog } from '@/shared/components/delete-with-references-dialog'

export function DeleteAccountDialog({ account, onClose, onDeleted, onOpenInstead }: {
  account: Account | null
  onClose: () => void
  onDeleted?: () => void
  onOpenInstead: (account: Account) => void
}) {
  const { t } = useTranslation()
  const references = useAccountReferences(account?.id)
  const deleteMutation = useDeleteAccount()

  if (!account) {
    return null
  }

  const refData = references.data
  const targetCount = refData?.targetCount ?? 0
  const roleCount = refData?.roleCount ?? 0
  const hasRefs = targetCount + roleCount > 0

  const confirm = async () => {
    await deleteMutation.mutateAsync(account.id)
    onDeleted?.()
    onClose()
  }

  return (
    <DeleteWithReferencesDialog
      open
      title={t('accounts.delete.title')}
      body={t('accounts.delete.body', { name: account.name })}
      warning={hasRefs
        ? {
            title: t('accounts.delete.warnTitle'),
            body: t('accounts.delete.warnBody', { targets: targetCount, roles: roleCount }),
          }
        : null}
      hasReferences={hasRefs}
      showOpenInstead
      openInsteadLabel={t('accounts.delete.openInstead')}
      onClose={onClose}
      onConfirm={() => { void confirm() }}
      onOpenInstead={() => onOpenInstead(account)}
      isPending={deleteMutation.isPending || references.isLoading}
    />
  )
}
