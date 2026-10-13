import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsList, TabsTrigger } from '@/shared/ui/tabs'

export type TargetTab = 'overview' | 'sessions' | 'security' | 'permissions'

export interface TargetDetailTabsControl {
  value: TargetTab
  onChange: (next: TargetTab) => void
  list: React.ReactNode
}

export function useTargetDetailTabs(sessionCount: number): TargetDetailTabsControl {
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
        <TabsTrigger value="security">{t('targets.detail.tabs.security')}</TabsTrigger>
        <TabsTrigger value="permissions">{t('targets.detail.tabs.permissions')}</TabsTrigger>
      </TabsList>
    </Tabs>
  )
  return { value, onChange: setValue, list }
}
