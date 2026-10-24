export const SETTINGS_TABS = ['general', 'sessions', 'ssh', 'update', 'security', 'about'] as const
export type SettingsTab = typeof SETTINGS_TABS[number]
