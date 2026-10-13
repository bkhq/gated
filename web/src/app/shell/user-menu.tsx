import type { LucideIcon } from 'lucide-react'
import type { Lang, ThemeMode } from '@/store/app-store'
import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import { useNavigate } from '@tanstack/react-router'
import { Check, ChevronRight, Info, LogOut, Monitor, Moon, Sun, User } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useLogout } from '@/shared/hooks/use-auth'
import { useInfo } from '@/shared/hooks/use-info'
import { SUPPORTED_LANGS } from '@/shared/lib/languages'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { useAppStore } from '@/store/app-store'

interface UserMenuProps {
  open: boolean
  onClose: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
  collapsed: boolean
  pendingCount?: number
}

export function UserMenu({ open, onClose, anchorRef, collapsed, pendingCount = 0 }: UserMenuProps) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const theme = useAppStore(state => state.theme)
  const setTheme = useAppStore(state => state.setTheme)
  const lang = useAppStore(state => state.lang)
  const setLang = useAppStore(state => state.setLang)
  const logout = useLogout()
  const info = useInfo()
  const displayName = info.data?.username ?? ''
  const appVersion = info.data?.version ? `v${info.data.version}` : ''
  const gatewayHost = info.data?.external_host ?? ''

  const containerRef = React.useRef<HTMLDivElement>(null)

  React.useLayoutEffect(() => {
    if (!open || !containerRef.current || !anchorRef.current)
      return
    const rect = anchorRef.current.getBoundingClientRect()
    const left = collapsed ? rect.right + 8 : rect.left
    const bottom = window.innerHeight - rect.top + 8
    containerRef.current.style.left = `${left}px`
    containerRef.current.style.bottom = `${bottom}px`
  }, [open, anchorRef, collapsed])

  const wasOpenRef = React.useRef(false)
  React.useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) {
        wasOpenRef.current = false
        anchorRef.current?.focus()
      }
      return
    }
    wasOpenRef.current = true
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target)
        return
      if (containerRef.current?.contains(target))
        return
      if (anchorRef.current?.contains(target))
        return
      if ((target as Element).closest?.('[data-user-menu-submenu]'))
        return
      onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape')
        onClose()
    }
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onDoc), 0)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, anchorRef, onClose])

  React.useEffect(() => {
    if (!open || !containerRef.current)
      return
    const firstItem = containerRef.current.querySelector<HTMLElement>('[role="menuitem"]')
    firstItem?.focus()
  }, [open])

  if (!open)
    return null

  const switchLang = (nextLang: Lang) => {
    if (lang === nextLang)
      return
    setLang(nextLang)
    void i18n.changeLanguage(nextLang)
  }

  const themeOptions: ReadonlyArray<{ value: ThemeMode, label: string, icon: LucideIcon }> = [
    { value: 'system', label: t('menu.theme.followSystem'), icon: Monitor },
    { value: 'light', label: t('menu.theme.light'), icon: Sun },
    { value: 'dark', label: t('menu.theme.dark'), icon: Moon },
  ]
  const currentThemeLabel = themeOptions.find(o => o.value === theme)?.label ?? ''
  const currentLangLabel = SUPPORTED_LANGS.find(o => o.code === lang)?.label ?? ''

  return (
    <div
      ref={containerRef}
      id="app-user-menu"
      role="menu"
      aria-label={t('a11y.shell.userMenuPopup')}
      className="page-enter fixed z-[60] w-[240px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-[0_12px_32px_rgba(0,0,0,0.18)]"
    >
      <div className="mb-1 flex items-center gap-2.5 border-b border-border px-2.5 pb-2 pt-2.5" role="presentation">
        <Avatar name={displayName} size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{displayName}</div>
        </div>
      </div>

      <MenuRow
        icon={User}
        label={t('menu.profile')}
        onClick={() => {
          void navigate({ to: '/profile' })
          onClose()
        }}
        right={pendingCount > 0
          ? <Badge tone="info" className="h-[18px] px-1.5 py-0">{pendingCount}</Badge>
          : null}
      />

      <div role="separator" className="mx-1.5 my-1 h-px bg-border" />

      <SubmenuRow label={t('menu.theme.title')} current={currentThemeLabel}>
        {themeOptions.map(option => (
          <SubmenuItem
            key={option.value}
            icon={option.icon}
            active={theme === option.value}
            onClick={() => {
              setTheme(option.value)
              onClose()
            }}
          >
            {option.label}
          </SubmenuItem>
        ))}
      </SubmenuRow>

      <SubmenuRow label={t('menu.language.title')} current={currentLangLabel}>
        {SUPPORTED_LANGS.map(option => (
          <SubmenuItem
            key={option.code}
            active={lang === option.code}
            onClick={() => {
              switchLang(option.code)
              onClose()
            }}
          >
            {option.label}
          </SubmenuItem>
        ))}
      </SubmenuRow>

      <div role="separator" className="mx-1.5 my-1 h-px bg-border" />

      <div role="separator" className="mx-1.5 my-1 h-px bg-border" />

      <MenuRow
        icon={LogOut}
        label={t('actions.signOut')}
        danger
        onClick={() => {
          onClose()
          logout.mutate(undefined, {
            onSettled: () => {
              void navigate({ to: '/auth/login' })
            },
          })
        }}
      />

      {appVersion || gatewayHost
        ? (
            <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-0.5 text-[10.5px] text-muted-foreground/70">
              <Info aria-hidden="true" size={11} />
              {appVersion ? <span className="mono">{appVersion}</span> : null}
              {appVersion && gatewayHost ? <span aria-hidden="true" className="opacity-50">·</span> : null}
              {gatewayHost ? <span className="mono truncate" aria-label={t('a11y.shell.gatewayHost')}>{gatewayHost}</span> : null}
            </div>
          )
        : null}
    </div>
  )
}

function MenuRow({ icon: Icon, label, onClick, danger, right }: {
  icon: LucideIcon
  label: React.ReactNode
  onClick?: () => void
  danger?: boolean
  right?: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'focus-ring flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left text-[13px] transition hover:bg-accent',
        danger && 'text-destructive',
      )}
    >
      <Icon aria-hidden="true" size={14} className="opacity-80" />
      <span className="flex-1">{label}</span>
      {right}
    </button>
  )
}

function SubmenuRow({ label, current, children }: {
  label: string
  current: string
  children: React.ReactNode
}) {
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger
        aria-label={`${label}: ${current}`}
        className={cn(
          'focus-ring flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-left text-[13px] transition hover:bg-accent',
          'data-popup-open:bg-accent',
        )}
      >
        <span className="flex-1">{label}</span>
        <span aria-hidden="true" className="truncate text-[11.5px] text-muted-foreground">{current}</span>
        <ChevronRight aria-hidden="true" size={13} className="opacity-70" />
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          align="start"
          side="right"
          sideOffset={8}
          className="z-[70] outline-none"
        >
          <MenuPrimitive.Popup
            data-user-menu-submenu
            aria-label={label}
            className={cn(
              'min-w-[180px] rounded-md border border-border bg-popover p-1 text-popover-foreground outline-none',
              'shadow-[0_8px_24px_rgba(0,0,0,0.18)]',
              'origin-(--transform-origin)',
              'transition duration-150 ease-out data-ending-style:opacity-0 data-ending-style:scale-[0.97] data-starting-style:opacity-0 data-starting-style:scale-[0.97]',
            )}
          >
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  )
}

function SubmenuItem({ icon: Icon, active, onClick, children }: {
  icon?: LucideIcon
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <MenuPrimitive.Item
      onClick={onClick}
      aria-checked={active}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded px-2.5 py-2 text-left text-[13px] outline-none transition',
        'data-highlighted:bg-accent data-highlighted:text-accent-foreground',
      )}
    >
      {Icon ? <Icon aria-hidden="true" size={13} className="opacity-80" /> : null}
      <span className="flex-1">{children}</span>
      {active ? <Check aria-hidden="true" size={13} className="opacity-80" /> : null}
    </MenuPrimitive.Item>
  )
}
