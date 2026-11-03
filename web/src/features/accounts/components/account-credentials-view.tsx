import type { AccountCredentials } from '@/shared/types/domain'
import { Copy, Eye, EyeOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'

const MASK = '••••••••'

// Field order and i18n label per credential field; `secret` fields are only
// shown after a step-up reveal.
const FIELDS: Record<string, { label: string, secret?: boolean, block?: boolean, copy?: boolean }> = {
  engine: { label: 'accounts.form.cred.engine' },
  username: { label: 'accounts.form.cred.username' },
  password: { label: 'accounts.form.cred.password', secret: true },
  private_key_pem: { label: 'accounts.form.cred.privateKeyPem', secret: true, block: true },
  token: { label: 'accounts.form.cred.token', secret: true, block: true },
  client_certificate_pem: { label: 'accounts.form.cred.clientCertPem', block: true },
  client_private_key_pem: { label: 'accounts.form.cred.clientKeyPem', secret: true, block: true },
  passphrase: { label: 'accounts.form.cred.passphrase', secret: true },
  public_key_openssh: { label: 'accounts.form.cred.publicKey', block: true, copy: true },
  fingerprint: { label: 'accounts.form.cred.fingerprint' },
  ca_pem: { label: 'accounts.form.cred.caPem', block: true },
  namespace: { label: 'accounts.form.cred.namespace' },
}

interface AccountCredentialsViewProps {
  credentials: AccountCredentials
  revealed: AccountCredentials | null
  onReveal: () => void
  onHide: () => void
}

export function AccountCredentialsView({ credentials, revealed, onReveal, onHide }: AccountCredentialsViewProps) {
  const { t } = useTranslation()
  // The reveal response carries no derived fields such as the public key.
  const source = { ...credentials, ...revealed } as unknown as Record<string, unknown>

  const rows = credentials.kind === 'http-headers'
    ? (revealed?.kind === 'http-headers' ? revealed : credentials).headers.map(header => ({
        key: header.name,
        label: header.name,
        value: header.sensitive && !revealed ? MASK : header.value,
        block: false,
        copy: false,
      }))
    : Object.entries(FIELDS)
        .filter(([key]) => key in credentials)
        .map(([key, field]) => {
          const raw = source[key]
          let value = typeof raw === 'string' && raw.length > 0 ? raw : '—'
          if (field.secret && !revealed)
            value = MASK
          else if (key === 'engine')
            value = t(raw === 'postgres' ? 'accounts.form.cred.enginePostgres' : 'accounts.form.cred.engineMysql')
          const shown = value !== MASK && value !== '—'
          return { key, label: t(field.label), value, block: Boolean(field.block) && shown, copy: Boolean(field.copy) && shown }
        })

  return (
    <Card className="p-0">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold">{t('accounts.view.credentialTitle')}</div>
          <div className="mt-0.5 text-[12px] text-muted-foreground">
            {revealed ? t('accounts.form.reveal.autoClearHint') : t('accounts.view.revealHint')}
          </div>
        </div>
        {revealed
          ? (
              <Button type="button" variant="outline" size="sm" onClick={onHide}>
                <EyeOff size={13} />
                <span>{t('accounts.form.reveal.hide')}</span>
              </Button>
            )
          : (
              <Button type="button" variant="outline" size="sm" onClick={onReveal}>
                <Eye size={13} />
                <span>{t('accounts.form.reveal.show')}</span>
              </Button>
            )}
      </div>
      {rows.length === 0
        ? <div className="px-4 py-3 text-[12.5px] text-muted-foreground">—</div>
        : (
            <dl className="divide-y divide-border">
              {rows.map(row => (
                <div key={row.key} className="grid grid-cols-[160px_1fr] gap-3 px-4 py-2.5 text-[13px]">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="m-0 flex min-w-0 items-start gap-2">
                    {row.block
                      ? <pre className="mono m-0 max-h-32 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-all text-[12px]">{row.value}</pre>
                      : <span className="mono min-w-0 flex-1 break-all">{row.value}</span>}
                    {row.copy
                      ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            className="shrink-0"
                            onClick={() => void navigator.clipboard?.writeText(row.value)}
                            aria-label={t('accounts.view.copy', { field: row.label })}
                          >
                            <Copy size={13} />
                          </Button>
                        )
                      : null}
                  </dd>
                </div>
              ))}
            </dl>
          )}
    </Card>
  )
}
