import type { BackedParameters, BackedParametersUpdate } from '@/shared/lib/api/settings'
import { CheckCircle2 } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { EncryptionAdminCard } from '@/features/admin/config/encryption-admin-card'
import {
  useBackendParameters,
  useUpdateBackendParameters,
} from '@/features/system-settings/hooks/use-system-settings-queries'
import { PageHeader } from '@/shared/components/page-header'
import { DEFAULT_SITE_TITLE } from '@/shared/hooks/use-site-title'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Separator } from '@/shared/ui/separator'
import { Skeleton } from '@/shared/ui/skeleton'
import { Switch } from '@/shared/ui/switch'

const SAVED_HINT_MS = 3000
const SITE_TITLE_MAX_CHARS = 64
const DEFAULT_SQL_CONSOLE_RATE_LIMIT_PER_MINUTE = 60

export function AdminParamsPage() {
  const { t } = useTranslation()
  return (
    <>
      <PageHeader
        title={t('nav.adminParams')}
        description={t('settings.description')}
        breadcrumbs={[{ label: t('section.admin') }, { label: t('nav.adminParams') }]}
      />
      <GatewayParametersCard />
      <EncryptionAdminCard />
    </>
  )
}

function GatewayParametersCard() {
  const query = useBackendParameters()

  if (query.isLoading || !query.data) {
    return (
      <div className="px-6 pt-4">
        <Card>
          <CardHeader>
            <CardTitle>
              <Skeleton className="h-5 w-40" />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {Array.from({ length: 4 }).map((_, idx) => (
              <Skeleton key={`gp-${String(idx)}`} className="h-9 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    )
  }

  return <GatewayParametersForm initial={query.data} />
}

function GatewayParametersForm({ initial }: { initial: BackedParameters }) {
  const { t } = useTranslation()
  const mutation = useUpdateBackendParameters()
  const initialDraft: BackedParametersUpdate = React.useMemo(() => ({
    allow_own_credential_management: initial.allow_own_credential_management,
    rate_limit_bytes_per_second: initial.rate_limit_bytes_per_second,
    ssh_client_auth_publickey: initial.ssh_client_auth_publickey,
    ssh_client_auth_password: initial.ssh_client_auth_password,
    ssh_client_auth_keyboard_interactive: initial.ssh_client_auth_keyboard_interactive,
    minimize_password_login: initial.minimize_password_login,
    sql_console_rate_limit_per_user:
      initial.sql_console_rate_limit_per_user ?? DEFAULT_SQL_CONSOLE_RATE_LIMIT_PER_MINUTE,
    sql_console_rate_limit_per_target:
      initial.sql_console_rate_limit_per_target ?? DEFAULT_SQL_CONSOLE_RATE_LIMIT_PER_MINUTE,
    terminal_watermark_enabled: initial.terminal_watermark_enabled,
    site_title: initial.site_title ?? '',
  }), [initial])

  const [draft, setDraft] = React.useState<BackedParametersUpdate>(() => initialDraft)
  const [original, setOriginal] = React.useState<BackedParametersUpdate>(() => initialDraft)
  const [savedAt, setSavedAt] = React.useState<number | null>(null)

  React.useEffect(() => {
    if (savedAt === null) {
      return undefined
    }
    const handle = window.setTimeout(setSavedAt, SAVED_HINT_MS, null)
    return () => window.clearTimeout(handle)
  }, [savedAt])

  const isDirty = JSON.stringify(draft) !== JSON.stringify(original)
  const canSave = isDirty && !mutation.isPending

  const set = <K extends keyof BackedParametersUpdate>(key: K, value: BackedParametersUpdate[K]) =>
    setDraft(prev => ({ ...prev, [key]: value }))

  const reset = () => setDraft(original)

  const save = async () => {
    if (!canSave) {
      return
    }
    await mutation.mutateAsync(draft)
    setOriginal(draft)
    setSavedAt(Date.now())
  }

  const rateLimitValue = draft.rate_limit_bytes_per_second
  const rateLimitInput = typeof rateLimitValue === 'number' ? String(rateLimitValue) : ''

  return (
    <div className="px-6 pt-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.parameters.title')}</CardTitle>
          <div className="text-[12.5px] text-muted-foreground">{t('settings.parameters.hint')}</div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Row
            htmlFor="setting-parameters-site-title"
            label={t('settings.parameters.siteTitle')}
            hint={t('settings.parameters.siteTitleHint')}
            control={(
              <Input
                id="setting-parameters-site-title"
                value={draft.site_title ?? ''}
                maxLength={SITE_TITLE_MAX_CHARS}
                placeholder={DEFAULT_SITE_TITLE}
                aria-describedby="setting-parameters-site-title-hint"
                onChange={e => set('site_title', e.target.value)}
                wrapperClassName="w-[260px]"
              />
            )}
          />
          <Separator />
          <Row
            label={t('settings.parameters.allowOwnCredentialManagement')}
            hint={t('settings.parameters.allowOwnCredentialManagementHint')}
            control={(
              <Switch
                checked={draft.allow_own_credential_management}
                onCheckedChange={v => set('allow_own_credential_management', Boolean(v))}
                aria-label={t('settings.parameters.allowOwnCredentialManagement')}
              />
            )}
          />
          <Separator />
          <Row
            htmlFor="setting-parameters-rate-limit"
            label={t('settings.parameters.rateLimitBytesPerSecond')}
            hint={t('settings.parameters.rateLimitBytesPerSecondHint')}
            control={(
              <Input
                id="setting-parameters-rate-limit"
                type="number"
                min={0}
                value={rateLimitInput}
                onChange={(e) => {
                  const raw = e.target.value
                  if (raw === '') {
                    set('rate_limit_bytes_per_second', undefined)
                    return
                  }
                  const parsed = Number(raw)
                  if (Number.isFinite(parsed) && parsed >= 0) {
                    set('rate_limit_bytes_per_second', Math.floor(parsed))
                  }
                }}
                wrapperClassName="w-[200px]"
                suffix={<span className="text-[11.5px] text-muted-foreground">{t('settings.parameters.rateLimitBytesPerSecondUnit')}</span>}
              />
            )}
          />
          <Separator />
          <Row
            htmlFor="setting-parameters-sql-console-rate-limit-per-user"
            label={t('settings.parameters.sqlConsoleRateLimitPerUser')}
            hint={t('settings.parameters.sqlConsoleRateLimitPerUserHint')}
            control={(
              <Input
                id="setting-parameters-sql-console-rate-limit-per-user"
                type="number"
                min={1}
                value={String(draft.sql_console_rate_limit_per_user)}
                onChange={(e) => {
                  const parsed = Number(e.target.value)
                  if (Number.isFinite(parsed) && parsed >= 1) {
                    set('sql_console_rate_limit_per_user', Math.floor(parsed))
                  }
                }}
                wrapperClassName="w-[200px]"
                suffix={<span className="text-[11.5px] text-muted-foreground">{t('settings.parameters.sqlConsoleRateLimitUnit')}</span>}
              />
            )}
          />
          <Separator />
          <Row
            htmlFor="setting-parameters-sql-console-rate-limit-per-target"
            label={t('settings.parameters.sqlConsoleRateLimitPerTarget')}
            hint={t('settings.parameters.sqlConsoleRateLimitPerTargetHint')}
            control={(
              <Input
                id="setting-parameters-sql-console-rate-limit-per-target"
                type="number"
                min={1}
                value={String(draft.sql_console_rate_limit_per_target)}
                onChange={(e) => {
                  const parsed = Number(e.target.value)
                  if (Number.isFinite(parsed) && parsed >= 1) {
                    set('sql_console_rate_limit_per_target', Math.floor(parsed))
                  }
                }}
                wrapperClassName="w-[200px]"
                suffix={<span className="text-[11.5px] text-muted-foreground">{t('settings.parameters.sqlConsoleRateLimitUnit')}</span>}
              />
            )}
          />
          <Separator />
          <Row
            label={t('settings.parameters.terminalWatermarkEnabled')}
            hint={t('settings.parameters.terminalWatermarkEnabledHint')}
            control={(
              <Switch
                checked={draft.terminal_watermark_enabled ?? false}
                onCheckedChange={v => set('terminal_watermark_enabled', Boolean(v))}
                aria-label={t('settings.parameters.terminalWatermarkEnabled')}
              />
            )}
          />
          <Separator />
          <div className="text-[12.5px] font-medium text-foreground">{t('settings.parameters.sshAuthSection')}</div>
          <Row
            label={t('settings.parameters.sshClientAuthPublickey')}
            control={(
              <Switch
                checked={draft.ssh_client_auth_publickey ?? false}
                onCheckedChange={v => set('ssh_client_auth_publickey', Boolean(v))}
                aria-label={t('settings.parameters.sshClientAuthPublickey')}
              />
            )}
          />
          <Separator />
          <Row
            label={t('settings.parameters.sshClientAuthPassword')}
            control={(
              <Switch
                checked={draft.ssh_client_auth_password ?? false}
                onCheckedChange={v => set('ssh_client_auth_password', Boolean(v))}
                aria-label={t('settings.parameters.sshClientAuthPassword')}
              />
            )}
          />
          <Separator />
          <Row
            label={t('settings.parameters.sshClientAuthKeyboardInteractive')}
            control={(
              <Switch
                checked={draft.ssh_client_auth_keyboard_interactive ?? false}
                onCheckedChange={v => set('ssh_client_auth_keyboard_interactive', Boolean(v))}
                aria-label={t('settings.parameters.sshClientAuthKeyboardInteractive')}
              />
            )}
          />
          <Separator />
          <Row
            label={t('settings.parameters.minimizePasswordLogin')}
            hint={t('settings.parameters.minimizePasswordLoginHint')}
            control={(
              <Switch
                checked={draft.minimize_password_login ?? false}
                onCheckedChange={v => set('minimize_password_login', Boolean(v))}
                aria-label={t('settings.parameters.minimizePasswordLogin')}
              />
            )}
          />
          <Separator />
          <div className="flex items-center justify-end gap-2">
            {savedAt
              ? (
                  <span className="inline-flex items-center gap-1.5 text-[12.5px] text-[hsl(var(--success))]">
                    <CheckCircle2 size={13} />
                    <span>{t('settings.parameters.saved')}</span>
                  </span>
                )
              : null}
            <Button variant="outline" size="sm" onClick={reset} disabled={!isDirty || mutation.isPending}>
              {t('settings.footer.reset')}
            </Button>
            <Button
              size="sm"
              onClick={() => { void save() }}
              disabled={!canSave}
              aria-disabled={!canSave}
            >
              {mutation.isPending ? t('settings.parameters.saving') : t('settings.parameters.save')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function Row({ label, hint, error, control, htmlFor }: {
  label: React.ReactNode
  hint?: React.ReactNode
  error?: string
  control: React.ReactNode
  htmlFor?: string
}) {
  const hintId = htmlFor && hint ? `${htmlFor}-hint` : undefined
  const errorId = htmlFor && error ? `${htmlFor}-error` : undefined
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 max-w-[460px]">
        <Label htmlFor={htmlFor} className="mb-1 text-[13.5px]">{label}</Label>
        {hint ? <div id={hintId} className="text-[12px] text-muted-foreground">{hint}</div> : null}
        {error ? <div id={errorId} className="mt-1 text-[12px] text-destructive">{error}</div> : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}
