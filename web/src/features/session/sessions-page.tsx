import type { TerminalKind } from '@/features/terminal/codec'
import type { BannerStatus } from '@/features/terminal/terminal-status'
import type { Target } from '@/shared/types/domain'
import type { TerminalTab } from '@/store/app-store'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowRight,
  Maximize2,
  Minimize2,
  Plus,
  Search,
  Server,
  Terminal,
  X,
} from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { FileManager } from '@/features/files/file-manager'
import { SqlConsolePage } from '@/features/sql-console/sql-console-page'
import { useTargets } from '@/features/targets/hooks/use-targets-queries'
import { TerminalScreen } from '@/features/terminal/terminal-screen'
import { statusDotClass } from '@/features/terminal/terminal-status'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { Kbd } from '@/shared/ui/kbd'
import { useAppStore } from '@/store/app-store'

const TERMINAL_KINDS: readonly Target['kind'][] = ['ssh', 'mysql', 'postgres']

function isTerminalKind(kind: Target['kind']): kind is TerminalKind {
  return (TERMINAL_KINDS as readonly string[]).includes(kind)
}

// Mounted by the app layout rather than the route so open terminals (and
// their WebSockets) survive navigating away; hidden while off-route.
export function SessionsPage({ visible }: { visible: boolean }) {
  const { t } = useTranslation()
  const targetsData = useTargets().data
  // Only protocols with an in-browser terminal client (api.md §1.8). HTTP
  // targets are reached through the HTTP proxy listener, not a terminal.
  const targets = React.useMemo(
    () => (targetsData ?? []).filter(target => isTerminalKind(target.kind)),
    [targetsData],
  )
  const fullscreen = useAppStore(state => state.terminalFullscreen)
  const setFullscreen = useAppStore(state => state.setTerminalFullscreen)

  const openSessions = useAppStore(state => state.terminalTabs)
  const activeId = useAppStore(state => state.activeTerminalTabId)
  const openTerminalTab = useAppStore(state => state.openTerminalTab)
  const closeSession = useAppStore(state => state.closeTerminalTab)
  const setActiveId = useAppStore(state => state.setActiveTerminalTab)
  const [quickOpen, setQuickOpen] = React.useState(false)
  const [statuses, setStatuses] = React.useState<Record<string, BannerStatus>>({})
  const reportStatus = React.useCallback((id: string, status: BannerStatus) => {
    setStatuses(prev => prev[id] === status ? prev : { ...prev, [id]: status })
  }, [])

  React.useEffect(() => {
    if (!visible)
      return undefined
    const onKey = (event: KeyboardEvent) => {
      const k = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && k === 'n') {
        event.preventDefault()
        setQuickOpen(true)
        return
      }
      if (event.key === 'F11' || ((event.metaKey || event.ctrlKey) && event.shiftKey && k === 'f')) {
        event.preventDefault()
        setFullscreen(!useAppStore.getState().terminalFullscreen)
        return
      }
      if (event.key === 'Escape') {
        if (quickOpen) {
          setQuickOpen(false)
        }
        else if (useAppStore.getState().terminalFullscreen) {
          setFullscreen(false)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, quickOpen, setFullscreen])

  React.useEffect(() => {
    if (!visible)
      return undefined
    return () => {
      setFullscreen(false)
    }
  }, [visible, setFullscreen])

  const openSession = (target: Target) => {
    if (!isTerminalKind(target.kind))
      return
    openTerminalTab({ type: 'terminal', kind: target.kind, targetId: target.id, targetName: target.name })
  }

  const active = openSessions.find(s => s.id === activeId) ?? openSessions[0]

  const bannerLabels = {
    connecting: t('terminal.status.connecting'),
    connected: t('terminal.status.connected'),
    closed: t('terminal.status.closed'),
    error: t('terminal.status.error'),
    rate_limited: t('terminal.status.rateLimited'),
    info: t('terminal.status.info'),
  }

  const hostKeyLabels = {
    title: t('terminal.hostKey.title'),
    description: t('terminal.hostKey.description'),
    algorithmLabel: t('terminal.hostKey.algorithm'),
    fingerprintLabel: t('terminal.hostKey.fingerprint'),
    countdown: t('terminal.hostKey.countdown'),
    accept: t('terminal.hostKey.accept'),
    reject: t('terminal.hostKey.reject'),
  }

  const statusMenuLabels = {
    title: t('terminal.connection.title'),
    message: t('terminal.connection.message'),
    target: t('terminal.connection.target'),
    address: t('terminal.connection.address'),
    username: t('terminal.connection.username'),
    connectedAt: t('terminal.connection.connectedAt'),
    duration: t('terminal.connection.duration'),
    sessionId: t('terminal.connection.sessionId'),
    hostKey: t('terminal.connection.hostKey'),
    tls: t('terminal.connection.tls'),
    tlsVerified: t('terminal.connection.tlsVerified'),
    tlsNotVerified: t('terminal.connection.tlsNotVerified'),
    client: t('terminal.connection.client'),
    database: t('terminal.connection.database'),
  }

  const keyBarLabels = {
    toolbar: t('terminal.keys.toolbar'),
    up: t('terminal.keys.up'),
    down: t('terminal.keys.down'),
    left: t('terminal.keys.left'),
    right: t('terminal.keys.right'),
  }

  return (
    <section
      aria-label={t('a11y.sessions.workspace')}
      className={cn('flex h-full min-h-0 flex-1 flex-col', !visible && 'hidden')}
    >
      <h1 className="sr-only">{t('a11y.sessions.workspace')}</h1>
      {openSessions.length > 0 && (
        <div
          role="tablist"
          aria-label={t('a11y.sessions.tablist')}
          aria-orientation="horizontal"
          className="flex h-10 flex-none items-stretch overflow-x-auto border-b border-border bg-card"
        >
          {openSessions.map(session => (
            <SessionTab
              key={session.id}
              session={session}
              active={session.id === active?.id}
              status={statuses[session.id]}
              onSelect={() => setActiveId(session.id)}
              onClose={() => closeSession(session.id)}
            />
          ))}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setQuickOpen(true)}
            className="mx-1 self-center"
            title={`${t('sessions.newConnection')} (⌘N)`}
            aria-label={t('a11y.sessions.newConnection')}
          >
            <Plus size={15} />
          </Button>
          <span className="flex-1" />
          <div className="flex flex-none items-center px-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setFullscreen(!fullscreen)}
              aria-label={fullscreen ? t('sessions.exitFullscreen') : t('sessions.fullscreen')}
              title={fullscreen ? t('sessions.exitFullscreen') : t('sessions.fullscreen')}
            >
              {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </Button>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {openSessions.length === 0
          ? <SessionsEmptyState onConnect={() => setQuickOpen(true)} targets={targets} onOpen={openSession} />
          : (
              // Keep every terminal mounted so its WebSocket survives tab
              // switches; inactive panes are display-hidden only.
              openSessions.map(session => (
                <div
                  key={session.id}
                  className={cn('min-h-0 flex-1', session.type !== 'terminal' && 'p-2', session.id !== active?.id && 'hidden')}
                >
                  {session.type === 'sql'
                    ? <SqlConsolePage targetName={session.targetName} />
                    : session.type === 'files'
                      ? <FileManager targetName={session.targetName} className="h-full" />
                      : (
                          <TerminalScreen
                            kind={session.kind}
                            targetName={session.targetName}
                            bannerLabels={bannerLabels}
                            hostKeyLabels={hostKeyLabels}
                            keyBarLabels={keyBarLabels}
                            statusMenuLabels={statusMenuLabels}
                            onStatusChange={status => reportStatus(session.id, status)}
                            className="h-full"
                          />
                        )}
                </div>
              ))
            )}
      </div>

      <QuickConnectDialog
        open={quickOpen}
        targets={targets}
        onClose={() => setQuickOpen(false)}
        onSelect={(tg) => {
          openSession(tg)
          setQuickOpen(false)
        }}
      />
    </section>
  )
}

function SessionTab({ session, active, status, onSelect, onClose }: {
  session: TerminalTab
  active: boolean
  status?: BannerStatus
  onSelect: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.key === 'w' || event.key === 'W') && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
  }
  return (
    <div
      role="tab"
      tabIndex={active ? 0 : -1}
      aria-selected={active}
      onClick={onSelect}
      onKeyDown={(event) => {
        onKeyDown(event)
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'focus-ring group relative inline-flex min-w-0 max-w-[240px] flex-none cursor-pointer items-center gap-2 border-r border-border pl-3 pr-1.5 text-[13px] transition',
        active ? 'bg-background' : 'text-muted-foreground hover:bg-[hsl(var(--accent)/0.55)] hover:text-foreground',
      )}
    >
      {active ? <span className="absolute inset-x-0 top-0 h-[2px] bg-[hsl(var(--info))]" /> : null}
      <span
        aria-hidden="true"
        data-status={status}
        className={cn('h-2 w-2 shrink-0 rounded-full', statusDotClass(status))}
      />
      <span className={cn('truncate', active ? 'font-medium' : 'font-normal')}>{session.targetName}</span>
      <Badge tone="mono" className="h-4 px-1.5 py-0 text-[10.5px]">{session.type === 'sql' ? 'SQL' : session.type === 'files' ? 'SFTP' : session.kind.toUpperCase()}</Badge>
      <button
        type="button"
        aria-label={t('a11y.sessions.closeSession', { name: session.targetName })}
        title={t('sessions.close')}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
        className={cn('focus-ring inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground', active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70 focus-visible:opacity-100')}
      >
        <X size={12} />
      </button>
    </div>
  )
}

function SessionsEmptyState({ onConnect, targets, onOpen }: {
  onConnect: () => void
  targets: Target[]
  onOpen: (target: Target) => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const recent = React.useMemo(
    () => [...targets].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 4),
    [targets],
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 p-10">
      <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-muted text-foreground">
        <Terminal size={28} />
      </div>
      <div className="max-w-[460px] text-center">
        <h2 className="m-0 text-[20px] font-semibold">{t('sessions.emptyTitle')}</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">{t('sessions.emptyDescription')}</p>
      </div>
      <div className="flex gap-2">
        <Button onClick={onConnect}>
          <Plus size={14} />
          <span>{t('sessions.newConnection')}</span>
          <Kbd className="border-primary-foreground/25 bg-primary-foreground/15 text-current">⌘N</Kbd>
        </Button>
        <Button variant="outline" onClick={() => { void navigate({ to: '/targets' }) }}>
          <Server size={14} />
          <span>{t('sessions.browseAll')}</span>
        </Button>
      </div>
      {recent.length > 0
        ? (
            <Card className="w-full max-w-[560px] p-0">
              <div className="border-b border-border px-4 py-2.5 text-[12px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
                {t('sessions.recent')}
              </div>
              {recent.map((target, idx) => (
                <button
                  key={target.id}
                  type="button"
                  onClick={() => onOpen(target)}
                  className={cn(
                    'focus-ring flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13.5px] transition hover:bg-accent',
                    idx > 0 && 'border-t border-border',
                  )}
                >
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Terminal size={14} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{target.name}</div>
                    <div className="mono truncate text-[11px] text-muted-foreground">{target.kind.toUpperCase()}</div>
                  </div>
                  <ArrowRight size={14} className="text-muted-foreground" />
                </button>
              ))}
            </Card>
          )
        : null}
    </div>
  )
}

interface QuickConnectDialogProps {
  open: boolean
  onClose: () => void
  targets: Target[]
  onSelect: (target: Target) => void
}

function QuickConnectDialog(props: QuickConnectDialogProps) {
  if (!props.open)
    return null
  return <QuickConnectDialogBody {...props} />
}

function QuickConnectDialogBody({ onClose, targets, onSelect }: QuickConnectDialogProps) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [])

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q)
      return targets
    return targets.filter((tg) => {
      const hay = `${tg.name} ${tg.host} ${tg.user}`.toLowerCase()
      return hay.includes(q)
    })
  }, [targets, query])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(a => Math.min(filtered.length - 1, a + 1))
    }
    else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(a => Math.max(0, a - 1))
    }
    else if (event.key === 'Enter' && filtered[active]) {
      event.preventDefault()
      onSelect(filtered[active])
    }
  }

  return (
    <div
      className="drawer-backdrop fixed inset-0 z-50 flex items-start justify-center px-5 pt-[120px] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="page-enter w-full max-w-[560px] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-[0_30px_80px_rgba(0,0,0,0.35),0_12px_30px_rgba(0,0,0,0.12)]"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-3">
          <Search size={16} className="text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            placeholder={t('quickConnect.placeholder')}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <Kbd>ESC</Kbd>
        </div>
        <div className="max-h-[360px] overflow-y-auto p-1.5">
          {filtered.length === 0
            ? (
                <div className="px-3 py-6 text-center text-[13px] text-muted-foreground">
                  {t('quickConnect.noMatch')}
                </div>
              )
            : (
                filtered.slice(0, 20).map((tg, i) => {
                  const isActive = i === active
                  return (
                    <button
                      key={tg.id}
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => onSelect(tg)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-sm px-3 py-2.5 text-left',
                        isActive && 'bg-accent',
                      )}
                    >
                      <span
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-muted text-[hsl(var(--info))]"
                      >
                        <Terminal size={14} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-medium">{tg.name}</div>
                        <div className="mono truncate text-[11px] text-muted-foreground">{tg.kind.toUpperCase()}</div>
                      </div>
                      <Badge tone="mono" className="h-[18px] px-1.5 py-0 text-[10.5px]">{tg.kind.toUpperCase()}</Badge>
                      {isActive ? <Kbd>↵</Kbd> : null}
                    </button>
                  )
                })
              )}
        </div>
        <div className="flex items-center gap-3 border-t border-border px-3.5 py-2 text-[11px] text-muted-foreground">
          <span>
            <Kbd>↑↓</Kbd>
            {' '}
            {t('quickConnect.navigate')}
          </span>
          <span>
            <Kbd>↵</Kbd>
            {' '}
            {t('quickConnect.connect')}
          </span>
          <span>
            <Kbd>ESC</Kbd>
            {' '}
            {t('quickConnect.close')}
          </span>
          <span className="flex-1" />
          <span>
            {filtered.length}
            {' '}
            /
            {' '}
            {targets.length}
          </span>
        </div>
      </div>
    </div>
  )
}
