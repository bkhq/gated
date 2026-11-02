import type { Timezone, UserIdentity } from '@/store/app-store'

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AuthRequestsContent } from '@/features/auth/auth-requests-page'
import { PageHeader } from '@/shared/components/page-header'
import { StatusDot } from '@/shared/components/status-dot'
import { useIsAdmin } from '@/shared/hooks/use-info'

import { SUPPORTED_LANGS } from '@/shared/lib/languages'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { Select } from '@/shared/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'
import { useAppStore } from '@/store/app-store'
import { ApiTokensTab } from './profile-api-tokens-tab'
import { AuthTab } from './profile-auth-tab'
import { FieldGroup } from './profile-shared'
import { TicketsTab } from './profile-tickets-tab'

type Tab = 'info' | 'auth' | 'apiTokens' | 'tickets' | 'authRequests'

const TIMEZONE_OPTIONS: { value: Timezone, label: string }[] = [
  { value: 'Asia/Shanghai', label: 'Asia/Shanghai · UTC+08:00' },
  { value: 'UTC', label: 'UTC' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles · UTC−07:00' },
  { value: 'America/New_York', label: 'America/New_York · UTC−04:00' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin · UTC+02:00' },
]

export function ProfilePage() {
  const { t } = useTranslation()
  const identity = useAppStore(state => state.identity)
  const [tab, setTab] = React.useState<Tab>('info')

  return (
    <>
      <PageHeader
        title={t('nav.profile')}
        description={t('profile.description')}
      />

      <div className="flex flex-col gap-4 px-6 pb-6 pt-4">
        <ProfileHeaderCard identity={identity} />

        <Tabs value={tab} onChange={next => setTab(next as Tab)}>
          <TabsList>
            <TabsTrigger value="info">{t('profile.tabs.info')}</TabsTrigger>
            <TabsTrigger value="auth">{t('profile.tabs.auth')}</TabsTrigger>
            <TabsTrigger value="apiTokens">{t('profile.tabs.apiTokens')}</TabsTrigger>
            <TabsTrigger value="tickets">{t('profile.tabs.tickets')}</TabsTrigger>
            <TabsTrigger value="authRequests">{t('profile.tabs.authRequests')}</TabsTrigger>
          </TabsList>

          <TabsContent value="info">
            <InfoTab />
          </TabsContent>
          <TabsContent value="auth">
            <AuthTab />
          </TabsContent>
          <TabsContent value="apiTokens">
            <ApiTokensTab />
          </TabsContent>
          <TabsContent value="tickets">
            <TicketsTab />
          </TabsContent>
          <TabsContent value="authRequests">
            <AuthRequestsContent />
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}

function ProfileHeaderCard({ identity }: { identity: UserIdentity }) {
  const { t } = useTranslation()
  const isAdmin = useIsAdmin()
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-4 p-5">
        <Avatar name={identity.name} size={56} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 text-[18px] font-semibold">{identity.name}</h2>
            <Badge tone={isAdmin ? 'info' : 'mono'}>{identity.role}</Badge>
            {isAdmin ? <Badge tone="warning">admin</Badge> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-[12.5px] text-muted-foreground">
            <span className="mono">{identity.username}</span>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1">
              <StatusDot tone="success" />
              <span>{t('profile.header.activeNow')}</span>
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ===========================================================================
// InfoTab
// ===========================================================================

function InfoTab() {
  const { t, i18n } = useTranslation()
  const identity = useAppStore(state => state.identity)
  const updateIdentity = useAppStore(state => state.updateIdentity)
  const lang = useAppStore(state => state.lang)
  const setLang = useAppStore(state => state.setLang)
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>{t('profile.info.identity')}</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          <FieldGroup label={t('profile.info.displayName')} htmlFor="profile-name">
            <Input id="profile-name" value={identity.name} readOnly />
          </FieldGroup>
          <FieldGroup label={t('profile.info.username')} htmlFor="profile-username">
            <Input id="profile-username" value={identity.username} readOnly />
          </FieldGroup>
          <FieldGroup label={t('profile.info.role')} htmlFor="profile-role">
            <Input id="profile-role" value={identity.role} readOnly />
          </FieldGroup>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t('profile.info.preferences')}</CardTitle>
            <CardDescription>{t('profile.info.localPreferencesHint')}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4">
          <FieldGroup label={t('profile.info.language')} htmlFor="profile-language">
            <Select
              id="profile-language"
              value={lang}
              onValueChange={(value) => {
                setLang(value as 'zh-CN' | 'en')
                void i18n.changeLanguage(value)
              }}
              options={SUPPORTED_LANGS.map(item => ({ value: item.code, label: item.label }))}
            />
          </FieldGroup>
          <FieldGroup label={t('profile.info.timezone')} htmlFor="profile-timezone">
            <Select id="profile-timezone" value={identity.timezone} onValueChange={value => updateIdentity({ timezone: value as Timezone })} options={TIMEZONE_OPTIONS} />
          </FieldGroup>
        </CardContent>
      </Card>
    </div>
  )
}

// ===========================================================================
// AuthTab
// ===========================================================================
