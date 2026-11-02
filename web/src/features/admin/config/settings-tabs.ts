export const SETTINGS_TABS = ['general', 'sessions', 'ssh', 'tls', 'update', 'security', 'about'] as const
export type SettingsTab = typeof SETTINGS_TABS[number]
