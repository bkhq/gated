import type { AccountFormMode } from '@/features/accounts/components'
import type { Account, AccountKind } from '@/shared/types/domain'
import { Activity, Eye, FileText, Key, Lock, Pencil, Plus, RefreshCw, Search, ShieldCheck, Trash2, User as UserIcon } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AccountFormDialog, DeleteAccountDialog } from '@/features/accounts/components'
import { useAccounts } from '@/features/accounts/hooks/use-accounts-queries'
import { formatDateTime, isRotationDue, isUsedToday } from '@/features/accounts/utils'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { RowActionsMenu } from '@/shared/components/row-actions-menu'
import { StatCard } from '@/shared/components/stat-card'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Select } from '@/shared/ui/select'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

const KIND_VALUES = ['all', 'ssh-password', 'ssh-key', 'db-password', 'k8s-token', 'k8s-client-cert', 'http-headers'] as const

type KindFilter = (typeof KIND_VALUES)[number]

interface DrawerState {
  mode: AccountFormMode
  account: Account | null
}

export function AdminAccountsPage() {
  const { t, i18n } = useTranslation()
  const accountsQuery = useAccounts()
  const accountsData = accountsQuery.data
  const accounts = React.useMemo(() => accountsData ?? [], [accountsData])
  const [drawer, setDrawer] = React.useState<DrawerState | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<Account | null>(null)
  const [kindFilter, setKindFilter] = React.useState<KindFilter>('all')
  const [query, setQuery] = React.useState('')

  const filtered = React.useMemo(() => {
    return accounts.filter((account) => {
      if (kindFilter !== 'all' && account.kind !== kindFilter) {
        return false
      }
      if (query) {
        const haystack = `${account.name} ${account.description}`.toLowerCase()
        if (!haystack.includes(query.toLowerCase())) {
          return false
        }
      }
      return true
    })
  }, [accounts, kindFilter, query])

  const stats = [
    { label: t('accounts.stats.total'), value: String(accounts.length), icon: UserIcon },
    { label: t('accounts.stats.rotationDue'), value: String(accounts.filter(a => isRotationDue(a)).length), icon: RefreshCw, hint: t('accounts.stats.rotationHint') },
    { label: t('accounts.stats.usedToday'), value: String(accounts.filter(a => isUsedToday(a)).length), icon: Activity },
  ]

  const kindOptions = React.useMemo(
    () => KIND_VALUES.map(value => ({
      value,
      label: value === 'all' ? t('accounts.filter.allProtocols') : t(`accounts.credLabels.${value}`),
    })),
    [t],
  )

  const credIcon = (kind: AccountKind) => {
    if (kind === 'ssh-key' || kind === 'k8s-token') {
      return <Key size={12} />
    }
    if (kind === 'ssh-password' || kind === 'db-password') {
      return <Lock size={12} />
    }
    if (kind === 'k8s-client-cert') {
      return <ShieldCheck size={12} />
    }
    return <FileText size={12} />
  }

  return (
    <>
      <PageHeader
        title={t('nav.adminAccounts')}
        description={t('accounts.description')}
        breadcrumbs={[
          { label: t('section.admin') },
          { label: t('nav.adminAccounts') },
        ]}
        actions={(
          <Button size="sm" onClick={() => setDrawer({ mode: 'create', account: null })}>
            <Plus size={13} />
            <span>{t('accounts.actions.newAccount')}</span>
          </Button>
        )}
      />

      <div className="grid gap-3 px-6 pt-4 lg:grid-cols-3">
        {stats.map(stat => (
          <StatCard key={stat.label} label={stat.label} value={stat.value} icon={stat.icon} hint={stat.hint} />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-4">
        <div className="w-[320px]">
          <Input
            icon={Search}
            placeholder={t('accounts.searchPlaceholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            aria-label={t('actions.search')}
          />
        </div>
        <Select
          className="w-[160px]"
          value={kindFilter}
          onValueChange={value => setKindFilter(value as KindFilter)}
          aria-label={t('fields.protocol')}
          options={kindOptions}
        />
        <span className="flex-1" />
        <span className="text-[12px] text-muted-foreground">
          {filtered.length}
          {' / '}
          {accounts.length}
        </span>
      </div>

      <div className="px-6 pb-6">
        <Table>
          <THead>
            <TR>
              <TH className="pl-5">{t('fields.name')}</TH>
              <TH>{t('accounts.fields.credential')}</TH>
              <TH>{t('accounts.fields.boundTargets')}</TH>
              <TH>{t('fields.lastUsed')}</TH>
              <TH className="pr-5 text-right" aria-label={t('fields.actions')} />
            </TR>
          </THead>
          <TBody>
            {filtered.length === 0 && !accountsQuery.isLoading
              ? (
                  <TR>
                    <TD colSpan={5} className="p-6">
                      <EmptyState
                        icon={UserIcon}
                        title={accounts.length === 0 ? t('accounts.empty.title') : t('accounts.empty.noMatch')}
                        description={accounts.length === 0 ? t('accounts.empty.description') : undefined}
                        action={accounts.length === 0
                          ? (
                              <Button size="sm" onClick={() => setDrawer({ mode: 'create', account: null })}>
                                <Plus size={13} />
                                <span>{t('accounts.actions.newAccount')}</span>
                              </Button>
                            )
                          : undefined}
                      />
                    </TD>
                  </TR>
                )
              : null}
            {filtered.map(account => (
              <TR key={account.id} className="cursor-pointer" onClick={() => setDrawer({ mode: 'view', account })}>
                <TD className="pl-5">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary text-foreground">
                      <UserIcon size={15} />
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="mono text-[13.5px] font-semibold">{account.name}</span>
                        {isRotationDue(account) ? <Badge tone="warning">{t('accounts.view.rotationDue')}</Badge> : null}
                      </div>
                      <div className="text-[12px] text-muted-foreground">{account.description}</div>
                    </div>
                  </div>
                </TD>
                <TD>
                  <span className="inline-flex items-center gap-1.5">
                    {credIcon(account.kind)}
                    <span>{t(`accounts.credLabels.${account.kind}`)}</span>
                  </span>
                </TD>
                <TD className="mono">{account.referenceCount}</TD>
                <TD className="text-muted-foreground">{formatDateTime(account.lastUsed, i18n.language)}</TD>
                <TD className="pr-5 text-right" onClick={event => event.stopPropagation()}>
                  <RowActionsMenu
                    items={[
                      { label: t('actions.view'), icon: Eye, onClick: () => setDrawer({ mode: 'view', account }) },
                      { label: t('actions.edit'), icon: Pencil, onClick: () => setDrawer({ mode: 'edit', account }) },
                      'separator' as const,
                      { label: t('actions.delete'), icon: Trash2, danger: true, onClick: () => setPendingDelete(account) },
                    ]}
                  />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>

      <AccountFormDialog
        open={drawer !== null}
        mode={drawer?.mode ?? 'create'}
        account={drawer?.account ?? null}
        onClose={() => setDrawer(null)}
      />

      <DeleteAccountDialog
        account={pendingDelete}
        onClose={() => setPendingDelete(null)}
        onOpenInstead={(account) => {
          setPendingDelete(null)
          setDrawer({ mode: 'view', account })
        }}
      />
    </>
  )
}
