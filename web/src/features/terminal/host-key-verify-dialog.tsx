import type { HostKeyVerifyPrompt } from './codec'
import * as React from 'react'
import { Button } from '@/shared/ui/button'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
} from '@/shared/ui/dialog'

export interface HostKeyVerifyLabels {
  title: string
  description: string
  targetLabel: string
  algorithmLabel: string
  fingerprintLabel: string
  publicKeyLabel: string
  // Rendered as `t('terminal.hostKey.countdown', { seconds })` upstream;
  // `{seconds}` is substituted inline so this stays string-only and i18n-clean.
  countdown: string
  accept: string
  reject: string
}

const DEFAULT_LABELS: HostKeyVerifyLabels = {
  title: 'Verify host key',
  description:
    'The remote host is unknown. Confirm this fingerprint matches the one '
    + 'you trust before continuing — accepting will pin this key for future connections.',
  targetLabel: 'Target',
  algorithmLabel: 'Algorithm',
  fingerprintLabel: 'SHA-256 fingerprint',
  publicKeyLabel: 'Public key',
  countdown: 'Auto-rejects in {seconds}s',
  accept: 'Accept',
  reject: 'Reject',
}

// Server enforces a 60s window (api.md §1.8). Auto-reject one second early so
// the click can land before the server gives up.
const DEFAULT_TIMEOUT_MS = 60_000

export interface HostKeyVerifyDialogProps {
  prompt: HostKeyVerifyPrompt | null
  onDecision: (accepted: boolean) => void
  labels?: Partial<HostKeyVerifyLabels>
  // Override the auto-reject timer (in ms). Defaults to the server's 60s window.
  timeoutMs?: number
}

export function HostKeyVerifyDialog({
  prompt,
  onDecision,
  labels,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: HostKeyVerifyDialogProps) {
  const merged: HostKeyVerifyLabels = { ...DEFAULT_LABELS, ...labels }
  const open = prompt !== null

  // Seconds remaining for the countdown. Reset whenever a fresh prompt arrives.
  const [remainingMs, setRemainingMs] = React.useState(timeoutMs)
  const onDecisionRef = React.useRef(onDecision)
  React.useEffect(() => {
    onDecisionRef.current = onDecision
  }, [onDecision])

  React.useEffect(() => {
    if (!open)
      return undefined
    // Reset countdown synchronously on each (re)open so the displayed seconds
    // start at the full budget rather than the previous decay.
    // eslint-disable-next-line react/set-state-in-effect
    setRemainingMs(timeoutMs)
    const start = performance.now()
    const interval = setInterval(() => {
      const left = timeoutMs - (performance.now() - start)
      if (left <= 0) {
        clearInterval(interval)
        setRemainingMs(0)
        onDecisionRef.current(false)
        return
      }
      setRemainingMs(left)
    }, 250)
    return () => {
      clearInterval(interval)
    }
  }, [open, timeoutMs])

  const handleAccept = React.useCallback(() => {
    onDecisionRef.current(true)
  }, [])
  const handleReject = React.useCallback(() => {
    onDecisionRef.current(false)
  }, [])

  const secondsLeft = Math.max(0, Math.ceil(remainingMs / 1000))
  const countdownLabel = merged.countdown.replace('{seconds}', String(secondsLeft))

  return (
    <Dialog open={open} onClose={handleReject} width={560}>
      <DialogHeader title={merged.title} description={merged.description} onClose={handleReject} />
      <DialogBody>
        {prompt
          ? (
              <div className="space-y-3 text-[13px]">
                <dl className="space-y-3">
                  {prompt.host !== undefined
                    ? (
                        <div className="flex flex-col gap-1">
                          <dt className="text-muted-foreground">{merged.targetLabel}</dt>
                          <dd className="font-mono text-foreground">
                            {prompt.port !== undefined ? `${prompt.host}:${prompt.port}` : prompt.host}
                          </dd>
                        </div>
                      )
                    : null}
                  <div className="flex flex-col gap-1">
                    <dt className="text-muted-foreground">{merged.algorithmLabel}</dt>
                    <dd className="font-mono text-foreground">{prompt.algorithm}</dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-muted-foreground">
                      {prompt.fingerprint !== undefined ? merged.fingerprintLabel : merged.publicKeyLabel}
                    </dt>
                    <dd className="break-all rounded-md bg-muted px-3 py-2 font-mono text-[12px] leading-snug text-foreground">
                      {prompt.fingerprint ?? prompt.keyBase64}
                    </dd>
                  </div>
                </dl>
                {prompt.fingerprint !== undefined
                  ? (
                      <details className="text-muted-foreground">
                        <summary className="cursor-pointer select-none">{merged.publicKeyLabel}</summary>
                        <p className="mt-1 break-all rounded-md bg-muted px-3 py-2 font-mono text-[12px] leading-snug text-foreground">
                          {prompt.keyBase64}
                        </p>
                      </details>
                    )
                  : null}
              </div>
            )
          : null}
      </DialogBody>
      <DialogFooter className="items-center justify-between">
        <span
          className="text-[12px] text-muted-foreground"
          aria-live="polite"
          data-testid="host-key-countdown"
        >
          {countdownLabel}
        </span>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={handleReject}>
            {merged.reject}
          </Button>
          <Button type="button" variant="default" onClick={handleAccept}>
            {merged.accept}
          </Button>
        </div>
      </DialogFooter>
    </Dialog>
  )
}
