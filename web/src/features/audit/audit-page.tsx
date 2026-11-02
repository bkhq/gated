import { getRouteApi } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { AdminAuditPage } from '@/features/admin/monitor/admin-audit-page'
import { CommandRecordsPage } from '@/features/command-records/command-records-page'
import { FileRecordsPage } from '@/features/file-records/file-records-page'
import { PageHeader } from '@/shared/components/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'

const AUDIT_TABS = ['log', 'commands', 'files'] as const
export type AuditTab = (typeof AUDIT_TABS)[number]

// `tab` stays optional so plain links to /admin/audit need no search params.
// eslint-disable-next-line react-refresh/only-export-components -- route search validator shared with the route file
export function validateAuditSearch(search: Record<string, unknown>): { tab?: AuditTab } {
  return { tab: AUDIT_TABS.find(value => value === search.tab) }
}

const route = getRouteApi('/admin/audit')

export function AuditPage() {
  const { t } = useTranslation()
  const tab = route.useSearch().tab ?? 'log'
  const navigate = route.useNavigate()

  return (
    <Tabs
      value={tab}
      onChange={next => void navigate({ search: validateAuditSearch({ tab: next }), replace: true })}
      className="gap-0 self-stretch"
    >
      <PageHeader
        title={t('nav.adminAudit')}
        description={t('audit.pageDescription')}
        breadcrumbs={[{ label: t('section.admin') }, { label: t('nav.adminAudit') }]}
        tabs={(
          <TabsList className="self-start">
            {AUDIT_TABS.map(value => (
              <TabsTrigger key={value} value={value}>{t(`audit.tabs.${value}`)}</TabsTrigger>
            ))}
          </TabsList>
        )}
      />
      <TabsContent value="log"><AdminAuditPage embedded /></TabsContent>
      <TabsContent value="commands"><CommandRecordsPage embedded /></TabsContent>
      <TabsContent value="files"><FileRecordsPage embedded /></TabsContent>
    </Tabs>
  )
}
