import { Link, useMatches } from 'react-router'
import { useTranslation } from 'react-i18next'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/shared/components/ui/breadcrumb'

interface BreadcrumbHandle {
  breadcrumbKey: string
}

export function AppBreadcrumb() {
  const { t } = useTranslation()
  const matches = useMatches()

  const crumbs = matches
    .filter(m => (m.handle as BreadcrumbHandle | undefined)?.breadcrumbKey)
    .map(m => ({
      key: (m.handle as BreadcrumbHandle).breadcrumbKey,
      params: m.params as Record<string, string>,
      pathname: m.pathname,
    }))

  if (crumbs.length === 0) return null

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, i) => (
          <span key={crumb.pathname} className="flex items-center gap-1.5">
            {i > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {i === crumbs.length - 1 ? (
                <BreadcrumbPage>{t(crumb.key, crumb.params)}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link to={crumb.pathname}>{t(crumb.key, crumb.params)}</Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </span>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
