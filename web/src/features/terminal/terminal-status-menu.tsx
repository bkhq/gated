import type { ConnectedDetails, TerminalKind } from './codec'
import type { BannerLabels, BannerStatus } from './terminal-status'
import { Popover } from '@base-ui/react/popover'
import * as React from 'react'
import { TerminalStatusBanner } from './terminal-status-banner'

export interface TerminalConnection {
  connectedAt: Date
  // Set once the session ends; freezes the duration.
  endedAt: Date | null
  details?: ConnectedDetails
}

export interface TerminalStatusMenuLabels {
  title: string
  message: string
  target: string
  address: string
  username: string
  connectedAt: string
  duration: string
  sessionId: string
  hostKey: string
  tls: string
  tlsVerified: string
  tlsNotVerified: string
  client: string
  database: string
}

const DEFAULT_LABELS: TerminalStatusMenuLabels = {
  title: 'Connection',
  message: 'Message',
  target: 'Target',
  address: 'Address',
  username: 'User',
  connectedAt: 'Connected at',
  duration: 'Duration',
  sessionId: 'Session ID',
  hostKey: 'Host key',
  tls: 'TLS',
  tlsVerified: 'certificate verified',
  tlsNotVerified: 'certificate not verified',
  client: 'Client',
  database: 'Database',
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0)
    return `${h}h ${m}m ${s}s`
  if (m > 0)
    return `${m}m ${s}s`
  return `${s}s`
}

export interface TerminalStatusMenuProps {
  status: BannerStatus
  // Latest status frame message (errors arrive here verbatim).
  message?: string
  connection: TerminalConnection | null
  kind: TerminalKind
  targetName: string
  bannerLabels?: Partial<BannerLabels>
  labels?: Partial<TerminalStatusMenuLabels>
}

// Status-bar trigger showing only the connection state; the message, target
// and server facts open in a popover so a long error never stretches the bar.
export function TerminalStatusMenu({ status, message, connection, kind, targetName, bannerLabels, labels }: TerminalStatusMenuProps) {
  const merged: TerminalStatusMenuLabels = { ...DEFAULT_LABELS, ...labels }
  const [open, setOpen] = React.useState(false)
  const [now, setNow] = React.useState(() => Date.now())
  const live = open && connection !== null && connection.endedAt === null
  // Tick once a second while a live duration is shown.
  React.useEffect(() => {
    if (!live)
      return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  const details = connection?.details

  const rows: [string, React.ReactNode][] = [
    [merged.target, `${kind.toUpperCase()} · ${targetName}`],
  ]
  if (message)
    rows.push([merged.message, message])
  if (details) {
    rows.push([merged.address, details.address])
    rows.push([merged.username, details.username])
    if (details.database)
      rows.push([merged.database, details.database])
    if (details.host_key)
      rows.push([merged.hostKey, `${details.host_key.algorithm} ${details.host_key.fingerprint}`])
    if (details.tls)
      rows.push([merged.tls, `${details.tls.mode} · ${details.tls.verify ? merged.tlsVerified : merged.tlsNotVerified}`])
    if (details.client)
      rows.push([merged.client, details.client])
  }
  if (connection) {
    rows.push([merged.connectedAt, connection.connectedAt.toLocaleString()])
    rows.push([merged.duration, formatDuration((connection.endedAt?.getTime() ?? now) - connection.connectedAt.getTime())])
  }
  if (details)
    rows.push([merged.sessionId, details.session_id])

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next)
          setNow(Date.now())
        setOpen(next)
      }}
    >
      <Popover.Trigger className="focus-ring -ml-1.5 inline-flex h-5 min-w-0 items-center rounded px-1.5 hover:bg-white/10 hover:text-zinc-200 data-[popup-open]:bg-white/10 data-[popup-open]:text-zinc-200">
        <TerminalStatusBanner variant="bar" status={status} labels={bannerLabels} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={6} className="z-50 outline-none">
          <Popover.Popup className="w-[min(440px,calc(100vw-24px))] rounded-lg border border-white/10 bg-[#161a22] p-3 text-[12px] text-zinc-300 shadow-[0_12px_30px_rgba(0,0,0,0.35)] outline-none">
            <Popover.Title className="m-0 mb-2 text-[12.5px] font-semibold text-zinc-100">{merged.title}</Popover.Title>
            <dl className="m-0 grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5">
              {rows.map(([label, value]) => (
                <React.Fragment key={label}>
                  <dt className="text-zinc-500">{label}</dt>
                  <dd className="m-0 select-text break-all font-mono text-[11.5px] text-zinc-200">{value}</dd>
                </React.Fragment>
              ))}
            </dl>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
