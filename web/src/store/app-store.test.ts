import type { TerminalTab } from './app-store'
import { beforeEach, expect, it } from 'vitest'
import { useAppStore } from './app-store'

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState())
})

it('opens a terminal tab and activates it', () => {
  useAppStore.getState().openTerminalTab({ type: 'terminal', kind: 'ssh', targetId: 't1', targetName: 'web-01' })
  useAppStore.getState().openTerminalTab({ type: 'terminal', kind: 'mysql', targetId: 't2', targetName: 'db-01' })
  const { terminalTabs, activeTerminalTabId } = useAppStore.getState()
  expect(terminalTabs.map(tab => tab.targetName)).toEqual(['web-01', 'db-01'])
  expect(new Set(terminalTabs.map(tab => tab.id)).size).toBe(2)
  expect(activeTerminalTabId).toBe(terminalTabs[1]?.id)
})

it('opens a separate tab for each connection to the same target', () => {
  const store = useAppStore.getState()
  store.openTerminalTab({ type: 'terminal', kind: 'ssh', targetId: 't1', targetName: 'web-01' })
  store.openTerminalTab({ type: 'terminal', kind: 'ssh', targetId: 't1', targetName: 'web-01' })
  expect(useAppStore.getState().terminalTabs).toHaveLength(2)
})

it('closing the active tab activates the last remaining tab', () => {
  const store = useAppStore.getState()
  store.openTerminalTab({ type: 'terminal', kind: 'ssh', targetId: 't1', targetName: 'a' })
  store.openTerminalTab({ type: 'terminal', kind: 'ssh', targetId: 't2', targetName: 'b' })
  store.openTerminalTab({ type: 'terminal', kind: 'ssh', targetId: 't3', targetName: 'c' })
  const [a, b, c] = useAppStore.getState().terminalTabs as [TerminalTab, TerminalTab, TerminalTab]
  store.setActiveTerminalTab(b.id)
  store.closeTerminalTab(b.id)
  expect(useAppStore.getState().terminalTabs.map(tab => tab.id)).toEqual([a.id, c.id])
  expect(useAppStore.getState().activeTerminalTabId).toBe(c.id)
  store.closeTerminalTab(a.id)
  expect(useAppStore.getState().activeTerminalTabId).toBe(c.id)
  store.closeTerminalTab(c.id)
  expect(useAppStore.getState().terminalTabs).toEqual([])
  expect(useAppStore.getState().activeTerminalTabId).toBeNull()
})

it('reuses an open SQL console tab for the same target', () => {
  const store = useAppStore.getState()
  store.openTerminalTab({ type: 'sql', kind: 'mysql', targetId: 't2', targetName: 'db-01' })
  store.openTerminalTab({ type: 'terminal', kind: 'mysql', targetId: 't2', targetName: 'db-01' })
  const [sql] = useAppStore.getState().terminalTabs as [TerminalTab]
  store.openTerminalTab({ type: 'sql', kind: 'mysql', targetId: 't2', targetName: 'db-01' })
  const { terminalTabs, activeTerminalTabId } = useAppStore.getState()
  expect(terminalTabs.map(tab => tab.type)).toEqual(['sql', 'terminal'])
  expect(activeTerminalTabId).toBe(sql.id)
  store.openTerminalTab({ type: 'sql', kind: 'postgres', targetId: 't3', targetName: 'pg-01' })
  expect(useAppStore.getState().terminalTabs).toHaveLength(3)
})
