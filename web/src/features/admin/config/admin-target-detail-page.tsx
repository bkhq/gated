import type { TerminalKind } from '@/features/terminal/codec'
import type { LiveSession, Target } from '@/shared/types/domain'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { usePastSessions } from '@/features/sessions/hooks/use-sessions-queries'
import { DeleteTargetDialog, TargetDetailHeader, TargetDetailTabsBody, TargetFormDrawer, useTargetDetailTabs } from '@/features/targets/components'
import { useTarget } from '@/features/targets/hooks/use-targets-queries'
import { EmptyState } from '@/shared/components/empty-state'
import { useAppStore } from '@/store/app-store'

const route = getRouteApi('/admin/targets/$targetId')

export function AdminTargetDetailPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { targetId } = route.useParams()
  const targetQuery = useTarget(targetId)
  const past = usePastSessions().data ?? []
  const openTerminalTab = useAppStore(state => state.openTerminalTab)
  const [editOpen, setEditOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  const target = targetQuery.data
  const relatedSessions: LiveSession[] = target ? past.filter(session => session.target === target.name) : []
  const tabs = useTargetDetailTabs(relatedSessions.length)

  const goBack = () => {
    void navigate({ to: '/admin/targets' })
  }

  const handleOpenSqlConsole = (item: Target) => {
    openTerminalTab({ type: 'sql', kind: item.kind as TerminalKind, targetId: item.id, targetName: item.name })
    void navigate({ to: '/sessions' })
  }

  if (targetQuery.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">{t('targets.detail.loading')}</div>
  }
  if (!target) {
    return (
      <div className="p-10">
        <EmptyState title={t('targets.detail.notFoundTitle')} description={t('targets.detail.notFoundDescription')} />
      </div>
    )
  }

  return (
    <>
      <TargetDetailHeader
        target={target}
        mode="admin"
        breadcrumbs={[
          { label: t('section.admin') },
          { label: t('nav.adminTargets'), to: '/admin/targets' },
          { label: target.name },
        ]}
        tabs={tabs.list}
        onEdit={() => setEditOpen(true)}
        onDelete={() => setDeleteOpen(true)}
        onOpenSqlConsole={handleOpenSqlConsole}
      />
      <div className="px-6 pb-6 pt-4">
        <TargetDetailTabsBody
          target={target}
          mode="admin"
          mySessions={relatedSessions}
          tabsValue={tabs.value}
          onTabsChange={tabs.onChange}
        />
      </div>

      <TargetFormDrawer
        open={editOpen}
        mode="edit"
        target={target}
        onClose={() => setEditOpen(false)}
        onDeleted={goBack}
        onSaved={() => setEditOpen(false)}
      />
      <DeleteTargetDialog
        target={deleteOpen ? target : null}
        onClose={() => setDeleteOpen(false)}
        onDeleted={goBack}
      />
    </>
  )
}
