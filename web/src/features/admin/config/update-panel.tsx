import type { RevealConfirmation } from '@/shared/lib/api/accounts'
import type { UpdateStatus } from '@/shared/lib/api/system'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { StepUpDialog } from '@/features/accounts/components/step-up-dialog'
import { isStepUpRequired, stepUpErrorKey, stepUpWindowOpen } from '@/features/accounts/utils'
import { getLockStatus } from '@/shared/lib/api/encryption'
import { applyUpdate, checkForUpdate, getUpdateStatus, restartGateway } from '@/shared/lib/api/system'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { Skeleton } from '@/shared/ui/skeleton'

const UPDATE_STATUS_QUERY_KEY = ['system', 'update'] as const
const CHECK_POLL_MS = 1000
const CHECK_TIMEOUT_MS = 60_000
const RECONNECT_POLL_MS = 1500
const RECONNECT_TIMEOUT_MS = 5 * 60_000

type Action = { kind: 'update', version: string } | { kind: 'restart' }

const sleep = async (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function UpdatePanel() {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: UPDATE_STATUS_QUERY_KEY,
    queryFn: async ({ signal }) => getUpdateStatus(signal),
    refetchInterval: 5000,
  })

  return (
    <div className="px-6 pt-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.update.title')}</CardTitle>
          <div className="text-[12.5px] text-muted-foreground">{t('settings.update.hint')}</div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {query.data
            ? query.data.supervised
              ? <SupervisedUpdate status={query.data} />
              : <p className="m-0 text-[13px] text-muted-foreground">{t('settings.update.notSupervised')}</p>
            : query.isError
              ? <p className="m-0 text-[13px] text-destructive">{t('settings.update.loadError')}</p>
              : <Skeleton className="h-20 w-full" />}
        </CardContent>
      </Card>
    </div>
  )
}

function SupervisedUpdate({ status }: { status: UpdateStatus }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [checking, setChecking] = React.useState(false)
  const [checkMessage, setCheckMessage] = React.useState<{ ok: boolean, text: string } | null>(null)
  const [confirming, setConfirming] = React.useState<Action | null>(null)
  const [stepUp, setStepUp] = React.useState<Action | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [running, setRunning] = React.useState<Action | null>(null)
  const [encrypted, setEncrypted] = React.useState(false)

  React.useEffect(() => {
    void getLockStatus().then(lock => setEncrypted(lock.status !== 'disabled'), () => {})
  }, [])

  const check = async () => {
    setChecking(true)
    setCheckMessage(null)
    try {
      const nonce = await checkForUpdate()
      const deadline = Date.now() + CHECK_TIMEOUT_MS
      while (Date.now() < deadline) {
        const next = await getUpdateStatus()
        if (next.checked_nonce >= nonce) {
          queryClient.setQueryData(UPDATE_STATUS_QUERY_KEY, next)
          setCheckMessage(next.check_error
            ? { ok: false, text: t('settings.update.checkFailed', { error: next.check_error }) }
            : next.available
              ? { ok: true, text: t('settings.update.found', { version: next.available }) }
              : { ok: true, text: t('settings.update.upToDate') })
          return
        }
        await sleep(CHECK_POLL_MS)
      }
      setCheckMessage({ ok: false, text: t('settings.update.checkTimeout') })
    }
    catch (failure) {
      setCheckMessage({ ok: false, text: failure instanceof Error ? failure.message : String(failure) })
    }
    finally {
      setChecking(false)
    }
  }

  const start = async (action: Action) => {
    setError(null)
    if (await stepUpWindowOpen())
      setConfirming(action)
    else
      setStepUp(action)
  }

  // Throws on a wrong or throttled confirmation so the step-up dialog can
  // show it; any other failure closes the dialogs and shows it on the card.
  const run = async (action: Action, confirmation: RevealConfirmation) => {
    try {
      if (action.kind === 'update')
        await applyUpdate({ version: action.version, ...confirmation })
      else
        await restartGateway(confirmation)
    }
    catch (failure) {
      if (isStepUpRequired(failure)) {
        setConfirming(null)
        setStepUp(action)
        return
      }
      if (stepUpErrorKey(failure))
        throw failure
      setConfirming(null)
      setStepUp(null)
      setError(failure instanceof Error ? failure.message : String(failure))
      return
    }
    setConfirming(null)
    setStepUp(null)
    setRunning(action)
  }

  const busy = running !== null
  const lodeStatus = status.status ?? ''

  return (
    <>
      <dl className="m-0 grid grid-cols-[140px_1fr] gap-x-4 gap-y-2.5 text-[13px]">
        <dt className="text-muted-foreground">{t('settings.update.current')}</dt>
        <dd className="m-0 font-mono">{status.current ?? '—'}</dd>
        <dt className="text-muted-foreground">{t('settings.update.available')}</dt>
        <dd className="m-0 font-mono">
          {status.available
            ? <Badge tone="info">{status.available}</Badge>
            : <span className="font-sans text-muted-foreground">{t('settings.update.none')}</span>}
        </dd>
        <dt className="text-muted-foreground">{t('settings.update.status')}</dt>
        <dd className="m-0">{lodeStatus ? t(`settings.update.statusValues.${lodeStatus}`, { defaultValue: lodeStatus }) : '—'}</dd>
        <dt className="text-muted-foreground">{t('settings.update.lastCheck')}</dt>
        <dd className="m-0">{status.last_check ? new Date(status.last_check).toLocaleString() : '—'}</dd>
        {status.last_error
          ? (
              <>
                <dt className="text-muted-foreground">{t('settings.update.lastError')}</dt>
                <dd className="m-0 break-words text-destructive">{status.last_error}</dd>
              </>
            )
          : null}
      </dl>

      {checkMessage
        ? (
            <div className={checkMessage.ok ? 'inline-flex items-center gap-1.5 text-[12.5px] text-[hsl(var(--success))]' : 'inline-flex items-center gap-1.5 text-[12.5px] text-destructive'}>
              {checkMessage.ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
              <span>{checkMessage.text}</span>
            </div>
          )
        : null}
      {error ? <div className="text-[12.5px] text-destructive">{error}</div> : null}
      {running ? <Reconnect action={running} instance={status.instance ?? null} /> : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => { void check() }} disabled={checking || busy}>
          {checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          {checking ? t('settings.update.checking') : t('settings.update.check')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => { void start({ kind: 'restart' }) }} disabled={busy}>
          <RotateCcw size={13} />
          {t('settings.update.restart')}
        </Button>
        {status.available
          ? (
              <Button size="sm" onClick={() => { void start({ kind: 'update', version: status.available! }) }} disabled={busy}>
                {t('settings.update.update', { version: status.available })}
              </Button>
            )
          : null}
      </div>

      <Dialog open={confirming !== null} onClose={() => setConfirming(null)} width={440}>
        <DialogHeader title={confirming ? actionTitle(t, confirming) : ''} description={t('settings.update.confirm.description')} />
        {encrypted ? <DialogBody className="text-[12.5px] text-muted-foreground">{t('settings.update.confirm.encryptedNote')}</DialogBody> : null}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setConfirming(null)}>{t('settings.update.confirm.cancel')}</Button>
          <Button
            size="sm"
            onClick={() => {
              if (confirming)
                void run(confirming, {}).catch(() => {})
            }}
          >
            {t('settings.update.confirm.confirm')}
          </Button>
        </DialogFooter>
      </Dialog>
      <StepUpDialog
        open={stepUp !== null}
        title={stepUp ? actionTitle(t, stepUp) : ''}
        description={encrypted
          ? `${t('settings.update.confirm.description')} ${t('settings.update.confirm.encryptedNote')}`
          : t('settings.update.confirm.description')}
        confirmLabel={t('settings.update.confirm.confirm')}
        onCancel={() => setStepUp(null)}
        onConfirm={async (confirmation) => {
          if (stepUp)
            await run(stepUp, confirmation)
        }}
      />
    </>
  )
}

function actionTitle(t: (key: string, options?: Record<string, unknown>) => string, action: Action): string {
  return action.kind === 'update'
    ? t('settings.update.confirm.updateTitle', { version: action.version })
    : t('settings.update.confirm.restartTitle')
}

// Waits for the gateway to come back as a new lode instance (or locked, when
// encryption is on) and reloads the page into it.
function Reconnect({ action, instance }: { action: Action, instance: string | null }) {
  const { t } = useTranslation()
  const [timedOut, setTimedOut] = React.useState(false)

  React.useEffect(() => {
    const run = { cancelled: false }
    const deadline = Date.now() + RECONNECT_TIMEOUT_MS
    void (async () => {
      while (!run.cancelled && Date.now() < deadline) {
        await sleep(RECONNECT_POLL_MS)
        try {
          const lock = await getLockStatus()
          if (lock.status === 'locked' || lock.status === 'uninitialized') {
            window.location.reload()
            return
          }
          const next = await getUpdateStatus()
          if (next.instance && next.instance !== instance) {
            window.location.reload()
            return
          }
        }
        catch {
          // The gateway is down while lode swaps the process.
        }
      }
      if (!run.cancelled)
        setTimedOut(true)
    })()
    return () => {
      run.cancelled = true
    }
  }, [instance])

  if (timedOut)
    return <div className="text-[12.5px] text-destructive">{t('settings.update.progress.timeout')}</div>
  return (
    <div className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
      <Loader2 size={13} className="animate-spin" />
      {action.kind === 'update'
        ? t('settings.update.progress.updating', { version: action.version })
        : t('settings.update.progress.restarting')}
    </div>
  )
}
