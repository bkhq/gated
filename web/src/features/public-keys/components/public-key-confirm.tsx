import type { PublicKeyConfirmationFactor } from '@/shared/lib/api/profile'
import type { PublicKeyDraft } from '@/shared/types/drafts'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { StepUpDialog } from '@/features/accounts/components/step-up-dialog'
import { useRegisterPublicKey } from '@/features/public-keys/hooks/use-public-keys-queries'
import { profileApi } from '@/shared/lib/api/profile'

interface Pending {
  draft: PublicKeyDraft
  factor: PublicKeyConfirmationFactor
}

// Registers a public key, asking the user to confirm their identity first
// when the account has a password or an OTP. `prompt` must be rendered.
export function usePublicKeyRegistration(onRegistered: () => void) {
  const { t } = useTranslation()
  const registerMutation = useRegisterPublicKey()
  const [pending, setPending] = React.useState<Pending | null>(null)

  async function register(draft: PublicKeyDraft) {
    const factor = await profileApi.publicKeys.confirmationFactor()
    if (factor) {
      setPending({ draft, factor })
      return
    }
    await registerMutation.mutateAsync(draft)
    onRegistered()
  }

  const prompt = (
    <StepUpDialog
      open={pending !== null}
      factor={pending?.factor}
      title={t('profile.auth.keyConfirm.title')}
      description={t('profile.auth.keyConfirm.description')}
      confirmLabel={t('profile.auth.keyConfirm.confirm')}
      onCancel={() => setPending(null)}
      onConfirm={async (confirmation) => {
        if (!pending)
          return
        await registerMutation.mutateAsync({
          ...pending.draft,
          confirmation: { password: confirmation.password ?? undefined, otp: confirmation.otp ?? undefined },
        })
        setPending(null)
        onRegistered()
      }}
    />
  )

  return { register, prompt }
}
