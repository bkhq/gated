import type { TerminalKind } from '@/features/terminal/codec'
import type { LoginRequest } from '@/shared/lib/api/auth'
import { create } from 'zustand'
import { login as apiLogin, logout as apiLogout } from '@/shared/lib/api/auth'

export type ThemeMode = 'light' | 'dark' | 'system'
export type Density = 'default' | 'compact'
export type Lang = 'zh-CN' | 'en'

export type Timezone = 'Asia/Shanghai' | 'UTC' | 'America/Los_Angeles' | 'America/New_York' | 'Europe/Berlin'

export interface UserIdentity {
  name: string
  username: string
  email: string
  role: string
  timezone: Timezone
}

export interface TerminalTab {
  id: string
  type: 'terminal' | 'sql' | 'files'
  kind: TerminalKind
  targetId: string
  targetName: string
}

export interface AppState {
  theme: ThemeMode
  density: Density
  sidebarCollapsed: boolean
  lang: Lang
  identity: UserIdentity
  spotlightOpen: boolean
  userMenuOpen: boolean
  terminalFullscreen: boolean
  // Open terminal workspace tabs. Kept here (not in the page) so other pages
  // can open a connection and tabs survive leaving the workspace route.
  terminalTabs: TerminalTab[]
  activeTerminalTabId: string | null
  setTheme: (theme: ThemeMode) => void
  toggleTheme: () => void
  setLang: (lang: Lang) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setSpotlightOpen: (open: boolean) => void
  setUserMenuOpen: (open: boolean) => void
  setTerminalFullscreen: (open: boolean) => void
  openTerminalTab: (tab: Omit<TerminalTab, 'id'>) => void
  closeTerminalTab: (id: string) => void
  setActiveTerminalTab: (id: string) => void
  updateIdentity: (patch: Partial<UserIdentity>) => void
  // Escape-hatch auth actions for non-React callers (e.g. the 401 callback).
  // React components / hooks should prefer useLogin() / useLogout() from
  // @/shared/hooks/use-auth so cache invalidation and navigation are wired.
  signIn: (req: LoginRequest) => Promise<void>
  signOut: () => Promise<void>
}

let terminalTabSeq = 0

export const useAppStore = create<AppState>((set, get) => ({
  theme: 'system',
  density: 'default',
  sidebarCollapsed: false,
  lang: 'zh-CN',
  spotlightOpen: false,
  userMenuOpen: false,
  terminalFullscreen: false,
  terminalTabs: [],
  activeTerminalTabId: null,
  identity: {
    name: '',
    username: '',
    email: '',
    role: '',
    timezone: 'Asia/Shanghai',
  },
  setTheme: theme => set({ theme }),
  toggleTheme: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' }),
  setLang: lang => set({ lang }),
  setSidebarCollapsed: sidebarCollapsed => set({ sidebarCollapsed }),
  setSpotlightOpen: spotlightOpen => set({ spotlightOpen }),
  setUserMenuOpen: userMenuOpen => set({ userMenuOpen }),
  setTerminalFullscreen: terminalFullscreen => set({ terminalFullscreen }),
  // A target has at most one SQL console and one file manager tab; terminals
  // always open a new session.
  openTerminalTab: (tab) => {
    const existing = tab.type !== 'terminal'
      ? get().terminalTabs.find(item => item.type === tab.type && item.targetName === tab.targetName)
      : undefined
    if (existing) {
      set({ activeTerminalTabId: existing.id })
      return
    }
    terminalTabSeq += 1
    const id = `tab-${terminalTabSeq}-${tab.targetName}`
    set(state => ({ terminalTabs: [...state.terminalTabs, { ...tab, id }], activeTerminalTabId: id }))
  },
  closeTerminalTab: id => set((state) => {
    const terminalTabs = state.terminalTabs.filter(tab => tab.id !== id)
    const activeTerminalTabId = state.activeTerminalTabId === id
      ? terminalTabs[terminalTabs.length - 1]?.id ?? null
      : state.activeTerminalTabId
    return { terminalTabs, activeTerminalTabId }
  }),
  setActiveTerminalTab: activeTerminalTabId => set({ activeTerminalTabId }),
  updateIdentity: patch => set(state => ({ identity: { ...state.identity, ...patch } })),
  signIn: async (req: LoginRequest) => { await apiLogin(req) },
  signOut: async () => { await apiLogout() },
}))
