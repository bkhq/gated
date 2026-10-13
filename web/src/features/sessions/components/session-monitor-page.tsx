import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { Radio } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { LiveCastPlayer } from '@/features/recordings/components/terminal-player'
import { useSessionMonitorStream } from '@/features/sessions/hooks/use-session-monitor-stream'
import { useSession } from '@/features/sessions/hooks/use-sessions-queries'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'

const monitorRoute = getRouteApi('/admin/sessions/$sessionId/monitor')

export function SessionMonitorPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { sessionId } = monitorRoute.useParams()
  const sessionQuery = useSession(sessionId)
  const session = sessionQuery.data
  const stream = useSessionMonitorStream(sessionId, true)

  const goBack = React.useCallback(() => {
    void navigate({ to: '/admin/sessions' })
  }, [navigate])

  // The server sends `{ end }` immediately when the session isn't live (ended,
  // never recorded, or unknown). Treat "ended before it ever started" as
  // not-live rather than leaving a spinner up forever.
  const notLive = stream.ended && !stream.started

  return (
    <>
      <PageHeader
        title={(
          <>
            <Radio size={20} aria-hidden="true" className="text-[hsl(var(--info))]" />
            <span className="mono">{sessionId}</span>
            <Badge tone="info">{t('monitor.live.readOnly')}</Badge>
          </>
        )}
        description={session ? t('monitor.live.description', { user: session.user, target: session.target }) : undefined}
        breadcrumbs={[
          { label: t('section.admin') },
          { label: t('nav.adminSessions'), to: '/admin/sessions' },
          { label: t('monitor.live.breadcrumb') },
        ]}
        actions={(
          <Button variant="outline" size="sm" onClick={goBack}>
            {t('actions.back')}
          </Button>
        )}
      />
      <div className="p-6">
        {notLive
          ? (
              <EmptyState
                icon={Radio}
                title={t('monitor.live.notLiveTitle')}
                description={t('monitor.live.notLiveDescription')}
                action={(
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { void navigate({ to: '/admin/sessions/$sessionId', params: { sessionId } }) }}
                  >
                    {t('monitor.sessions.actions.viewDetail')}
                  </Button>
                )}
              />
            )
          : (
              <LiveCastPlayer
                streamKey={sessionId}
                started={stream.started}
                frames={stream.frames}
                lastError={stream.lastError}
              />
            )}
      </div>
    </>
  )
}
