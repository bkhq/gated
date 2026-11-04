import { KeyRound, Loader2 } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useTargetAccountChoices } from '@/features/targets/hooks/use-targets-queries'
import { Button } from '@/shared/ui/button'

export interface TargetAccountGateProps {
  targetName: string
  /** Renders the connection once the account is known (`undefined`: no choice needed). */
  children: (account: string | undefined) => React.ReactNode
}

/**
 * Asks which account to sign in with when the user's roles map the target to
 * several, before mounting the terminal, file manager or SQL console.
 */
export function TargetAccountGate({ targetName, children }: TargetAccountGateProps) {
  const { t } = useTranslation()
  const choices = useTargetAccountChoices(targetName)
  const [account, setAccount] = React.useState<string | null>(null)

  if (choices.isPending) {
    return (
      <div role="status" className="flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
        <span>{t('states.loading')}</span>
      </div>
    )
  }
  const names = choices.data ?? []
  // A failed lookup connects without a choice; the gateway reports the reason.
  if (names.length === 0)
    return <>{children(undefined)}</>
  if (account !== null && names.includes(account))
    return <>{children(account)}</>

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-5">
        <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <KeyRound size={15} />
          <span>{t('targets.accountGate.title', { target: targetName })}</span>
        </div>
        <p className="m-0 mb-4 text-[13px] text-muted-foreground">{t('targets.accountGate.description')}</p>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {names.map(name => (
            <li key={name}>
              <Button variant="outline" className="w-full justify-start font-mono" onClick={() => setAccount(name)}>
                {name}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
