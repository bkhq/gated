import { Link, useParams } from '@tanstack/react-router'
import { Database } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SqlConsolePage } from '@/features/sql-console/sql-console-page'
import { useTargets } from '@/features/targets/hooks/use-targets-queries'
import { EmptyState } from '@/shared/components/empty-state'

export function SqlConsoleRoute() {
  const { t } = useTranslation()
  const { targetName } = useParams({ from: '/db/$targetName' })
  const targetsQuery = useTargets()

  if (targetsQuery.isLoading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="p-6 text-sm text-muted-foreground"
      >
        {t('sqlConsole.route.loading')}
      </div>
    )
  }

  const target = targetsQuery.data?.find(item => item.name === targetName)

  if (!target) {
    return (
      <div className="p-10">
        <EmptyState
          icon={Database}
          title={t('sqlConsole.route.notFoundTitle')}
          description={t('sqlConsole.route.notFoundDescription', { target: targetName })}
          action={(
            <Link to="/targets" className="text-[13px] font-medium text-primary hover:underline">
              {t('sqlConsole.route.backToTargets')}
            </Link>
          )}
        />
      </div>
    )
  }

  if (target.kind !== 'mysql' && target.kind !== 'postgres') {
    return (
      <div className="p-10">
        <EmptyState
          icon={Database}
          title={t('sqlConsole.route.unsupportedTitle')}
          description={t('sqlConsole.route.unsupportedDescription', { kind: target.kind })}
          action={(
            <Link to="/targets" className="text-[13px] font-medium text-primary hover:underline">
              {t('sqlConsole.route.backToTargets')}
            </Link>
          )}
        />
      </div>
    )
  }

  return <SqlConsolePage targetName={target.name} />
}
