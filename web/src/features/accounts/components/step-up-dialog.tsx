import type { RevealConfirmation } from '@/shared/lib/api/accounts'
import { ShieldCheck } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { stepUpErrorKey } from '@/features/accounts/utils'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Select } from '@/shared/ui/select'

type Factor = 'password' | 'otp'

export interface StepUpDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  onCancel: () => void
  // Resolves when the guarded action succeeded; a rejection keeps the dialog
  // open and shows the error so the user can retry.
  onConfirm: (confirmation: RevealConfirmation) => Promise<void>
}

export function StepUpDialog(props: StepUpDialogProps) {
  // Remount per open so the secret never survives between prompts.
  return props.open ? <StepUpDialogBody {...props} /> : null
}

function StepUpDialogBody({ open, title, description, confirmLabel, onCancel, onConfirm }: StepUpDialogProps) {
  const { t } = useTranslation()
  const [factor, setFactor] = React.useState<Factor>('password')
  const [secret, setSecret] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  const secretValid = factor === 'otp' ? /^\d{6}$/.test(secret) : secret.length > 0
  const canSubmit = secretValid && !pending

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!canSubmit)
      return
    setPending(true)
    setError(null)
    try {
      await onConfirm({ [factor]: secret })
    }
    catch (failure) {
      const key = stepUpErrorKey(failure)
      setError(key ? t(key) : failure instanceof Error ? failure.message : String(failure))
      setSecret('')
    }
    finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onClose={() => !pending && onCancel()} width={440}>
      <form onSubmit={(event) => { void submit(event) }}>
        <DialogHeader
          title={(
            <span className="inline-flex items-center gap-2">
              <ShieldCheck size={16} aria-hidden="true" />
              {title}
            </span>
          )}
          description={description}
        />
        <DialogBody className="flex flex-col gap-3">
          <div>
            <Label htmlFor="step-up-factor">{t('accounts.form.reveal.factor')}</Label>
            <Select
              id="step-up-factor"
              value={factor}
              onValueChange={(value) => {
                setFactor(value as Factor)
                setSecret('')
              }}
              options={[
                { value: 'password', label: t('accounts.form.reveal.password') },
                { value: 'otp', label: t('accounts.form.reveal.otp') },
              ]}
            />
          </div>
          <div>
            <Label htmlFor="step-up-secret">{t(`accounts.form.reveal.${factor}`)}</Label>
            <Input
              id="step-up-secret"
              type="password"
              inputMode={factor === 'otp' ? 'numeric' : undefined}
              maxLength={factor === 'otp' ? 6 : 1024}
              autoComplete={factor === 'otp' ? 'one-time-code' : 'current-password'}
              value={secret}
              onChange={event => setSecret(event.target.value)}
              autoFocus
            />
          </div>
          {error ? <p role="alert" className="text-[12.5px] text-[hsl(var(--destructive))]">{error}</p> : null}
        </DialogBody>
        <DialogFooter className="border-t border-border">
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            {t('actions.cancel')}
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
