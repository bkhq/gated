import type { Account, AccountCredentials } from '@/shared/types/domain'
import { ApiError } from '@/shared/lib/api/http'

export function isRotationDue(account: Pick<Account, 'rotationDueAt'>, now = Date.now()): boolean {
  if (!account.rotationDueAt)
    return false
  const due = Date.parse(account.rotationDueAt)
  return Number.isFinite(due) && due <= now
}

export function isUsedToday(account: Pick<Account, 'lastUsed'>, now = new Date()): boolean {
  if (!account.lastUsed)
    return false
  const used = new Date(account.lastUsed)
  return used.getFullYear() === now.getFullYear()
    && used.getMonth() === now.getMonth()
    && used.getDate() === now.getDate()
}

export function formatDateTime(iso: string | null, locale: string): string {
  if (!iso)
    return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(locale)
}

// i18n label keys of required credential fields that are blank. Secrets may
// be left blank on edit, where blank means "keep the stored value".
export function missingCredentialFields(creds: AccountCredentials, allowBlankSecrets: boolean): string[] {
  const missing: string[] = []
  const need = (value: string | undefined, label: string, secret = false) => {
    if ((value ?? '').trim() === '' && !(secret && allowBlankSecrets))
      missing.push(label)
  }
  switch (creds.kind) {
    case 'ssh-password':
    case 'db-password':
      need(creds.username, 'accounts.form.cred.username')
      need(creds.password, 'accounts.form.cred.password', true)
      break
    case 'ssh-key':
      need(creds.username, 'accounts.form.cred.username')
      need(creds.private_key_pem, 'accounts.form.cred.privateKeyPem', true)
      break
    case 'k8s-token':
      need(creds.token, 'accounts.form.cred.token', true)
      break
    case 'k8s-client-cert':
      need(creds.client_certificate_pem, 'accounts.form.cred.clientCertPem')
      need(creds.client_private_key_pem, 'accounts.form.cred.clientKeyPem', true)
      break
    case 'http-headers':
      if (creds.headers.length === 0 || creds.headers.some(h => h.name.trim() === ''))
        missing.push('accounts.form.cred.headerName')
      if (creds.headers.some(h => h.value === '') && !allowBlankSecrets)
        missing.push('accounts.form.cred.headerValue')
      break
  }
  return missing
}

// Failures that belong to the step-up prompt (wrong factor, throttled).
export function stepUpErrorKey(error: unknown): string | null {
  if (!(error instanceof ApiError))
    return null
  if (error.status === 401)
    return 'accounts.stepUp.errors.unauthorized'
  if (error.status === 429)
    return 'accounts.stepUp.errors.rateLimited'
  return null
}
