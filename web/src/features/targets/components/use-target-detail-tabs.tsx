import type { Target } from '@/shared/types/domain'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsList, TabsTrigger } from '@/shared/ui/tabs'

export type TargetTab = 'overview' | 'sessions' | 'security' | 'permissions'

export interface TargetDetailTabsControl {
  value: TargetTab
  onChange: (next: TargetTab) => void
  list: React.ReactNode
}

// Security holds SSH host keys, the HTTP upstream certificate or the database
// TLS settings — admin data, so users only get it for SSH (a short note).
export function useTargetDetailTabs(sessionCount: number, target: Target | undefined, mode: 'user' | 'admin'): TargetDetailTabsControl {
  const { t } = useTranslation()
  const [value, setValue] = React.useState<TargetTab>('overview')
  const list = (
    <Tabs value={value} onChange={next => setValue(next as TargetTab)}>
      <TabsList>
        <TabsTrigger value="overview">{t('targets.detail.tabs.overview')}</TabsTrigger>
        <TabsTrigger value="sessions">
          {t('targets.detail.tabs.sessions')}
          {' · '}
          {sessionCount}
        </TabsTrigger>
        {target && (mode === 'admin' || target.kind === 'ssh')
          ? <TabsTrigger value="security">{t('targets.detail.tabs.security')}</TabsTrigger>
          : null}
        <TabsTrigger value="permissions">{t('targets.detail.tabs.permissions')}</TabsTrigger>
      </TabsList>
    </Tabs>
  )
  return { value, onChange: setValue, list }
}
