import type { LucideIcon } from 'lucide-react'
import type { Target, User } from '@/shared/types/domain'
import { useNavigate } from '@tanstack/react-router'
import { Activity, Database, FileText, Home, Inbox, Key, Search, Server, ShieldCheck, SlidersHorizontal, Terminal, Ticket, User as UserIcon, Users } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useTargets } from '@/features/targets/hooks/use-targets-queries'
import { formatTargetAddress } from '@/features/targets/lib/target-address'
import { useUsers } from '@/features/users/hooks/use-users-queries'
import { useIsAdmin } from '@/shared/hooks/use-info'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Kbd } from '@/shared/ui/kbd'

interface PageItem {
  kind: 'page'
  label: string
  to: string
  group: string
  icon: LucideIcon
}

interface TargetItem {
  kind: 'target'
  label: string
  sub: string
  group: string
  target: Target
}

interface UserItem {
  kind: 'user'
  label: string
  sub: string
  group: string
  user: User
}

type Item = PageItem | TargetItem | UserItem

interface GroupHeader {
  kind: 'header'
  key: string
  label: string
}

const KIND_ICON: Record<Target['kind'], LucideIcon> = {
  ssh: Terminal,
  mysql: Database,
  postgres: Database,
  http: Server,
}

const TITLE_ID = 'spotlight-dialog-title'
const DESC_ID = 'spotlight-dialog-description'
const LISTBOX_ID = 'spotlight-results'
const optionId = (idx: number) => `spotlight-option-${idx}`

export function SpotlightDialog({ open, onClose }: { open: boolean, onClose: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const targetsData = useTargets().data
  const usersData = useUsers().data
  const isAdmin = useIsAdmin()

  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const triggerRef = React.useRef<HTMLElement | null>(null)

  React.useEffect(() => {
    if (!open) {
      triggerRef.current?.focus?.()
      triggerRef.current = null
      return
    }
    triggerRef.current = document.activeElement as HTMLElement | null
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [open])

  const allItems = React.useMemo<Item[]>(() => {
    const targets = targetsData ?? []
    const users = usersData ?? []
    const pages: PageItem[] = [
      { kind: 'page', to: '/overview', label: t('nav.overview'), group: t('spotlight.groupPages'), icon: Home },
      { kind: 'page', to: '/targets', label: t('nav.targets'), group: t('spotlight.groupPages'), icon: Server },
      { kind: 'page', to: '/auth-requests', label: t('nav.authRequests'), group: t('spotlight.groupPages'), icon: Inbox },
      { kind: 'page', to: '/sessions', label: t('nav.sessions'), group: t('spotlight.groupPages'), icon: Terminal },
      { kind: 'page', to: '/credentials', label: t('nav.credentials'), group: t('spotlight.groupPages'), icon: Key },
      { kind: 'page', to: '/tickets', label: t('nav.tickets'), group: t('spotlight.groupPages'), icon: Ticket },
    ]
    if (isAdmin) {
      pages.push(
        { kind: 'page', to: '/admin/sessions', label: t('nav.adminSessions'), group: t('spotlight.groupPages'), icon: Activity },
        { kind: 'page', to: '/admin/audit', label: t('nav.adminAudit'), group: t('spotlight.groupPages'), icon: FileText },
        { kind: 'page', to: '/admin/targets', label: t('nav.adminTargets'), group: t('spotlight.groupPages'), icon: Server },
        { kind: 'page', to: '/admin/accounts', label: t('nav.adminAccounts'), group: t('spotlight.groupPages'), icon: UserIcon },
        { kind: 'page', to: '/admin/users', label: t('nav.adminUsers'), group: t('spotlight.groupPages'), icon: Users },
        { kind: 'page', to: '/admin/roles', label: t('nav.adminRoles'), group: t('spotlight.groupPages'), icon: ShieldCheck },
        { kind: 'page', to: '/admin/params', label: t('nav.adminParams'), group: t('spotlight.groupPages'), icon: SlidersHorizontal },
      )
    }
    const targetItems: TargetItem[] = targets.map(target => ({
      kind: 'target',
      label: target.name,
      sub: formatTargetAddress(target),
      group: t('spotlight.groupTargets'),
      target,
    }))
    const userItems: UserItem[] = isAdmin
      ? users.map(user => ({ kind: 'user', label: user.name, sub: user.username, group: t('spotlight.groupUsers'), user }))
      : []
    return [...pages, ...targetItems, ...userItems]
  }, [t, isAdmin, targetsData, usersData])

  const filtered = React.useMemo(() => {
    if (!query)
      return allItems.slice(0, 24)
    const needle = query.toLowerCase()
    return allItems
      .filter((item) => {
        const hay = item.kind === 'target'
          ? `${item.label} ${item.sub} ${item.target.kind}`
          : `${item.label} ${'sub' in item ? item.sub : ''}`
        return hay.toLowerCase().includes(needle)
      })
      .slice(0, 40)
  }, [allItems, query])

  const safeActive = active >= filtered.length ? Math.max(0, filtered.length - 1) : active
  const listRef = React.useRef<HTMLUListElement>(null)
  React.useEffect(() => {
    if (!open || filtered.length === 0)
      return
    const node = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(optionId(safeActive))}`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [open, safeActive, filtered.length])

  const select = React.useCallback((item: Item) => {
    if (item.kind === 'page') {
      void navigate({ to: item.to })
    }
    else if (item.kind === 'target') {
      void navigate({ to: '/sessions' })
    }
    else {
      void navigate({ to: '/admin/users' })
    }
    onClose()
  }, [navigate, onClose])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(Math.min(filtered.length - 1, safeActive + 1))
    }
    else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(Math.max(0, safeActive - 1))
    }
    else if (event.key === 'Enter') {
      const item = filtered[safeActive]
      if (item) {
        event.preventDefault()
        select(item)
      }
    }
    else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  if (!open)
    return null

  const rendered: Array<(Item & { _idx: number }) | GroupHeader> = []
  let lastGroup: string | null = null
  filtered.forEach((item, index) => {
    if (item.group !== lastGroup) {
      rendered.push({ kind: 'header', key: `h-${item.group}-${index}`, label: item.group })
      lastGroup = item.group
    }
    rendered.push({ ...item, _idx: index })
  })

  const activeRow = filtered[safeActive]
  const activeId = activeRow ? optionId(safeActive) : undefined

  return (
    <div
      className="drawer-backdrop fixed inset-0 z-[60] flex items-start justify-center px-5 pt-[120px] backdrop-blur-[4px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={DESC_ID}
        className="page-enter w-full max-w-[560px] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-[0_30px_80px_rgba(0,0,0,0.35),0_12px_30px_rgba(0,0,0,0.12)]"
        onClick={event => event.stopPropagation()}
      >
        <h2 id={TITLE_ID} className="sr-only">{t('a11y.shell.search.dialogTitle')}</h2>
        <p id={DESC_ID} className="sr-only">{t('a11y.shell.search.dialogDescription')}</p>
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <Search aria-hidden="true" size={18} className="text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            placeholder={t('spotlight.placeholder')}
            aria-label={t('a11y.shell.search.input')}
            aria-autocomplete="list"
            aria-controls={LISTBOX_ID}
            aria-activedescendant={activeId}
            role="combobox"
            aria-expanded={true}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 border-0 bg-transparent text-[17px] leading-7 outline-none ring-0 placeholder:text-muted-foreground/70 focus:border-0 focus:outline-none focus:ring-0 focus-visible:outline-none"
          />
          <Kbd aria-hidden="true">ESC</Kbd>
        </div>
        <div className="max-h-[420px] overflow-y-auto p-1.5">
          {filtered.length === 0
            ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="px-6 py-6 text-center text-[13px] text-muted-foreground"
                >
                  {t('spotlight.empty')}
                </div>
              )
            : (
                <ul
                  ref={listRef}
                  id={LISTBOX_ID}
                  role="listbox"
                  aria-label={t('a11y.shell.search.results')}
                  className="m-0 list-none p-0"
                >
                  {rendered.map((row) => {
                    if (row.kind === 'header') {
                      return (
                        <li
                          key={row.key}
                          role="presentation"
                          className="px-2.5 pb-1 pt-2.5 text-[10.5px] font-medium uppercase tracking-[0.04em] text-muted-foreground"
                        >
                          {row.label}
                        </li>
                      )
                    }
                    const isActive = row._idx === safeActive
                    return (
                      <li
                        key={`${row.kind}-${row._idx}`}
                        id={optionId(row._idx)}
                        role="option"
                        aria-selected={isActive}
                      >
                        <button
                          type="button"
                          tabIndex={-1}
                          onMouseEnter={() => setActive(row._idx)}
                          onClick={() => select(row)}
                          className={`flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left transition ${isActive ? 'bg-accent' : ''}`}
                        >
                          <SpotlightRowIcon row={row} />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13.5px] font-medium">{row.label}</div>
                            {row.kind !== 'page' && row.sub
                              ? <div className="mono truncate text-[11px] text-muted-foreground">{row.sub}</div>
                              : null}
                          </div>
                          {row.kind === 'target' ? <Badge tone="mono">{row.target.kind.toUpperCase()}</Badge> : null}
                          {isActive ? <Kbd aria-hidden="true">↵</Kbd> : null}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
        </div>
        <div className="flex items-center gap-3 border-t border-border px-3.5 py-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Kbd aria-hidden="true">↑↓</Kbd>
            <span>{t('spotlight.navigate')}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd aria-hidden="true">↵</Kbd>
            <span>{t('spotlight.openHint')}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd aria-hidden="true">ESC</Kbd>
            <span>{t('spotlight.closeHint')}</span>
          </span>
          <span className="flex-1" />
          <span aria-live="polite" aria-atomic="true">
            {filtered.length}
            {' '}
            {t('spotlight.results')}
          </span>
        </div>
      </div>
    </div>
  )
}

function SpotlightRowIcon({ row }: { row: (Item & { _idx: number }) }) {
  if (row.kind === 'page') {
    const Icon = row.icon
    return (
      <div className="flex h-[26px] w-[26px] items-center justify-center rounded-md bg-secondary">
        <Icon size={14} />
      </div>
    )
  }
  if (row.kind === 'target') {
    const Icon = KIND_ICON[row.target.kind]
    return (
      <div className="flex h-[26px] w-[26px] items-center justify-center rounded-md bg-secondary">
        <Icon size={14} />
      </div>
    )
  }
  return <Avatar name={row.user.name} size={26} />
}
