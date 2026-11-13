import type { SettingsTab } from '@/features/admin/config/settings-tabs'
import type { BackedParameters, BackedParametersUpdate } from '@/shared/lib/api/settings'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { CheckCircle2 } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AboutPanel } from '@/features/about/about-panel'
import { AcmeSettingsCard } from '@/features/admin/config/acme-settings-card'
import { EncryptionAdminCard } from '@/features/admin/config/encryption-admin-card'
import { LoginProtectionCard } from '@/features/admin/config/login-protection-card'
import { SETTINGS_TABS } from '@/features/admin/config/settings-tabs'
import { SshKeysCard } from '@/features/admin/config/ssh-keys-card'
import { TlsCertificatesCard } from '@/features/admin/config/tls-certificates-card'
import { UpdatePanel } from '@/features/admin/config/update-panel'
import {
  useBackendParameters,
  useUpdateBackendParameters,
} from '@/features/system-settings/hooks/use-system-settings-queries'
import { PageHeader } from '@/shared/components/page-header'
import { DEFAULT_SITE_TITLE } from '@/shared/hooks/use-site-title'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Select } from '@/shared/ui/select'
import { Separator } from '@/shared/ui/separator'
import { Skeleton } from '@/shared/ui/skeleton'
import { Switch } from '@/shared/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/shared/ui/tabs'

const SAVED_HINT_MS = 3000
const SITE_TITLE_MAX_CHARS = 64
const DEFAULT_SQL_CONSOLE_RATE_LIMIT_PER_MINUTE = 60
/** Login protection bounds of the API, in minutes: one day and thirty days. */
const MAX_WINDOW_MINUTES = 1440
const MAX_DURATION_MINUTES = 43200
const MAX_API_TOKEN_DAYS = 3650
const MAX_PASSWORD_MIN_LENGTH = 128

type ParameterSection = Extract<SettingsTab, 'general' | 'sessions' | 'ssh' | 'security'>
type LoginProtection = BackedParameters['login_protection']
type PasswordPolicy = BackedParameters['password_policy']

function isParameterSection(tab: SettingsTab): tab is ParameterSection {
  return tab === 'general' || tab === 'sessions' || tab === 'ssh' || tab === 'security'
}

export function AdminParamsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const tab = useSearch({ from: '/admin/params' }).tab ?? 'general'
  return (
    <>
      <PageHeader
        title={t('nav.adminParams')}
        description={t('settings.description')}
        breadcrumbs={[{ label: t('section.admin') }, { label: t('nav.adminParams') }]}
        tabs={(
          <Tabs value={tab} onChange={next => void navigate({ to: '/admin/params', search: { tab: next as SettingsTab } })}>
            <TabsList>
              {SETTINGS_TABS.map(value => (
                <TabsTrigger key={value} value={value}>{t(`settings.tabs.${value}`)}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
      />
      {/* Kept mounted across tabs so unsaved parameter edits survive. */}
      <GatewayParametersCard section={isParameterSection(tab) ? tab : null} />
      {tab === 'ssh' ? <SshKeysCard /> : null}
      {tab === 'tls' ? <TlsCertificatesCard /> : null}
      {tab === 'tls' ? <AcmeSettingsCard /> : null}
      {tab === 'update' ? <UpdatePanel /> : null}
      {tab === 'security' ? <LoginProtectionCard /> : null}
      {tab === 'security' ? <EncryptionAdminCard /> : null}
      {tab === 'about' ? <AboutPanel /> : null}
    </>
  )
}

function GatewayParametersCard({ section }: { section: ParameterSection | null }) {
  const query = useBackendParameters()

  if (query.isLoading || !query.data) {
    return (
      <div className={cn('px-6 pt-4', section === null && 'hidden')}>
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

  return <GatewayParametersForm initial={query.data} section={section} />
}

/** Hours between automatic target reachability checks; 0 turns them off. */
const TARGET_CHECK_INTERVALS = [0, 1, 6, 24]

function GatewayParametersForm({ initial, section }: { initial: BackedParameters, section: ParameterSection | null }) {
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
    target_check_interval_hours: initial.target_check_interval_hours,
    login_protection: initial.login_protection,
    // 0 lifts the limit.
    max_api_token_duration_seconds: initial.max_api_token_duration_seconds ?? 0,
    password_policy: initial.password_policy,
    mfa_required: initial.mfa_required,
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

  const passwordPolicy = draft.password_policy ?? initial.password_policy
  const setPasswordPolicy = <K extends keyof PasswordPolicy>(key: K, value: PasswordPolicy[K]) =>
    set('password_policy', { ...passwordPolicy, [key]: value })
  const passwordFlagRow = (key: 'require_uppercase' | 'require_lowercase' | 'require_digits' | 'require_special', name: string) => (
    <Row
      label={t(`settings.parameters.${name}`)}
      control={(
        <Switch
          checked={passwordPolicy[key]}
          onCheckedChange={v => setPasswordPolicy(key, Boolean(v))}
          aria-label={t(`settings.parameters.${name}`)}
        />
      )}
    />
  )
  const loginProtection = draft.login_protection ?? initial.login_protection
  const setLoginProtection = <K extends keyof LoginProtection>(key: K, value: LoginProtection[K]) =>
    set('login_protection', { ...loginProtection, [key]: value })
  const attemptsRow = (key: 'ip_max_attempts' | 'user_max_attempts', name: string, hint: boolean) => (
    <Row
      htmlFor={`setting-login-protection-${key}`}
      label={t(`settings.loginProtection.params.${name}`)}
      hint={hint ? t(`settings.loginProtection.params.${name}Hint`) : undefined}
      control={(
        <Input
          id={`setting-login-protection-${key}`}
          type="number"
          min={1}
          max={1000}
          value={String(loginProtection[key])}
          onChange={(e) => {
            const parsed = Number(e.target.value)
            if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000) {
              setLoginProtection(key, parsed)
            }
          }}
          wrapperClassName="w-[200px]"
          suffix={<span className="text-[11.5px] text-muted-foreground">{t('settings.loginProtection.params.attempts')}</span>}
        />
      )}
    />
  )
  // The API takes seconds; whole minutes are precise enough to edit.
  const minutesRow = (
    key: 'ip_window_seconds' | 'ip_block_seconds' | 'ip_max_block_seconds' | 'user_window_seconds' | 'user_lockout_seconds',
    name: string,
    { min, max, hint }: { min: number, max: number, hint?: boolean },
  ) => (
    <Row
      htmlFor={`setting-login-protection-${key}`}
      label={t(`settings.loginProtection.params.${name}`)}
      hint={hint ? t(`settings.loginProtection.params.${name}Hint`) : undefined}
      control={(
        <Input
          id={`setting-login-protection-${key}`}
          type="number"
          min={min}
          max={max}
          value={String(Math.round(loginProtection[key] / 60))}
          onChange={(e) => {
            const parsed = Number(e.target.value)
            if (Number.isInteger(parsed) && parsed >= min && parsed <= max) {
              setLoginProtection(key, parsed * 60)
            }
          }}
          wrapperClassName="w-[200px]"
          suffix={<span className="text-[11.5px] text-muted-foreground">{t('settings.loginProtection.params.minutes')}</span>}
        />
      )}
    />
  )

  const rateLimitValue = draft.rate_limit_bytes_per_second
  const rateLimitInput = typeof rateLimitValue === 'number' ? String(rateLimitValue) : ''

  return (
    <div className={cn('px-6 pt-4', section === null && 'hidden')}>
      <Card>
        <CardHeader>
          <CardTitle>{section ? t(`settings.tabs.${section}`) : null}</CardTitle>
          <div className="text-[12.5px] text-muted-foreground">{t('settings.parameters.hint')}</div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {section === 'general' && (
            <>
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
              <Row
                htmlFor="setting-parameters-max-api-token-duration"
                label={t('settings.parameters.maxApiTokenDuration')}
                hint={t('settings.parameters.maxApiTokenDurationHint')}
                control={(
                  <Input
                    id="setting-parameters-max-api-token-duration"
                    type="number"
                    min={1}
                    max={MAX_API_TOKEN_DAYS}
                    value={draft.max_api_token_duration_seconds ? String(Math.round(draft.max_api_token_duration_seconds / 86400)) : ''}
                    aria-describedby="setting-parameters-max-api-token-duration-hint"
                    onChange={(e) => {
                      const parsed = Number(e.target.value)
                      if (e.target.value === '') {
                        set('max_api_token_duration_seconds', 0)
                      }
                      else if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_API_TOKEN_DAYS) {
                        set('max_api_token_duration_seconds', parsed * 86400)
                      }
                    }}
                    wrapperClassName="w-[200px]"
                    suffix={<span className="text-[11.5px] text-muted-foreground">{t('settings.parameters.maxApiTokenDurationUnit')}</span>}
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
            </>
          )}
          {section === 'sessions' && (
            <>
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
              <Row
                label={t('settings.parameters.targetCheckInterval')}
                hint={t('settings.parameters.targetCheckIntervalHint')}
                control={(
                  <Select
                    className="w-[200px]"
                    value={String(draft.target_check_interval_hours ?? 24)}
                    onValueChange={value => set('target_check_interval_hours', Number(value))}
                    aria-label={t('settings.parameters.targetCheckInterval')}
                    // A value set through the API outside the presets stays selectable.
                    options={[...new Set([...TARGET_CHECK_INTERVALS, draft.target_check_interval_hours ?? 24])].map(hours => ({
                      value: String(hours),
                      label: hours === 0 ? t('settings.parameters.targetCheckOff') : t('settings.parameters.targetCheckHours', { count: hours }),
                    }))}
                  />
                )}
              />
            </>
          )}
          {section === 'ssh' && (
            <>
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
            </>
          )}
          {section === 'security' && (
            <>
              <Row
                htmlFor="setting-parameters-password-min-length"
                label={t('settings.parameters.passwordMinLength')}
                hint={t('settings.parameters.passwordMinLengthHint')}
                control={(
                  <Input
                    id="setting-parameters-password-min-length"
                    type="number"
                    min={0}
                    max={MAX_PASSWORD_MIN_LENGTH}
                    value={String(passwordPolicy.min_length)}
                    aria-describedby="setting-parameters-password-min-length-hint"
                    onChange={(e) => {
                      const parsed = Number(e.target.value)
                      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_PASSWORD_MIN_LENGTH) {
                        setPasswordPolicy('min_length', parsed)
                      }
                    }}
                    wrapperClassName="w-[200px]"
                    suffix={<span className="text-[11.5px] text-muted-foreground">{t('settings.parameters.passwordMinLengthUnit')}</span>}
                  />
                )}
              />
              {passwordFlagRow('require_uppercase', 'passwordRequireUppercase')}
              {passwordFlagRow('require_lowercase', 'passwordRequireLowercase')}
              {passwordFlagRow('require_digits', 'passwordRequireDigits')}
              {passwordFlagRow('require_special', 'passwordRequireSpecial')}
              <Separator />
              <Row
                label={t('settings.parameters.mfaRequired')}
                hint={t('settings.parameters.mfaRequiredHint')}
                control={(
                  <Switch
                    checked={draft.mfa_required ?? initial.mfa_required}
                    onCheckedChange={v => set('mfa_required', Boolean(v))}
                    aria-label={t('settings.parameters.mfaRequired')}
                  />
                )}
              />
              <Separator />
              <Row
                label={t('settings.loginProtection.params.enabled')}
                hint={t('settings.loginProtection.params.enabledHint')}
                control={(
                  <Switch
                    checked={loginProtection.enabled}
                    onCheckedChange={v => setLoginProtection('enabled', Boolean(v))}
                    aria-label={t('settings.loginProtection.params.enabled')}
                  />
                )}
              />
              <Separator />
              {attemptsRow('ip_max_attempts', 'ipMaxAttempts', true)}
              {minutesRow('ip_window_seconds', 'ipWindow', { min: 1, max: MAX_WINDOW_MINUTES })}
              {minutesRow('ip_block_seconds', 'ipBlock', { min: 1, max: MAX_DURATION_MINUTES, hint: true })}
              {minutesRow('ip_max_block_seconds', 'ipMaxBlock', { min: 1, max: MAX_DURATION_MINUTES })}
              <Separator />
              {attemptsRow('user_max_attempts', 'userMaxAttempts', true)}
              {minutesRow('user_window_seconds', 'userWindow', { min: 1, max: MAX_WINDOW_MINUTES })}
              {minutesRow('user_lockout_seconds', 'userLockout', { min: 0, max: MAX_DURATION_MINUTES, hint: true })}
            </>
          )}
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
