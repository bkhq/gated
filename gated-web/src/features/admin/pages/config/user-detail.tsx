import type { ExistingCertificateCredential, ExistingPublicKeyCredential, ExistingSsoCredential, IssuedCertificateCredential } from '@/features/admin/lib/api'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Award,
  FileBadge,
  KeyRound,
  Link2,
  Link2Off,
  Mail,
  Plus,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  User,
  UserCog,
} from 'lucide-react'
import { useCallback, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import {
  useAddUserRole,
  useAutoLinkUserToLdapMutation,
  useCertCredentialsQuery,
  useCreateOtpCredentialMutation,
  useCreatePasswordCredential,
  useCreatePublicKeyCredential,
  useCreateSsoCredential,
  useDeleteOtpCredentialMutation,
  useDeletePasswordCredential,
  useDeletePublicKeyCredential,
  useDeleteSsoCredential,
  useDeleteUser,
  useDeleteUserRole,
  useIssueCertCredentialMutation,
  useOtpCredentialsQuery,
  usePasswordCredentials,
  usePublicKeyCredentials,
  useRevokeCertCredentialMutation,
  useRoles,
  useSsoCredentials,
  useUnlinkUserFromLdapMutation,
  useUpdateUser,
  useUser,
  useUserRoles,
} from '@/features/admin/api'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { CopyButton } from '@/shared/components/copy-button'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/shared/components/ui/form'
import { Input } from '@/shared/components/ui/input'
import { Separator } from '@/shared/components/ui/separator'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { Textarea } from '@/shared/components/ui/textarea'

// ─── Base32 encoder (RFC 4648) for TOTP provisioning URI ─────────────────────

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function toBase32(bytes: Uint8Array): string {
  let result = ''
  let bits = 0
  let value = 0
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      result += BASE32_CHARS[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    result += BASE32_CHARS[(value << (5 - bits)) & 31]
  }
  return result
}

function buildOtpUri(username: string, secret: Uint8Array): string {
  const b32 = toBase32(secret)
  const label = encodeURIComponent(`Gated:${username}`)
  return `otpauth://totp/${label}?secret=${b32}&issuer=Gated`
}

// ─── Edit User Form ───────────────────────────────────────────────────────────

const editSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  description: z.string().optional(),
  rate_limit_bytes_per_second: z.string().optional(),
})
type EditFormValues = z.infer<typeof editSchema>

function EditUserCard({ userId }: { userId: string }) {
  const { t } = useTranslation('admin')
  const { t: tc } = useTranslation('common')
  const { data: user, isLoading } = useUser(userId)
  const updateUser = useUpdateUser(userId)

  const form = useForm<EditFormValues>({
    resolver: zodResolver(editSchema),
    values: user
      ? {
          username: user.username,
          description: user.description || '',
          rate_limit_bytes_per_second: user.rate_limit_bytes_per_second != null
            ? String(user.rate_limit_bytes_per_second)
            : '',
        }
      : undefined,
  })

  async function onSubmit(values: EditFormValues) {
    try {
      await updateUser.mutateAsync({
        username: values.username,
        description: values.description != null && values.description !== '' ? values.description : undefined,
        rate_limit_bytes_per_second:
          values.rate_limit_bytes_per_second === '' || values.rate_limit_bytes_per_second === undefined
            ? undefined
            : Number(values.rate_limit_bytes_per_second),
      })
      toast.success(t('users.updated'))
    }
    catch {
      toast.error(t('users.updateError'))
    }
  }

  if (isLoading)
    return <Skeleton className="h-32 w-full" />

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UserCog className="h-4 w-4" />
          {t('users.editUser')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={e => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('users.fields.username')}</FormLabel>
                    <FormControl><Input {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="rate_limit_bytes_per_second"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('users.fields.rateLimit')}</FormLabel>
                    <FormControl>
                      <Input type="number" placeholder={t('users.fields.rateLimitPlaceholder')} {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('users.fields.description')}</FormLabel>
                  <FormControl><Textarea rows={2} {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={updateUser.isPending}>
                {updateUser.isPending ? tc('actions.loading') : tc('actions.save')}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}

// ─── LDAP Card ────────────────────────────────────────────────────────────────

function LdapCard({ userId }: { userId: string }) {
  const { t } = useTranslation('admin')
  const { data: user } = useUser(userId)
  const unlink = useUnlinkUserFromLdapMutation()
  const autoLink = useAutoLinkUserToLdapMutation()
  const [confirmUnlink, setConfirmUnlink] = useState(false)

  async function handleAutoLink() {
    try {
      await autoLink.mutateAsync(userId)
      toast.success(t('users.ldap.autoLinkSuccess'))
    }
    catch {
      toast.error(t('users.ldap.autoLinkError'))
    }
  }

  async function handleUnlink() {
    try {
      await unlink.mutateAsync(userId)
      toast.success(t('users.ldap.unlinkSuccess'))
    }
    catch {
      toast.error(t('users.ldap.unlinkError'))
    }
    finally {
      setConfirmUnlink(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2 className="h-4 w-4" />
          {t('users.ldap.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {user?.ldap_server_id != null && user.ldap_server_id !== ''
          ? (
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">{t('users.ldap.linked')}</p>
                  <p className="text-xs text-muted-foreground font-mono">{user.ldap_server_id}</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setConfirmUnlink(true)}>
                  <Link2Off className="h-4 w-4 mr-2" />
                  {t('users.ldap.unlink')}
                </Button>
              </div>
            )
          : (
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{t('users.ldap.notLinked')}</p>
                <Button variant="outline" size="sm" onClick={() => void handleAutoLink()} disabled={autoLink.isPending}>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  {autoLink.isPending ? t('users.ldap.autoLinking') : t('users.ldap.autoLink')}
                </Button>
              </div>
            )}
      </CardContent>
      <ConfirmDialog
        open={confirmUnlink}
        onOpenChange={setConfirmUnlink}
        title={t('users.ldap.unlinkTitle')}
        description={t('users.ldap.unlinkDescription')}
        confirmLabel={t('users.ldap.unlink')}
        onConfirm={() => void handleUnlink()}
      />
    </Card>
  )
}

// ─── Password Tab ─────────────────────────────────────────────────────────────

const passwordSchema = z.object({
  password: z.string().min(1, 'Password is required'),
})
type PasswordFormValues = z.infer<typeof passwordSchema>

function PasswordsTab({ userId }: { userId: string }) {
  const { t } = useTranslation('admin')
  const { t: tc } = useTranslation('common')
  const { data: credentials, isLoading } = usePasswordCredentials(userId)
  const createCred = useCreatePasswordCredential(userId)
  const deleteCred = useDeletePasswordCredential(userId)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const form = useForm<PasswordFormValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { password: '' },
  })

  async function onSubmit(values: PasswordFormValues) {
    try {
      await createCred.mutateAsync({ password: values.password })
      toast.success(t('users.credentials.password.setSuccess'))
      form.reset()
      setDialogOpen(false)
    }
    catch {
      toast.error(t('users.credentials.password.setError'))
    }
  }

  async function handleDelete() {
    if (deleteId == null)
      return
    try {
      await deleteCred.mutateAsync(deleteId)
      toast.success(t('users.credentials.password.removeSuccess'))
    }
    catch {
      toast.error(t('users.credentials.password.removeError'))
    }
    finally {
      setDeleteId(null)
    }
  }

  if (isLoading)
    return <Skeleton className="h-24 w-full" />

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          {t('users.credentials.password.set')}
        </Button>
      </div>

      {!credentials || credentials.length === 0
        ? (
            <EmptyState icon={KeyRound} title={t('users.credentials.password.empty')} description={t('users.credentials.password.emptyDescription')} />
          )
        : (
            <div className="space-y-2">
              {credentials.map(cred => (
                <div key={cred.id} className="flex items-center justify-between p-3 rounded-md border">
                  <div className="flex items-center gap-2">
                    <KeyRound className="h-4 w-4 text-muted-foreground" />
                    <span className="text-xs font-mono text-muted-foreground">{cred.id}</span>
                  </div>
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteId(cred.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('users.credentials.password.set')}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={e => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('users.credentials.password.label')}</FormLabel>
                    <FormControl><Input type="password" placeholder={t('users.credentials.password.placeholder')} {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>{tc('actions.cancel')}</Button>
                <Button type="submit" disabled={createCred.isPending}>{createCred.isPending ? tc('actions.loading') : tc('actions.save')}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteId != null}
        onOpenChange={open => !open && setDeleteId(null)}
        title={t('users.credentials.password.removeTitle')}
        description={t('users.credentials.password.removeDescription')}
        confirmLabel={tc('actions.delete')}
        onConfirm={() => void handleDelete()}
      />
    </div>
  )
}

// ─── SSO Tab ──────────────────────────────────────────────────────────────────

const ssoSchema = z.object({
  email: z.string().email('Must be a valid email'),
  provider: z.string().optional(),
})
type SsoFormValues = z.infer<typeof ssoSchema>

function SsoTab({ userId }: { userId: string }) {
  const { t } = useTranslation('admin')
  const { t: tc } = useTranslation('common')
  const { data: credentials, isLoading } = useSsoCredentials(userId)
  const createCred = useCreateSsoCredential(userId)
  const deleteCred = useDeleteSsoCredential(userId)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ExistingSsoCredential | null>(null)

  const form = useForm<SsoFormValues>({
    resolver: zodResolver(ssoSchema),
    defaultValues: { email: '', provider: '' },
  })

  async function onSubmit(values: SsoFormValues) {
    try {
      await createCred.mutateAsync({ email: values.email, provider: values.provider != null && values.provider !== '' ? values.provider : undefined })
      toast.success(t('users.credentials.ssoCred.addSuccess'))
      form.reset()
      setDialogOpen(false)
    }
    catch {
      toast.error(t('users.credentials.ssoCred.addError'))
    }
  }

  async function handleDelete() {
    if (!deleteTarget)
      return
    try {
      await deleteCred.mutateAsync(deleteTarget.id)
      toast.success(t('users.credentials.ssoCred.removeSuccess'))
    }
    catch {
      toast.error(t('users.credentials.ssoCred.removeError'))
    }
    finally {
      setDeleteTarget(null)
    }
  }

  if (isLoading)
    return <Skeleton className="h-24 w-full" />

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          {t('users.credentials.ssoCred.add')}
        </Button>
      </div>

      {!credentials || credentials.length === 0
        ? (
            <EmptyState icon={Mail} title={t('users.credentials.ssoCred.empty')} description={t('users.credentials.ssoCred.emptyDescription')} />
          )
        : (
            <div className="space-y-2">
              {credentials.map(cred => (
                <div key={cred.id} className="flex items-center justify-between p-3 rounded-md border">
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">{cred.email}</span>
                    {cred.provider != null && cred.provider !== '' && <Badge variant="secondary" className="text-xs">{cred.provider}</Badge>}
                  </div>
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteTarget(cred)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('users.credentials.ssoCred.addTitle')}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={e => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('users.credentials.ssoCred.email')}</FormLabel>
                    <FormControl><Input type="email" placeholder="user@example.com" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="provider"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('users.credentials.ssoCred.provider')}</FormLabel>
                    <FormControl><Input placeholder="e.g. google, github" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>{tc('actions.cancel')}</Button>
                <Button type="submit" disabled={createCred.isPending}>{createCred.isPending ? t('users.credentials.ssoCred.adding') : tc('actions.add')}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={open => !open && setDeleteTarget(null)}
        title={t('users.credentials.ssoCred.removeTitle')}
        description={t('users.credentials.ssoCred.removeDescription')}
        confirmLabel={tc('actions.delete')}
        onConfirm={() => void handleDelete()}
      />
    </div>
  )
}

// ─── Public Keys Tab ──────────────────────────────────────────────────────────

const publicKeySchema = z.object({
  label: z.string().min(1, 'Label is required'),
  openssh_public_key: z.string().min(1, 'Public key is required'),
})
type PublicKeyFormValues = z.infer<typeof publicKeySchema>

function PublicKeysTab({ userId }: { userId: string }) {
  const { t } = useTranslation('admin')
  const { t: tc } = useTranslation('common')
  const { data: credentials, isLoading } = usePublicKeyCredentials(userId)
  const createCred = useCreatePublicKeyCredential(userId)
  const deleteCred = useDeletePublicKeyCredential(userId)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ExistingPublicKeyCredential | null>(null)

  const form = useForm<PublicKeyFormValues>({
    resolver: zodResolver(publicKeySchema),
    defaultValues: { label: '', openssh_public_key: '' },
  })

  async function onSubmit(values: PublicKeyFormValues) {
    try {
      await createCred.mutateAsync(values)
      toast.success(t('users.credentials.publicKey.addSuccess'))
      form.reset()
      setDialogOpen(false)
    }
    catch {
      toast.error(t('users.credentials.publicKey.addError'))
    }
  }

  async function handleDelete() {
    if (!deleteTarget)
      return
    try {
      await deleteCred.mutateAsync(deleteTarget.id)
      toast.success(t('users.credentials.publicKey.removeSuccess'))
    }
    catch {
      toast.error(t('users.credentials.publicKey.removeError'))
    }
    finally {
      setDeleteTarget(null)
    }
  }

  if (isLoading)
    return <Skeleton className="h-24 w-full" />

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          {t('users.credentials.publicKey.add')}
        </Button>
      </div>

      {!credentials || credentials.length === 0
        ? (
            <EmptyState icon={ShieldCheck} title={t('users.credentials.publicKey.empty')} description={t('users.credentials.publicKey.emptyDescription')} />
          )
        : (
            <div className="space-y-2">
              {credentials.map(cred => (
                <div key={cred.id} className="p-3 rounded-md border space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">{cred.label}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <CopyButton value={cred.openssh_public_key} label={t('users.credentials.publicKey.copyKey')} />
                      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteTarget(cred)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs font-mono text-muted-foreground truncate pl-6">{cred.openssh_public_key}</p>
                  {cred.last_used != null && cred.last_used !== '' && (
                    <p className="text-xs text-muted-foreground pl-6">
                      {t('users.credentials.publicKey.lastUsed')}
                      {new Date(cred.last_used).toLocaleDateString()}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('users.credentials.publicKey.addTitle')}</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={e => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
              <FormField
                control={form.control}
                name="label"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('users.credentials.publicKey.label')}</FormLabel>
                    <FormControl><Input placeholder="e.g. My laptop" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="openssh_public_key"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('users.credentials.publicKey.opensshKey')}</FormLabel>
                    <FormControl>
                      <Textarea placeholder="ssh-ed25519 AAAA..." rows={4} className="font-mono text-xs" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>{tc('actions.cancel')}</Button>
                <Button type="submit" disabled={createCred.isPending}>{createCred.isPending ? tc('actions.loading') : tc('actions.add')}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={open => !open && setDeleteTarget(null)}
        title={t('users.credentials.publicKey.removeTitle')}
        description={t('users.credentials.publicKey.removeDescription')}
        confirmLabel={tc('actions.delete')}
        onConfirm={() => void handleDelete()}
      />
    </div>
  )
}

// ─── OTP Tab ──────────────────────────────────────────────────────────────────

interface OtpSetupState {
  secret: Uint8Array
  uri: string
}

function OtpTab({ userId, username }: { userId: string, username: string }) {
  const { t } = useTranslation('admin')
  const { t: tc } = useTranslation('common')
  const { data: credentials, isLoading } = useOtpCredentialsQuery(userId)
  const createCred = useCreateOtpCredentialMutation(userId)
  const deleteCred = useDeleteOtpCredentialMutation(userId)
  const [setup, setSetup] = useState<OtpSetupState | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const generateAndShow = useCallback(() => {
    const secret = crypto.getRandomValues(new Uint8Array(20))
    setSetup({ secret, uri: buildOtpUri(username, secret) })
  }, [username])

  async function confirmAdd() {
    if (!setup)
      return
    try {
      await createCred.mutateAsync({ secret_key: Array.from(setup.secret) })
      toast.success(t('users.credentials.otpCred.addSuccess'))
      setSetup(null)
    }
    catch {
      toast.error(t('users.credentials.otpCred.addError'))
    }
  }

  async function handleDelete() {
    if (deleteId == null)
      return
    try {
      await deleteCred.mutateAsync(deleteId)
      toast.success(t('users.credentials.otpCred.removeSuccess'))
    }
    catch {
      toast.error(t('users.credentials.otpCred.removeError'))
    }
    finally {
      setDeleteId(null)
    }
  }

  if (isLoading)
    return <Skeleton className="h-24 w-full" />

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={generateAndShow}>
          <Plus className="h-4 w-4 mr-2" />
          {t('users.credentials.otpCred.add')}
        </Button>
      </div>

      {!credentials || credentials.length === 0
        ? (
            <EmptyState icon={Smartphone} title={t('users.credentials.otpCred.empty')} description={t('users.credentials.otpCred.emptyDescription')} />
          )
        : (
            <div className="space-y-2">
              {credentials.map(cred => (
                <div key={cred.id} className="flex items-center justify-between p-3 rounded-md border">
                  <div className="flex items-center gap-2">
                    <Smartphone className="h-4 w-4 text-muted-foreground" />
                    <span className="text-xs font-mono text-muted-foreground">{cred.id}</span>
                  </div>
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteId(cred.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

      {/* OTP Setup Dialog */}
      <Dialog open={!!setup} onOpenChange={open => !open && setSetup(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('users.credentials.otpCred.setupTitle')}</DialogTitle>
            <DialogDescription>
              {t('users.credentials.otpCred.setupDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md border bg-muted p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">{t('users.credentials.otpCred.provisioningUri')}</p>
              <div className="flex items-start gap-2">
                <p className="text-xs font-mono break-all flex-1">{setup?.uri}</p>
                {setup && <CopyButton value={setup.uri} label={t('users.credentials.otpCred.copyUri')} />}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('users.credentials.otpCred.afterConfirm')}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSetup(null)}>{tc('actions.cancel')}</Button>
            <Button onClick={() => void confirmAdd()} disabled={createCred.isPending}>
              {createCred.isPending ? tc('actions.loading') : t('users.credentials.otpCred.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteId != null}
        onOpenChange={open => !open && setDeleteId(null)}
        title={t('users.credentials.otpCred.removeTitle')}
        description={t('users.credentials.otpCred.removeDescription')}
        confirmLabel={tc('actions.delete')}
        onConfirm={() => void handleDelete()}
      />
    </div>
  )
}

// ─── Certificates Tab ─────────────────────────────────────────────────────────

const certIssueSchema = z.object({
  label: z.string().min(1, 'Label is required'),
  public_key_pem: z.string().min(1, 'Public key PEM is required'),
})
type CertIssueFormValues = z.infer<typeof certIssueSchema>

function CertificatesTab({ userId }: { userId: string }) {
  const { t } = useTranslation('admin')
  const { t: tc } = useTranslation('common')
  const { data: credentials, isLoading } = useCertCredentialsQuery(userId)
  const issueCert = useIssueCertCredentialMutation(userId)
  const revokeCert = useRevokeCertCredentialMutation(userId)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [issuedResult, setIssuedResult] = useState<IssuedCertificateCredential | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<ExistingCertificateCredential | null>(null)

  const form = useForm<CertIssueFormValues>({
    resolver: zodResolver(certIssueSchema),
    defaultValues: { label: '', public_key_pem: '' },
  })

  async function onIssue(values: CertIssueFormValues) {
    try {
      const result = await issueCert.mutateAsync(values)
      setIssuedResult(result)
      form.reset()
      setDialogOpen(false)
    }
    catch {
      toast.error(t('users.credentials.certificate.issueError'))
    }
  }

  async function handleRevoke() {
    if (!revokeTarget)
      return
    try {
      await revokeCert.mutateAsync(revokeTarget.id)
      toast.success(t('users.credentials.certificate.revokeSuccess'))
    }
    catch {
      toast.error(t('users.credentials.certificate.revokeError'))
    }
    finally {
      setRevokeTarget(null)
    }
  }

  if (isLoading)
    return <Skeleton className="h-24 w-full" />

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          {t('users.credentials.certificate.issue')}
        </Button>
      </div>

      {!credentials || credentials.length === 0
        ? (
            <EmptyState icon={FileBadge} title={t('users.credentials.certificate.empty')} description={t('users.credentials.certificate.emptyDescription')} />
          )
        : (
            <div className="space-y-2">
              {credentials.map(cred => (
                <div key={cred.id} className="p-3 rounded-md border space-y-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <FileBadge className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">{cred.label}</span>
                    </div>
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setRevokeTarget(cred)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground pl-6 font-mono">
                    {t('users.credentials.certificate.fingerprint')}
                    {cred.fingerprint}
                  </p>
                  {cred.date_added != null && cred.date_added !== '' && (
                    <p className="text-xs text-muted-foreground pl-6">
                      {t('users.credentials.certificate.dateAdded')}
                      {new Date(cred.date_added).toLocaleDateString()}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

      {/* Issue Certificate Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('users.credentials.certificate.issueTitle')}</DialogTitle>
            <DialogDescription>{t('users.credentials.certificate.issueDescription')}</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={e => void form.handleSubmit(onIssue)(e)} className="space-y-4">
              <FormField
                control={form.control}
                name="label"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('users.credentials.certificate.label')}</FormLabel>
                    <FormControl><Input placeholder="e.g. Work laptop cert" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="public_key_pem"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('users.credentials.certificate.publicKeyPem')}</FormLabel>
                    <FormControl>
                      <Textarea placeholder="-----BEGIN PUBLIC KEY-----&#10;..." rows={5} className="font-mono text-xs" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>{tc('actions.cancel')}</Button>
                <Button type="submit" disabled={issueCert.isPending}>{issueCert.isPending ? t('users.credentials.certificate.issuing') : t('users.credentials.certificate.issueButton')}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Issued Certificate Result */}
      <Dialog open={!!issuedResult} onOpenChange={open => !open && setIssuedResult(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('users.credentials.certificate.issuedTitle')}</DialogTitle>
            <DialogDescription>{t('users.credentials.certificate.issuedDescription')}</DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">{t('users.credentials.certificate.certificatePem')}</p>
              {issuedResult && <CopyButton value={issuedResult.certificate_pem} label={t('users.credentials.certificate.copyCert')} />}
            </div>
            <pre className="text-xs font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
              {issuedResult?.certificate_pem}
            </pre>
          </div>
          <DialogFooter>
            <Button onClick={() => setIssuedResult(null)}>{tc('actions.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={open => !open && setRevokeTarget(null)}
        title={t('users.credentials.certificate.revokeTitle')}
        description={t('users.credentials.certificate.revokeDescription')}
        confirmLabel={tc('actions.delete')}
        onConfirm={() => void handleRevoke()}
      />
    </div>
  )
}

// ─── Roles Tab ────────────────────────────────────────────────────────────────

function RolesTab({ userId }: { userId: string }) {
  const { t } = useTranslation('admin')
  const { t: tc } = useTranslation('common')
  const { data: userRoles, isLoading: rolesLoading } = useUserRoles(userId)
  const { data: allRoles, isLoading: allLoading } = useRoles()
  const addRole = useAddUserRole(userId)
  const removeRole = useDeleteUserRole(userId)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<{ id: string, name: string } | null>(null)

  const assignedIds = new Set(userRoles?.map(r => r.id) ?? [])
  const availableRoles = allRoles?.filter(r => !assignedIds.has(r.id)) ?? []

  async function handleAdd(roleId: string) {
    try {
      await addRole.mutateAsync(roleId)
      toast.success(t('users.credentials.role.addSuccess'))
    }
    catch {
      toast.error(t('users.credentials.role.addError'))
    }
  }

  async function handleRemove() {
    if (!removeTarget)
      return
    try {
      await removeRole.mutateAsync(removeTarget.id)
      toast.success(t('users.credentials.role.removeSuccess'))
    }
    catch {
      toast.error(t('users.credentials.role.removeError'))
    }
    finally {
      setRemoveTarget(null)
    }
  }

  if (rolesLoading)
    return <Skeleton className="h-24 w-full" />

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAddDialogOpen(true)} disabled={availableRoles.length === 0 || allLoading}>
          <Plus className="h-4 w-4 mr-2" />
          {t('users.credentials.role.add')}
        </Button>
      </div>

      {!userRoles || userRoles.length === 0
        ? (
            <EmptyState icon={Award} title={t('users.credentials.role.empty')} description={t('users.credentials.role.emptyDescription')} />
          )
        : (
            <div className="space-y-2">
              {userRoles.map(role => (
                <div key={role.id} className="flex items-center justify-between p-3 rounded-md border">
                  <div>
                    <p className="text-sm font-medium">{role.name}</p>
                    {role.description && <p className="text-xs text-muted-foreground">{role.description}</p>}
                  </div>
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setRemoveTarget({ id: role.id, name: role.name })}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

      {/* Add Role Dialog */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('users.credentials.role.addTitle')}</DialogTitle>
            <DialogDescription>{t('users.credentials.role.addDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {availableRoles.length === 0
              ? (
                  <p className="text-sm text-muted-foreground text-center py-4">{t('users.credentials.role.noMore')}</p>
                )
              : (
                  availableRoles.map(role => (
                    <div key={role.id} className="flex items-center justify-between p-3 rounded-md border hover:bg-muted/50">
                      <div>
                        <p className="text-sm font-medium">{role.name}</p>
                        {role.description && <p className="text-xs text-muted-foreground">{role.description}</p>}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={addRole.isPending}
                        onClick={() => {
                          void handleAdd(role.id).then(() => {
                            setAddDialogOpen(false)
                          })
                        }}
                      >
                        {tc('actions.add')}
                      </Button>
                    </div>
                  ))
                )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)}>{tc('actions.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={open => !open && setRemoveTarget(null)}
        title={t('users.credentials.role.removeTitle')}
        description={t('users.credentials.role.removeDescription')}
        confirmLabel={tc('actions.delete')}
        onConfirm={() => void handleRemove()}
      />
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function Component() {
  const { t } = useTranslation('admin')
  const { t: tc } = useTranslation('common')
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data: user, isLoading } = useUser(id!)
  const deleteUser = useDeleteUser()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  async function handleDeleteUser() {
    if (!user)
      return
    try {
      await deleteUser.mutateAsync(user.id)
      toast.success(t('users.deleted'))
      void navigate('/ui/admin/config/users')
    }
    catch {
      toast.error(t('users.deleteError'))
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!user) {
    return <EmptyState icon={User} title={t('users.notFound')} />
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={user.username}
        description={user.description || undefined}
        actions={(
          <Button variant="destructive" size="sm" onClick={() => setDeleteDialogOpen(true)}>
            <Trash2 className="h-4 w-4 mr-2" />
            {t('users.deleteUser')}
          </Button>
        )}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <EditUserCard userId={user.id} />
        </div>
        <div>
          <LdapCard userId={user.id} />
        </div>
      </div>

      <Separator />

      <Tabs defaultValue="passwords">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="passwords">
            <KeyRound className="h-4 w-4 mr-1.5" />
            {t('users.credentials.passwords')}
          </TabsTrigger>
          <TabsTrigger value="public-keys">
            <ShieldCheck className="h-4 w-4 mr-1.5" />
            {t('users.credentials.publicKeys')}
          </TabsTrigger>
          <TabsTrigger value="otp">
            <Smartphone className="h-4 w-4 mr-1.5" />
            {t('users.credentials.otp')}
          </TabsTrigger>
          <TabsTrigger value="certificates">
            <FileBadge className="h-4 w-4 mr-1.5" />
            {t('users.credentials.certificates')}
          </TabsTrigger>
          <TabsTrigger value="sso">
            <Mail className="h-4 w-4 mr-1.5" />
            {t('users.credentials.sso')}
          </TabsTrigger>
          <TabsTrigger value="roles">
            <Award className="h-4 w-4 mr-1.5" />
            {t('users.credentials.roles')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="passwords" className="mt-4"><PasswordsTab userId={user.id} /></TabsContent>
        <TabsContent value="public-keys" className="mt-4"><PublicKeysTab userId={user.id} /></TabsContent>
        <TabsContent value="otp" className="mt-4"><OtpTab userId={user.id} username={user.username} /></TabsContent>
        <TabsContent value="certificates" className="mt-4"><CertificatesTab userId={user.id} /></TabsContent>
        <TabsContent value="sso" className="mt-4"><SsoTab userId={user.id} /></TabsContent>
        <TabsContent value="roles" className="mt-4"><RolesTab userId={user.id} /></TabsContent>
      </Tabs>

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t('users.deleteTitle')}
        description={t('users.deleteDescription')}
        confirmLabel={tc('actions.delete')}
        onConfirm={() => void handleDeleteUser()}
      />
    </div>
  )
}
