import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'

export interface BreadcrumbItem {
  label: string
  to?: string
}

export function PageHeader({ title, description, actions, breadcrumbs, tabs }: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  breadcrumbs?: BreadcrumbItem[]
  tabs?: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <header className="flex flex-col gap-3 px-6 pt-5">
      {breadcrumbs && breadcrumbs.length > 0
        ? (
            <nav className="flex flex-wrap items-center gap-1 text-[12px] text-muted-foreground" aria-label={t('a11y.components.breadcrumb')}>
              {breadcrumbs.map((crumb, index) => (
                <React.Fragment key={`${crumb.label}-${String(index)}`}>
                  {index > 0
                    ? <ChevronRight size={12} className="text-muted-foreground/60" aria-hidden="true" />
                    : null}
                  {crumb.to
                    ? (
                        <Link to={crumb.to} className="rounded-sm transition-colors duration-100 ease-out hover:text-foreground">
                          {crumb.label}
                        </Link>
                      )
                    : <span className={index === breadcrumbs.length - 1 ? 'text-foreground' : ''} aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}>{crumb.label}</span>}
                </React.Fragment>
              ))}
            </nav>
          )
        : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {typeof title === 'string'
            ? <h1 className="m-0 text-[24px] font-semibold tracking-normal">{title}</h1>
            : <h1 className="m-0 flex flex-wrap items-center gap-3 text-[24px] font-semibold">{title}</h1>}
          {description
            ? typeof description === 'string'
              ? <p className="mt-1 text-sm text-muted-foreground">{description}</p>
              : <div className="mt-1 text-sm text-muted-foreground">{description}</div>
            : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {tabs}
    </header>
  )
}
