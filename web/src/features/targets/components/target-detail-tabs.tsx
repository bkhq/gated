import type { TargetTab } from './use-target-detail-tabs'
import type { Info } from '@/shared/lib/api/info'
import type { LiveSession, Target } from '@/shared/types/domain'
import { useQuery } from '@tanstack/react-query'
import { Copy, ExternalLink, Eye, Inbox, Key, KeyRound, Play, ShieldCheck } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useCreateApiToken } from '@/features/api-tokens/hooks/use-api-tokens-queries'
import { useTargetRoles } from '@/features/targets/hooks/use-targets-queries'
import { buildBrowserUrl, buildConnectCommand } from '@/features/targets/lib/connect-command'
import { targetGroupLabel } from '@/features/targets/lib/target-group'
import { EmptyState } from '@/shared/components/empty-state'
import { useInfo } from '@/shared/hooks/use-info'
import { getTargetKnownSshHostKeys } from '@/shared/lib/api/targets'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'
import { Tabs, TabsContent } from '@/shared/ui/tabs'

// Test-token control for HTTP targets (controlled by the parent). Pasting a
// token here both inlines it into the curl command above and enables the
// "Open in browser" button, which navigates to a `?gated-token=` URL the proxy
// accepts (gated-protocol-http authenticate_request) — a plain navigation
// can't set an Authorization header. The token lives only in parent state and
// never leaves the page except in the URL the user opens.
function HttpAccess({ target, info, token, onToken }: {
  target: Target
  info: Info | undefined
  token: string
  onToken: (next: string) => void
}) {
  const { t } = useTranslation()
  const createToken = useCreateApiToken()
  const url = buildBrowserUrl(target, info, token.trim())
  // Generate a real API token on demand and inline it into the command/links.
  // It's a normal token (label marks it as console-generated) — revocable from
  // Profile → API tokens. Shown in plaintext so the user can copy it once.
  const generate = async () => {
    if (createToken.isPending)
      return
    const created = await createToken.mutateAsync({ name: `console: ${target.name}`, expiresIn: '90d' })
    onToken(created.fullSecret)
  }
  return (
    <div className="border-t border-border px-5 py-4">
      <div className="mb-1 text-[13px] font-medium">{t('targets.detail.overview.browserOpen.title')}</div>
      <div className="mb-2.5 text-[12px] text-muted-foreground">{t('targets.detail.overview.browserOpen.hint')}</div>
      <div className="flex gap-2">
        <Input
          type="text"
          autoComplete="off"
          value={token}
          onChange={event => onToken(event.target.value)}
          placeholder={t('targets.detail.overview.browserOpen.tokenPlaceholder')}
          aria-label={t('targets.detail.overview.browserOpen.tokenPlaceholder')}
          className="mono flex-1"
        />
        <Button variant="outline" onClick={() => { void generate() }} disabled={createToken.isPending}>
          <KeyRound size={13} />
          <span>{t('targets.detail.overview.browserOpen.generate')}</span>
        </Button>
        <Button
          disabled={!url}
          onClick={() => {
            if (url)
              window.open(url, '_blank', 'noopener,noreferrer')
          }}
        >
          <ExternalLink size={13} />
          <span>{t('targets.detail.overview.browserOpen.button')}</span>
        </Button>
      </div>
    </div>
  )
}

function FieldRow({ label, value }: { label: React.ReactNode, value: React.ReactNode }) {
  return (
    <>
      <div className="self-center text-[12px] text-muted-foreground">{label}</div>
      <div className="self-center">{value}</div>
    </>
  )
}

function PolicyLine({ icon: Icon, label, on, off }: { icon: typeof Eye, label: string, on?: boolean, off?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <div className="flex h-6 w-6 items-center justify-center rounded-md bg-secondary">
        <Icon size={12} />
      </div>
      <span className="flex-1 text-[13.5px]">{label}</span>
      {on
        ? <span className="text-[12px] font-medium text-[hsl(var(--success))]">{t('targets.detail.policy.enabled')}</span>
        : off
          ? <span className="text-[12px] font-medium text-muted-foreground">{t('targets.detail.policy.off')}</span>
          : null}
    </div>
  )
}

function HostKeyRow({ algo, keyBase64 }: { algo: string, keyBase64: string }) {
  const { t } = useTranslation()
  const copy = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(`${algo} ${keyBase64}`).catch(() => {})
    }
  }
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border p-3">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary"><Key size={15} /></div>
      <div className="min-w-0 flex-1">
        <div className="mono text-[13px] font-medium">{algo}</div>
        <div className="mono truncate text-[11px] text-muted-foreground">{keyBase64}</div>
      </div>
      <Button variant="ghost" size="icon-sm" aria-label={t('targets.detail.security.copyFingerprint')} onClick={copy}>
        <Copy size={13} />
      </Button>
    </div>
  )
}

export interface TargetDetailTabsBodyProps {
  target: Target
  mode: 'user' | 'admin'
  mySessions: LiveSession[]
  tabsValue: TargetTab
  onTabsChange: (next: TargetTab) => void
  onOpenSession?: (session: LiveSession) => void
  onReplaySession?: (session: LiveSession) => void
}

export function TargetDetailTabsBody({ target, mode, mySessions, tabsValue, onTabsChange, onOpenSession, onReplaySession }: TargetDetailTabsBodyProps) {
  const { t } = useTranslation()
  const info = useInfo().data
  // HTTP test token: pasted once, inlined into the curl command and used by the
  // "Open in browser" button.
  const [httpToken, setHttpToken] = React.useState('')
  const connectCmd = buildConnectCommand(target, info, httpToken)

  // Real data is admin-only: host keys and role bindings come from
  // /admin/api/targets/:id/… and need the target UUID (user snapshots
  // only carry the name).
  const isAdminView = mode === 'admin'
  const hostKeysQuery = useQuery({
    queryKey: ['targets', target.id, 'known-ssh-host-keys'],
    queryFn: async ({ signal }) => getTargetKnownSshHostKeys(target.id, signal),
    enabled: isAdminView && target.kind === 'ssh',
  })
  const targetRolesQuery = useTargetRoles(isAdminView ? target.id : undefined)

  const handleRowAction = (session: LiveSession) => {
    if (session.state === 'live') {
      onOpenSession?.(session)
    }
    else {
      onReplaySession?.(session)
    }
  }

  return (
    <Tabs value={tabsValue} onChange={next => onTabsChange(next as TargetTab)}>
      <TabsContent value="overview">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle>{t('targets.detail.overview.connection')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-3 text-[13.5px]">
                <FieldRow label={t('targets.detail.overview.targetId')} value={<span className="mono">{target.id}</span>} />
                <FieldRow label={t('fields.protocol')} value={<Badge tone="mono">{target.kind.toUpperCase()}</Badge>} />
                {target.kind === 'http'
                  ? (
                      <FieldRow
                        label={t('targets.form.httpFlavor')}
                        value={(
                          <Badge tone={target.flavor === 'kubernetes' ? 'info' : 'mono'}>
                            {t(target.flavor === 'kubernetes' ? 'targets.form.httpFlavorKubernetes' : 'targets.form.httpFlavorGeneric')}
                          </Badge>
                        )}
                      />
                    )
                  : null}
                {target.kind === 'http'
                  ? <FieldRow label={t('targets.form.httpUrl')} value={<span className="mono">{target.host}</span>} />
                  : (
                      <>
                        <FieldRow label={t('targets.detail.overview.host')} value={<span className="mono">{target.host}</span>} />
                        <FieldRow label="Port" value={<span className="mono">{target.port}</span>} />
                        <FieldRow label={t('targets.detail.overview.defaultUser')} value={<span className="mono">{target.user}</span>} />
                      </>
                    )}
                <FieldRow label={t('targets.detail.overview.group')} value={targetGroupLabel(target, t('targets.ungrouped'))} />
                {target.description
                  ? <FieldRow label={t('fields.description')} value={<span className="text-muted-foreground">{target.description}</span>} />
                  : null}
              </div>
            </CardContent>
            <div className="border-t border-border px-5 py-3">
              <div className="text-[12px] text-muted-foreground">{t('targets.detail.overview.connectHint')}</div>
            </div>
            <div className="px-5 pb-5">
              <pre
                aria-label={t('a11y.targetDetail.connectCommand')}
                className="mono m-0 overflow-x-auto rounded-md bg-[#0e0e10] px-3 py-2.5 text-[12px] text-[#d4d4d8]"
              >
                {connectCmd ?? t('targets.detail.overview.connectUnavailable')}
              </pre>
            </div>
            {target.kind === 'http' && info?.http_proxy_base_domain
              ? <HttpAccess target={target} info={info} token={httpToken} onToken={setHttpToken} />
              : null}
          </Card>

          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>{t('targets.detail.overview.policySummary')}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <PolicyLine icon={Eye} label={t('targets.detail.overview.readOnly')} on={!!target.readonly} off={!target.readonly} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t('targets.detail.overview.notes')}</CardTitle>
              </CardHeader>
              <CardContent className="text-[13.5px] leading-relaxed text-muted-foreground">
                {target.kind === 'mysql' || target.kind === 'postgres'
                  ? t('targets.detail.overview.notesDb')
                  : t('targets.detail.overview.notesGeneric')}
              </CardContent>
            </Card>
          </div>
        </div>
      </TabsContent>

      <TabsContent value="sessions">
        {mySessions.length === 0
          ? (
              <Card>
                <CardContent className="py-10">
                  <EmptyState
                    icon={Inbox}
                    title={t('targets.detail.sessions.empty')}
                    description={t('targets.detail.sessions.emptyDescription')}
                  />
                </CardContent>
              </Card>
            )
          : (
              <Table aria-label={t('a11y.targetDetail.sessions')}>
                <THead>
                  <TR>
                    <TH className="pl-5">{t('targets.detail.sessions.id')}</TH>
                    <TH>{t('fields.protocol')}</TH>
                    <TH>{t('fields.started')}</TH>
                    <TH>{t('fields.duration')}</TH>
                    <TH>{t('fields.status')}</TH>
                    <TH className="pr-5 text-right" />
                  </TR>
                </THead>
                <TBody>
                  {mySessions.map((session) => {
                    const rowLabel = session.state === 'live'
                      ? t('targets.detail.sessions.openSession', { id: session.id })
                      : t('targets.detail.sessions.replaySession', { id: session.id })
                    return (
                      <TR
                        key={session.id}
                        className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 hover:bg-muted/40"
                        tabIndex={0}
                        role="button"
                        aria-label={rowLabel}
                        onClick={() => handleRowAction(session)}
                        onKeyDown={(event: React.KeyboardEvent<HTMLTableRowElement>) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            handleRowAction(session)
                          }
                        }}
                      >
                        <TD className="mono pl-5">{session.id}</TD>
                        <TD className="mono text-muted-foreground">{session.protocol}</TD>
                        <TD className="text-muted-foreground">{session.started}</TD>
                        <TD className="mono">{session.duration}</TD>
                        <TD>
                          {session.state === 'live'
                            ? (
                                <Badge tone="info">
                                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--info))]" />
                                  <span>{t('status.live')}</span>
                                </Badge>
                              )
                            : <Badge tone="mono">{t('status.closed')}</Badge>}
                        </TD>
                        <TD className="pr-5 text-right">
                          {session.state === 'live'
                            ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                                    event.stopPropagation()
                                    onOpenSession?.(session)
                                  }}
                                >
                                  <Eye size={12} />
                                  <span>{t('targets.detail.sessions.view')}</span>
                                </Button>
                              )
                            : (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  aria-label={t('targets.detail.sessions.replay')}
                                  onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                                    event.stopPropagation()
                                    onReplaySession?.(session)
                                  }}
                                >
                                  <Play size={14} />
                                </Button>
                              )}
                        </TD>
                      </TR>
                    )
                  })}
                </TBody>
              </Table>
            )}
      </TabsContent>

      <TabsContent value="security">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>{t('targets.detail.security.title')}</CardTitle>
              <CardDescription>{t('targets.detail.security.description')}</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2">
              {!isAdminView || target.kind !== 'ssh'
                ? <p className="m-0 text-[13px] text-muted-foreground">{t('targets.detail.security.firstConnectHint')}</p>
                : hostKeysQuery.isLoading
                  ? <p className="m-0 text-[13px] text-muted-foreground">{t('states.loading')}</p>
                  : (hostKeysQuery.data ?? []).length === 0
                      ? <p className="m-0 text-[13px] text-muted-foreground">{t('targets.detail.security.noKnownKeys')}</p>
                      : (hostKeysQuery.data ?? []).map(key => (
                          <HostKeyRow key={key.id} algo={key.key_type} keyBase64={key.key_base64} />
                        ))}
            </div>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="permissions">
        <Card>
          <CardHeader>
            <CardTitle>
              {mode === 'admin'
                ? t('targets.detail.permissions.adminRoles')
                : t('targets.detail.permissions.userRoles')}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {!isAdminView
              ? <p className="m-0 px-5 py-4 text-[13px] text-muted-foreground">{t('targets.detail.permissions.youAreMember')}</p>
              : targetRolesQuery.isLoading
                ? <p className="m-0 px-5 py-4 text-[13px] text-muted-foreground">{t('states.loading')}</p>
                : (targetRolesQuery.data ?? []).length === 0
                    ? <p className="m-0 px-5 py-4 text-[13px] text-muted-foreground">{t('targets.detail.permissions.noRoles')}</p>
                    : (targetRolesQuery.data ?? []).map((role, index) => (
                        <div
                          key={role.id}
                          className="flex items-center gap-2.5 px-5 py-2.5"
                          style={{ borderTop: index === 0 ? 'none' : '1px solid hsl(var(--border))' }}
                        >
                          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-secondary">
                            <ShieldCheck size={13} />
                          </div>
                          <div className="flex-1">
                            <div className="text-[13.5px] font-medium">{role.name}</div>
                            <div className="text-[11px] text-muted-foreground">
                              {t('targets.detail.permissions.adminGrantsAccess')}
                            </div>
                          </div>
                        </div>
                      ))}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  )
}
