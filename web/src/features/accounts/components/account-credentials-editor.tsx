import type { AccountCredentials, DbEngine, HttpHeaderCredential } from '@/shared/types/domain'
import { Eye, EyeOff, Minus, Plus } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Select } from '@/shared/ui/select'
import { Switch } from '@/shared/ui/switch'
import { Textarea } from '@/shared/ui/textarea'

interface CredentialsEditorProps {
  credentials: AccountCredentials
  onChange: (next: AccountCredentials) => void
}

export function CredentialsEditor({ credentials, onChange }: CredentialsEditorProps) {
  const { t } = useTranslation()
  switch (credentials.kind) {
    case 'ssh-password':
      return (
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <FieldText
            label={t('accounts.form.cred.username')}
            value={credentials.username}
            onChange={username => onChange({ ...credentials, username })}
            autoComplete="username"
          />
          <FieldPassword
            label={t('accounts.form.cred.password')}
            value={credentials.password}
            onChange={password => onChange({ ...credentials, password })}
          />
        </div>
      )
    case 'ssh-key':
      return (
        <div className="flex flex-col gap-4">
          <FieldText
            label={t('accounts.form.cred.username')}
            value={credentials.username}
            onChange={username => onChange({ ...credentials, username })}
            autoComplete="username"
          />
          <FieldTextarea
            label={t('accounts.form.cred.privateKeyPem')}
            value={credentials.private_key_pem}
            onChange={private_key_pem => onChange({ ...credentials, private_key_pem })}
            placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'}
            rows={6}
          />
          <FieldPassword
            label={t('accounts.form.cred.passphrase')}
            value={credentials.passphrase ?? ''}
            onChange={passphrase => onChange({ ...credentials, passphrase })}
          />
        </div>
      )
    case 'db-password':
      return (
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="account-cred-engine">{t('accounts.form.cred.engine')}</Label>
            <Select
              id="account-cred-engine"
              value={credentials.engine}
              onValueChange={value => onChange({ ...credentials, engine: value as DbEngine })}
              options={[
                { value: 'mysql', label: t('accounts.form.cred.engineMysql') },
                { value: 'postgres', label: t('accounts.form.cred.enginePostgres') },
              ]}
            />
          </div>
          <FieldText
            label={t('accounts.form.cred.username')}
            value={credentials.username}
            onChange={username => onChange({ ...credentials, username })}
            autoComplete="username"
          />
          <div className="sm:col-span-2">
            <FieldPassword
              label={t('accounts.form.cred.password')}
              value={credentials.password}
              onChange={password => onChange({ ...credentials, password })}
            />
          </div>
        </div>
      )
    case 'k8s-token':
      return (
        <div className="flex flex-col gap-4">
          <FieldTextarea
            label={t('accounts.form.cred.token')}
            value={credentials.token}
            onChange={token => onChange({ ...credentials, token })}
            rows={3}
          />
          <FieldTextarea
            label={t('accounts.form.cred.caPem')}
            value={credentials.ca_pem ?? ''}
            onChange={ca_pem => onChange({ ...credentials, ca_pem })}
            placeholder={'-----BEGIN CERTIFICATE-----\n…'}
            rows={4}
          />
          <FieldText
            label={t('accounts.form.cred.namespace')}
            value={credentials.namespace ?? ''}
            onChange={namespace => onChange({ ...credentials, namespace })}
          />
        </div>
      )
    case 'k8s-client-cert':
      return (
        <div className="flex flex-col gap-4">
          <FieldTextarea
            label={t('accounts.form.cred.clientCertPem')}
            value={credentials.client_certificate_pem}
            onChange={client_certificate_pem => onChange({ ...credentials, client_certificate_pem })}
            placeholder={'-----BEGIN CERTIFICATE-----\n…'}
            rows={5}
          />
          <FieldTextarea
            label={t('accounts.form.cred.clientKeyPem')}
            value={credentials.client_private_key_pem}
            onChange={client_private_key_pem => onChange({ ...credentials, client_private_key_pem })}
            placeholder={'-----BEGIN PRIVATE KEY-----\n…'}
            rows={5}
          />
          <FieldPassword
            label={t('accounts.form.cred.passphrase')}
            value={credentials.passphrase ?? ''}
            onChange={passphrase => onChange({ ...credentials, passphrase })}
          />
          <FieldTextarea
            label={t('accounts.form.cred.caPem')}
            value={credentials.ca_pem ?? ''}
            onChange={ca_pem => onChange({ ...credentials, ca_pem })}
            rows={4}
          />
          <FieldText
            label={t('accounts.form.cred.namespace')}
            value={credentials.namespace ?? ''}
            onChange={namespace => onChange({ ...credentials, namespace })}
          />
        </div>
      )
    case 'http-headers':
      return (
        <HttpHeadersEditor
          headers={credentials.headers}
          onChange={headers => onChange({ kind: 'http-headers', headers })}
        />
      )
  }
}

interface FieldTextProps {
  label: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
  autoComplete?: string
}

function FieldText({ label, value, onChange, placeholder, autoComplete }: FieldTextProps) {
  const id = React.useId()
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
      />
    </div>
  )
}

function FieldPassword({ label, value, onChange }: { label: string, value: string, onChange: (next: string) => void }) {
  const { t } = useTranslation()
  const id = React.useId()
  const [show, setShow] = React.useState(false)
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={event => onChange(event.target.value)}
        autoComplete="new-password"
        placeholder="••••••••"
        suffix={(
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setShow(v => !v)}
            aria-label={t('a11y.admin.config.accounts.togglePasswordVisibility')}
            aria-pressed={show}
          >
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </Button>
        )}
      />
    </div>
  )
}

function FieldTextarea({ label, value, onChange, placeholder, rows }: {
  label: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
  rows?: number
}) {
  const id = React.useId()
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        className="mono"
        rows={rows}
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  )
}

function HttpHeadersEditor({ headers, onChange }: {
  headers: HttpHeaderCredential[]
  onChange: (next: HttpHeaderCredential[]) => void
}) {
  const { t } = useTranslation()
  // Stable per-row ids so input focus and key order survive add/remove without
  // relying on volatile array indices. Idempotent back-fill matches incoming
  // header length when add/remove was driven externally (e.g. kind reset).
  const idsRef = React.useRef<string[]>([])
  // eslint-disable-next-line react/purity -- ids are derived state synced to headers.length; effect-based sync would render with undefined keys for one frame
  while (idsRef.current.length < headers.length) idsRef.current.push(crypto.randomUUID())
  if (idsRef.current.length > headers.length) {
    idsRef.current.length = headers.length
  }
  function update(index: number, patch: Partial<HttpHeaderCredential>) {
    onChange(headers.map((h, i) => (i === index ? { ...h, ...patch } : h)))
  }
  function add() {
    idsRef.current.push(crypto.randomUUID())
    onChange([...headers, { name: '', value: '' }])
  }
  function remove(index: number) {
    idsRef.current.splice(index, 1)
    onChange(headers.filter((_, i) => i !== index))
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Label className="mb-0">{t('accounts.form.cred.headers')}</Label>
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus size={13} />
          <span>{t('accounts.form.cred.addHeader')}</span>
        </Button>
      </div>
      {headers.length === 0
        ? null
        : (
            <div className="flex flex-col gap-2">
              {headers.map((header, index) => (
                <div key={idsRef.current[index]} className="grid grid-cols-[1fr_1.5fr_auto_auto] items-center gap-2">
                  <Input
                    value={header.name}
                    onChange={event => update(index, { name: event.target.value })}
                    placeholder={t('accounts.form.cred.headerName')}
                    autoComplete="off"
                  />
                  <Input
                    type={header.sensitive ? 'password' : 'text'}
                    value={header.value}
                    onChange={event => update(index, { value: event.target.value })}
                    placeholder={t('accounts.form.cred.headerValue')}
                    autoComplete="off"
                  />
                  <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    <Switch
                      checked={Boolean(header.sensitive)}
                      onCheckedChange={value => update(index, { sensitive: value })}
                      aria-label={t('accounts.form.cred.headerSensitive')}
                    />
                    <span>{t('accounts.form.cred.headerSensitive')}</span>
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => remove(index)}
                    aria-label={t('accounts.form.cred.removeHeader')}
                  >
                    <Minus size={14} />
                  </Button>
                </div>
              ))}
            </div>
          )}
    </div>
  )
}
