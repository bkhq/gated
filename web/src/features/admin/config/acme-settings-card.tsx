import type { AcmeSettings, UpdateAcmeSettingsRequest } from '@/shared/lib/api/tls-certificates'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2 } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/shared/lib/api/http'
import { getAcmeSettings, updateAcmeSettings } from '@/shared/lib/api/tls-certificates'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { PasswordInput } from '@/shared/ui/password-input'
import { Select } from '@/shared/ui/select'
import { Skeleton } from '@/shared/ui/skeleton'
import { Textarea } from '@/shared/ui/textarea'

const ACME_SETTINGS_QUERY_KEY = ['acme-settings'] as const

const DIRECTORIES = {
  letsencrypt: 'https://acme-v02.api.letsencrypt.org/directory',
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
} as const

type DirectoryChoice = keyof typeof DIRECTORIES | 'custom'

function directoryChoice(url: string): DirectoryChoice {
  return (Object.keys(DIRECTORIES) as (keyof typeof DIRECTORIES)[]).find(key => DIRECTORIES[key] === url) ?? 'custom'
}

/** The ACME account and DNS provider shared by every listener. */
export function AcmeSettingsCard() {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ACME_SETTINGS_QUERY_KEY,
    queryFn: async ({ signal }) => getAcmeSettings(signal),
  })
  return (
    <div className="px-6 pt-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.acme.title')}</CardTitle>
          <div className="mt-1 text-[12.5px] text-muted-foreground">{t('settings.acme.hint')}</div>
        </CardHeader>
        <CardContent>
          {query.data ? <AcmeSettingsForm settings={query.data} /> : <Skeleton className="h-4 w-full" />}
        </CardContent>
      </Card>
    </div>
  )
}

function AcmeSettingsForm({ settings }: { settings: AcmeSettings }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [directory, setDirectory] = React.useState<DirectoryChoice>(() => directoryChoice(settings.directory_url))
  const [customDirectory, setCustomDirectory] = React.useState(() => directoryChoice(settings.directory_url) === 'custom' ? settings.directory_url : '')
  const [email, setEmail] = React.useState(settings.contact_email)
  const [provider, setProvider] = React.useState(settings.dns_provider)
  const [endpoint, setEndpoint] = React.useState(settings.dns_endpoint)
  const [username, setUsername] = React.useState(settings.dns_username)
  const [password, setPassword] = React.useState('')
  const [subdomain, setSubdomain] = React.useState(settings.dns_subdomain)
  const [delay, setDelay] = React.useState(String(settings.propagation_delay_secs))
  const [ca, setCa] = React.useState(settings.ca_certificate_pem ?? '')
  const [saved, setSaved] = React.useState(false)
  const mutation = useMutation({
    mutationFn: async (req: UpdateAcmeSettingsRequest) => updateAcmeSettings(req),
    onSuccess: (data) => {
      qc.setQueryData(ACME_SETTINGS_QUERY_KEY, data)
      setPassword('')
      setSaved(true)
    },
  })

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setSaved(false)
    mutation.mutate({
      directory_url: directory === 'custom' ? customDirectory : DIRECTORIES[directory],
      contact_email: email,
      ca_certificate_pem: ca.trim() ? ca : null,
      dns_provider: provider,
      dns_endpoint: endpoint,
      dns_username: username,
      dns_password: password || null,
      dns_subdomain: provider === 'acme-dns' ? subdomain : '',
      propagation_delay_secs: Number.parseInt(delay, 10) || 0,
    })
  }

  const error = mutation.error instanceof ApiError && typeof mutation.error.body === 'string'
    ? mutation.error.body
    : mutation.isError ? t('settings.acme.saveError') : null

  return (
    <form className="grid max-w-2xl gap-3 sm:grid-cols-2" onSubmit={submit}>
      <div>
        <Label htmlFor="acme-directory">{t('settings.acme.directory')}</Label>
        <Select
          id="acme-directory"
          value={directory}
          onValueChange={value => setDirectory(value as DirectoryChoice)}
          options={(['letsencrypt', 'staging', 'custom'] as const).map(value => ({ value, label: t(`settings.acme.directories.${value}`) }))}
        />
      </div>
      {directory === 'custom'
        ? (
            <div>
              <Label htmlFor="acme-directory-url">{t('settings.acme.directoryUrl')}</Label>
              <Input id="acme-directory-url" value={customDirectory} onChange={e => setCustomDirectory(e.target.value)} placeholder="https://" />
            </div>
          )
        : <div className="hidden sm:block" />}
      <div>
        <Label htmlFor="acme-email">{t('settings.acme.email')}</Label>
        <Input id="acme-email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="acme-provider">{t('settings.acme.provider')}</Label>
        <Select
          id="acme-provider"
          value={provider}
          onValueChange={value => setProvider(value as AcmeSettings['dns_provider'])}
          options={(['httpreq', 'acme-dns'] as const).map(value => ({ value, label: t(`settings.acme.providers.${value}`) }))}
        />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor="acme-endpoint">{t('settings.acme.endpoint')}</Label>
        <Input id="acme-endpoint" value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="https://api.dnsall.com" />
      </div>
      <div>
        <Label htmlFor="acme-username">{t('settings.acme.username')}</Label>
        <Input id="acme-username" autoComplete="off" value={username} onChange={e => setUsername(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="acme-password">{t('settings.acme.password')}</Label>
        <PasswordInput
          id="acme-password"
          autoComplete="new-password"
          value={password}
          placeholder={settings.dns_password_set ? t('settings.acme.passwordUnchanged') : ''}
          onChange={e => setPassword(e.target.value)}
          toggleLabelShow={t('encryption.passwordShow')}
          toggleLabelHide={t('encryption.passwordHide')}
        />
      </div>
      {provider === 'acme-dns'
        ? (
            <div>
              <Label htmlFor="acme-subdomain">{t('settings.acme.subdomain')}</Label>
              <Input id="acme-subdomain" value={subdomain} onChange={e => setSubdomain(e.target.value)} />
            </div>
          )
        : null}
      <div>
        <Label htmlFor="acme-delay">{t('settings.acme.delay')}</Label>
        <Input id="acme-delay" type="number" min={0} max={600} value={delay} onChange={e => setDelay(e.target.value)} />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor="acme-ca">{t('settings.acme.ca')}</Label>
        <Textarea
          id="acme-ca"
          rows={3}
          spellCheck={false}
          className="font-mono text-[12px]"
          placeholder="-----BEGIN CERTIFICATE-----"
          value={ca}
          onChange={e => setCa(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" size="sm" disabled={mutation.isPending}>{t('settings.acme.save')}</Button>
        {saved
          ? (
              <span className="inline-flex items-center gap-1 text-[12.5px] text-muted-foreground">
                <CheckCircle2 size={13} />
                {t('settings.acme.saved')}
              </span>
            )
          : null}
        {error
          ? (
              <span role="alert" className="inline-flex items-center gap-1.5 text-[12.5px] text-destructive">
                <AlertCircle size={14} aria-hidden="true" />
                {error}
              </span>
            )
          : null}
      </div>
    </form>
  )
}
