import { useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
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
import {
  useUser,
  useUpdateUser,
  useDeleteUser,
  useRoles,
  useUserRoles,
  useAddUserRole,
  useDeleteUserRole,
  usePasswordCredentials,
  useCreatePasswordCredential,
  useDeletePasswordCredential,
  useSsoCredentials,
  useCreateSsoCredential,
  useDeleteSsoCredential,
  usePublicKeyCredentials,
  useCreatePublicKeyCredential,
  useDeletePublicKeyCredential,
  useOtpCredentialsQuery,
  useCreateOtpCredentialMutation,
  useDeleteOtpCredentialMutation,
  useCertCredentialsQuery,
  useIssueCertCredentialMutation,
  useRevokeCertCredentialMutation,
  useUnlinkUserFromLdapMutation,
  useAutoLinkUserToLdapMutation,
} from '@/features/admin/api'
import {
  type ExistingSsoCredential,
  type ExistingPublicKeyCredential,
  type ExistingCertificateCredential,
  type IssuedCertificateCredential,
} from '@/features/admin/lib/api'
import { PageHeader } from '@/shared/components/page-header'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { EmptyState } from '@/shared/components/empty-state'
import { CopyButton } from '@/shared/components/copy-button'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { Badge } from '@/shared/components/ui/badge'
import { Separator } from '@/shared/components/ui/separator'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
        description: values.description || undefined,
        rate_limit_bytes_per_second:
          values.rate_limit_bytes_per_second === '' || values.rate_limit_bytes_per_second === undefined
            ? undefined
            : Number(values.rate_limit_bytes_per_second),
      })
      toast.success('User updated')
    } catch {
      toast.error('Failed to update user')
    }
  }

  if (isLoading) return <Skeleton className="h-32 w-full" />

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UserCog className="h-4 w-4" />
          Edit User
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Username</FormLabel>
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
                    <FormLabel>Rate Limit (B/s)</FormLabel>
                    <FormControl>
                      <Input type="number" placeholder="Unlimited" {...field} value={field.value ?? ''} />
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
                  <FormLabel>Description</FormLabel>
                  <FormControl><Textarea rows={2} {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={updateUser.isPending}>
                {updateUser.isPending ? 'Saving...' : 'Save Changes'}
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
  const { data: user } = useUser(userId)
  const unlink = useUnlinkUserFromLdapMutation()
  const autoLink = useAutoLinkUserToLdapMutation()
  const [confirmUnlink, setConfirmUnlink] = useState(false)

  async function handleAutoLink() {
    try {
      await autoLink.mutateAsync(userId)
      toast.success('Auto-linked to LDAP')
    } catch {
      toast.error('Auto-link failed')
    }
  }

  async function handleUnlink() {
    try {
      await unlink.mutateAsync(userId)
      toast.success('Unlinked from LDAP')
    } catch {
      toast.error('Unlink failed')
    } finally {
      setConfirmUnlink(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2 className="h-4 w-4" />
          LDAP Link
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {user?.ldap_server_id ? (
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Linked</p>
              <p className="text-xs text-muted-foreground font-mono">{user.ldap_server_id}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setConfirmUnlink(true)}>
              <Link2Off className="h-4 w-4 mr-2" />
              Unlink
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">Not linked to LDAP</p>
            <Button variant="outline" size="sm" onClick={handleAutoLink} disabled={autoLink.isPending}>
              <RefreshCw className="h-4 w-4 mr-2" />
              {autoLink.isPending ? 'Linking...' : 'Auto-Link'}
            </Button>
          </div>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmUnlink}
        onOpenChange={setConfirmUnlink}
        title="Unlink from LDAP?"
        description="This will remove the LDAP association. The user will no longer sync with LDAP."
        confirmLabel="Unlink"
        onConfirm={handleUnlink}
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
      toast.success('Password set')
      form.reset()
      setDialogOpen(false)
    } catch {
      toast.error('Failed to set password')
    }
  }

  async function handleDelete() {
    if (!deleteId) return
    try {
      await deleteCred.mutateAsync(deleteId)
      toast.success('Password removed')
    } catch {
      toast.error('Failed to remove password')
    } finally {
      setDeleteId(null)
    }
  }

  if (isLoading) return <Skeleton className="h-24 w-full" />

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Set Password
        </Button>
      </div>

      {!credentials || credentials.length === 0 ? (
        <EmptyState icon={KeyRound} title="No password set" description="Set a password for this user." />
      ) : (
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
          <DialogHeader><DialogTitle>Set Password</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="password" render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
                  <FormControl><Input type="password" placeholder="New password" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createCred.isPending}>{createCred.isPending ? 'Saving...' : 'Save'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={!!deleteId} onOpenChange={open => !open && setDeleteId(null)}
        title="Remove password?" description="The password credential will be deleted."
        confirmLabel="Remove" onConfirm={handleDelete} />
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
      await createCred.mutateAsync({ email: values.email, provider: values.provider || undefined })
      toast.success('SSO credential added')
      form.reset()
      setDialogOpen(false)
    } catch {
      toast.error('Failed to add SSO credential')
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      await deleteCred.mutateAsync(deleteTarget.id)
      toast.success('SSO credential removed')
    } catch {
      toast.error('Failed to remove SSO credential')
    } finally {
      setDeleteTarget(null)
    }
  }

  if (isLoading) return <Skeleton className="h-24 w-full" />

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4 mr-2" />Add SSO</Button>
      </div>

      {!credentials || credentials.length === 0 ? (
        <EmptyState icon={Mail} title="No SSO credentials" description="Add an SSO identity for this user." />
      ) : (
        <div className="space-y-2">
          {credentials.map(cred => (
            <div key={cred.id} className="flex items-center justify-between p-3 rounded-md border">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">{cred.email}</span>
                {cred.provider && <Badge variant="secondary" className="text-xs">{cred.provider}</Badge>}
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
          <DialogHeader><DialogTitle>Add SSO Credential</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="email" render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl><Input type="email" placeholder="user@example.com" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="provider" render={({ field }) => (
                <FormItem>
                  <FormLabel>Provider (optional)</FormLabel>
                  <FormControl><Input placeholder="e.g. google, github" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createCred.isPending}>{createCred.isPending ? 'Adding...' : 'Add'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}
        title={`Remove SSO credential "${deleteTarget?.email}"?`}
        description="This SSO credential will be permanently removed."
        confirmLabel="Remove" onConfirm={handleDelete} />
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
      toast.success('Public key added')
      form.reset()
      setDialogOpen(false)
    } catch {
      toast.error('Failed to add public key')
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      await deleteCred.mutateAsync(deleteTarget.id)
      toast.success(`Key "${deleteTarget.label}" removed`)
    } catch {
      toast.error('Failed to remove public key')
    } finally {
      setDeleteTarget(null)
    }
  }

  if (isLoading) return <Skeleton className="h-24 w-full" />

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4 mr-2" />Add Key</Button>
      </div>

      {!credentials || credentials.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No public keys" description="Add an SSH public key for this user." />
      ) : (
        <div className="space-y-2">
          {credentials.map(cred => (
            <div key={cred.id} className="p-3 rounded-md border space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{cred.label}</span>
                </div>
                <div className="flex items-center gap-1">
                  <CopyButton value={cred.openssh_public_key} label="Copy key" />
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteTarget(cred)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <p className="text-xs font-mono text-muted-foreground truncate pl-6">{cred.openssh_public_key}</p>
              {cred.last_used && (
                <p className="text-xs text-muted-foreground pl-6">Last used: {new Date(cred.last_used).toLocaleDateString()}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Public Key</DialogTitle></DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="label" render={({ field }) => (
                <FormItem>
                  <FormLabel>Label</FormLabel>
                  <FormControl><Input placeholder="e.g. My laptop" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="openssh_public_key" render={({ field }) => (
                <FormItem>
                  <FormLabel>OpenSSH Public Key</FormLabel>
                  <FormControl>
                    <Textarea placeholder="ssh-ed25519 AAAA..." rows={4} className="font-mono text-xs" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createCred.isPending}>{createCred.isPending ? 'Adding...' : 'Add'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}
        title={`Remove key "${deleteTarget?.label}"?`}
        description="This public key will be permanently removed."
        confirmLabel="Remove" onConfirm={handleDelete} />
    </div>
  )
}

// ─── OTP Tab ──────────────────────────────────────────────────────────────────

interface OtpSetupState {
  secret: Uint8Array
  uri: string
}

function OtpTab({ userId, username }: { userId: string; username: string }) {
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
    if (!setup) return
    try {
      await createCred.mutateAsync({ secret_key: Array.from(setup.secret) })
      toast.success('OTP credential added')
      setSetup(null)
    } catch {
      toast.error('Failed to add OTP credential')
    }
  }

  async function handleDelete() {
    if (!deleteId) return
    try {
      await deleteCred.mutateAsync(deleteId)
      toast.success('OTP credential removed')
    } catch {
      toast.error('Failed to remove OTP credential')
    } finally {
      setDeleteId(null)
    }
  }

  if (isLoading) return <Skeleton className="h-24 w-full" />

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={generateAndShow}><Plus className="h-4 w-4 mr-2" />Add OTP</Button>
      </div>

      {!credentials || credentials.length === 0 ? (
        <EmptyState icon={Smartphone} title="No OTP credentials" description="Add a TOTP authenticator for this user." />
      ) : (
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
            <DialogTitle>Add TOTP Authenticator</DialogTitle>
            <DialogDescription>
              Scan the URI with your authenticator app or copy it manually. After confirming, the secret cannot be retrieved again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md border bg-muted p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Provisioning URI</p>
              <div className="flex items-start gap-2">
                <p className="text-xs font-mono break-all flex-1">{setup?.uri}</p>
                {setup && <CopyButton value={setup.uri} label="Copy URI" />}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              After clicking "Confirm", the secret is stored. Make sure the user has scanned this URI first.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSetup(null)}>Cancel</Button>
            <Button onClick={confirmAdd} disabled={createCred.isPending}>
              {createCred.isPending ? 'Saving...' : 'Confirm & Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={!!deleteId} onOpenChange={open => !open && setDeleteId(null)}
        title="Remove OTP credential?"
        description="The user will no longer be able to authenticate with this TOTP credential."
        confirmLabel="Remove" onConfirm={handleDelete} />
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
    } catch {
      toast.error('Failed to issue certificate')
    }
  }

  async function handleRevoke() {
    if (!revokeTarget) return
    try {
      await revokeCert.mutateAsync(revokeTarget.id)
      toast.success(`Certificate "${revokeTarget.label}" revoked`)
    } catch {
      toast.error('Failed to revoke certificate')
    } finally {
      setRevokeTarget(null)
    }
  }

  if (isLoading) return <Skeleton className="h-24 w-full" />

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4 mr-2" />Issue Certificate</Button>
      </div>

      {!credentials || credentials.length === 0 ? (
        <EmptyState icon={FileBadge} title="No certificates" description="Issue a certificate credential for this user." />
      ) : (
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
              <p className="text-xs text-muted-foreground pl-6 font-mono">Fingerprint: {cred.fingerprint}</p>
              {cred.date_added && (
                <p className="text-xs text-muted-foreground pl-6">Added: {new Date(cred.date_added).toLocaleDateString()}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Issue Certificate Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Issue Certificate</DialogTitle>
            <DialogDescription>Provide a label and the user's public key PEM to issue a signed certificate.</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onIssue)} className="space-y-4">
              <FormField control={form.control} name="label" render={({ field }) => (
                <FormItem>
                  <FormLabel>Label</FormLabel>
                  <FormControl><Input placeholder="e.g. Work laptop cert" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="public_key_pem" render={({ field }) => (
                <FormItem>
                  <FormLabel>Public Key (PEM)</FormLabel>
                  <FormControl>
                    <Textarea placeholder="-----BEGIN PUBLIC KEY-----&#10;..." rows={5} className="font-mono text-xs" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={issueCert.isPending}>{issueCert.isPending ? 'Issuing...' : 'Issue'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Issued Certificate Result */}
      <Dialog open={!!issuedResult} onOpenChange={open => !open && setIssuedResult(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Certificate Issued</DialogTitle>
            <DialogDescription>Save this certificate now — it will not be shown again.</DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">Certificate PEM</p>
              {issuedResult && <CopyButton value={issuedResult.certificate_pem} label="Copy certificate" />}
            </div>
            <pre className="text-xs font-mono whitespace-pre-wrap break-all max-h-48 overflow-y-auto">
              {issuedResult?.certificate_pem}
            </pre>
          </div>
          <DialogFooter>
            <Button onClick={() => setIssuedResult(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={!!revokeTarget} onOpenChange={open => !open && setRevokeTarget(null)}
        title={`Revoke certificate "${revokeTarget?.label}"?`}
        description="This certificate will be permanently revoked and can no longer be used."
        confirmLabel="Revoke" onConfirm={handleRevoke} />
    </div>
  )
}

// ─── Roles Tab ────────────────────────────────────────────────────────────────

function RolesTab({ userId }: { userId: string }) {
  const { data: userRoles, isLoading: rolesLoading } = useUserRoles(userId)
  const { data: allRoles, isLoading: allLoading } = useRoles()
  const addRole = useAddUserRole(userId)
  const removeRole = useDeleteUserRole(userId)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null)

  const assignedIds = new Set(userRoles?.map(r => r.id) ?? [])
  const availableRoles = allRoles?.filter(r => !assignedIds.has(r.id)) ?? []

  async function handleAdd(roleId: string, roleName: string) {
    try {
      await addRole.mutateAsync(roleId)
      toast.success(`Role "${roleName}" added`)
    } catch {
      toast.error('Failed to add role')
    }
  }

  async function handleRemove() {
    if (!removeTarget) return
    try {
      await removeRole.mutateAsync(removeTarget.id)
      toast.success(`Role "${removeTarget.name}" removed`)
    } catch {
      toast.error('Failed to remove role')
    } finally {
      setRemoveTarget(null)
    }
  }

  if (rolesLoading) return <Skeleton className="h-24 w-full" />

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAddDialogOpen(true)} disabled={availableRoles.length === 0 || allLoading}>
          <Plus className="h-4 w-4 mr-2" />
          Add Role
        </Button>
      </div>

      {!userRoles || userRoles.length === 0 ? (
        <EmptyState icon={Award} title="No roles assigned" description="Assign roles to control what this user can access." />
      ) : (
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
            <DialogTitle>Add Role</DialogTitle>
            <DialogDescription>Select a role to assign to this user.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {availableRoles.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No more roles available.</p>
            ) : (
              availableRoles.map(role => (
                <div key={role.id} className="flex items-center justify-between p-3 rounded-md border hover:bg-muted/50">
                  <div>
                    <p className="text-sm font-medium">{role.name}</p>
                    {role.description && <p className="text-xs text-muted-foreground">{role.description}</p>}
                  </div>
                  <Button size="sm" variant="outline"
                    disabled={addRole.isPending}
                    onClick={async () => {
                      await handleAdd(role.id, role.name)
                      setAddDialogOpen(false)
                    }}
                  >
                    Add
                  </Button>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={!!removeTarget} onOpenChange={open => !open && setRemoveTarget(null)}
        title={`Remove role "${removeTarget?.name}"?`}
        description="The user will lose access granted by this role."
        confirmLabel="Remove" onConfirm={handleRemove} />
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function Component() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data: user, isLoading } = useUser(id!)
  const deleteUser = useDeleteUser()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  async function handleDeleteUser() {
    if (!user) return
    try {
      await deleteUser.mutateAsync(user.id)
      toast.success(`User "${user.username}" deleted`)
      navigate('/@gated/admin/config/users')
    } catch {
      toast.error('Failed to delete user')
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
    return <EmptyState icon={User} title="User not found" description="The requested user does not exist." />
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={user.username}
        description={user.description || undefined}
        actions={
          <Button variant="destructive" size="sm" onClick={() => setDeleteDialogOpen(true)}>
            <Trash2 className="h-4 w-4 mr-2" />
            Delete User
          </Button>
        }
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
          <TabsTrigger value="passwords"><KeyRound className="h-4 w-4 mr-1.5" />Passwords</TabsTrigger>
          <TabsTrigger value="public-keys"><ShieldCheck className="h-4 w-4 mr-1.5" />Public Keys</TabsTrigger>
          <TabsTrigger value="otp"><Smartphone className="h-4 w-4 mr-1.5" />OTP</TabsTrigger>
          <TabsTrigger value="certificates"><FileBadge className="h-4 w-4 mr-1.5" />Certificates</TabsTrigger>
          <TabsTrigger value="sso"><Mail className="h-4 w-4 mr-1.5" />SSO</TabsTrigger>
          <TabsTrigger value="roles"><Award className="h-4 w-4 mr-1.5" />Roles</TabsTrigger>
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
        title={`Delete user "${user.username}"?`}
        description="This will permanently delete the user and all their credentials."
        confirmLabel="Delete"
        onConfirm={handleDeleteUser}
      />
    </div>
  )
}
