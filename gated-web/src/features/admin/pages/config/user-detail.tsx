import { useState } from 'react'
import { useParams, useNavigate } from 'react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { KeyRound, Mail, Plus, ShieldCheck, Trash2, User } from 'lucide-react'
import {
  useUser,
  useDeleteUser,
  useUserRoles,
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
} from '@/features/admin/api'
import { type ExistingSsoCredential, type ExistingPublicKeyCredential } from '@/features/admin/lib/api'
import { PageHeader } from '@/shared/components/page-header'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { Badge } from '@/shared/components/ui/badge'
import {
  Dialog,
  DialogContent,
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
import { Separator } from '@/shared/components/ui/separator'

// ─── Password Credentials Tab ───────────────────────────────────────────────

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
      toast.success('Password credential added')
      form.reset()
      setDialogOpen(false)
    } catch {
      toast.error('Failed to add password credential')
    }
  }

  async function handleDelete() {
    if (!deleteId) return
    try {
      await deleteCred.mutateAsync(deleteId)
      toast.success('Password credential removed')
    } catch {
      toast.error('Failed to remove password credential')
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

      {credentials && credentials.length > 0 ? (
        <div className="space-y-2">
          {credentials.map(cred => (
            <div key={cred.id} className="flex items-center justify-between p-3 rounded-md border">
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-mono text-muted-foreground">{cred.id}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleteId(cred.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground text-center py-6">No password credentials set.</p>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set Password</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="New password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createCred.isPending}>
                  {createCred.isPending ? 'Saving...' : 'Save'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={open => !open && setDeleteId(null)}
        title="Remove password credential?"
        description="This will remove the password credential."
        confirmLabel="Remove"
        onConfirm={handleDelete}
      />
    </div>
  )
}

// ─── SSO Credentials Tab ────────────────────────────────────────────────────

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
      await createCred.mutateAsync({
        email: values.email,
        provider: values.provider || undefined,
      })
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
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add SSO
        </Button>
      </div>

      {credentials && credentials.length > 0 ? (
        <div className="space-y-2">
          {credentials.map(cred => (
            <div key={cred.id} className="flex items-center justify-between p-3 rounded-md border">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">{cred.email}</span>
                {cred.provider && (
                  <Badge variant="secondary" className="text-xs">{cred.provider}</Badge>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleteTarget(cred)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground text-center py-6">No SSO credentials configured.</p>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add SSO Credential</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="user@example.com" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="provider"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Provider (optional)</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. google, github" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createCred.isPending}>
                  {createCred.isPending ? 'Adding...' : 'Add'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={open => !open && setDeleteTarget(null)}
        title={`Remove SSO credential "${deleteTarget?.email}"?`}
        description="This SSO credential will be permanently removed."
        confirmLabel="Remove"
        onConfirm={handleDelete}
      />
    </div>
  )
}

// ─── Public Keys Tab ─────────────────────────────────────────────────────────

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
      toast.success(`Public key "${deleteTarget.label}" removed`)
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
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Public Key
        </Button>
      </div>

      {credentials && credentials.length > 0 ? (
        <div className="space-y-2">
          {credentials.map(cred => (
            <div key={cred.id} className="p-3 rounded-md border space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{cred.label}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setDeleteTarget(cred)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs font-mono text-muted-foreground truncate pl-6">
                {cred.openssh_public_key}
              </p>
              {cred.last_used && (
                <p className="text-xs text-muted-foreground pl-6">
                  Last used: {new Date(cred.last_used).toLocaleDateString()}
                </p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground text-center py-6">No public keys configured.</p>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Public Key</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="label"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Label</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. My laptop" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="openssh_public_key"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>OpenSSH Public Key</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="ssh-ed25519 AAAA..."
                        rows={4}
                        className="font-mono text-xs"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createCred.isPending}>
                  {createCred.isPending ? 'Adding...' : 'Add'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={open => !open && setDeleteTarget(null)}
        title={`Remove public key "${deleteTarget?.label}"?`}
        description="This public key will be permanently removed."
        confirmLabel="Remove"
        onConfirm={handleDelete}
      />
    </div>
  )
}

// ─── Roles Tab ───────────────────────────────────────────────────────────────

function RolesTab({ userId }: { userId: string }) {
  const { data: roles, isLoading } = useUserRoles(userId)
  const deleteRole = useDeleteUserRole(userId)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)

  async function handleDelete() {
    if (!deleteTarget) return
    try {
      await deleteRole.mutateAsync(deleteTarget.id)
      toast.success(`Role "${deleteTarget.name}" removed`)
    } catch {
      toast.error('Failed to remove role')
    } finally {
      setDeleteTarget(null)
    }
  }

  if (isLoading) return <Skeleton className="h-24 w-full" />

  return (
    <div className="space-y-4">
      {roles && roles.length > 0 ? (
        <div className="space-y-2">
          {roles.map(role => (
            <div key={role.id} className="flex items-center justify-between p-3 rounded-md border">
              <div>
                <p className="text-sm font-medium">{role.name}</p>
                {role.description && (
                  <p className="text-xs text-muted-foreground">{role.description}</p>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleteTarget({ id: role.id, name: role.name })}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground text-center py-6">No roles assigned.</p>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={open => !open && setDeleteTarget(null)}
        title={`Remove role "${deleteTarget?.name}"?`}
        description="This role will be removed from the user."
        confirmLabel="Remove"
        onConfirm={handleDelete}
      />
    </div>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

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
      </div>
    )
  }

  if (!user) {
    return <p className="text-muted-foreground">User not found.</p>
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={user.username}
        description={user.description || undefined}
        actions={
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete User
          </Button>
        }
      />

      {/* User Info Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <User className="h-4 w-4" />
            User Info
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">ID</p>
              <p className="font-mono text-xs mt-0.5">{user.id}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Username</p>
              <p className="mt-0.5">{user.username}</p>
            </div>
            {user.description && (
              <div className="col-span-2">
                <p className="text-muted-foreground">Description</p>
                <p className="mt-0.5">{user.description}</p>
              </div>
            )}
            {user.ldap_server_id && (
              <div>
                <p className="text-muted-foreground">LDAP Server</p>
                <p className="font-mono text-xs mt-0.5">{user.ldap_server_id}</p>
              </div>
            )}
            {user.rate_limit_bytes_per_second !== undefined && (
              <div>
                <p className="text-muted-foreground">Rate Limit</p>
                <p className="mt-0.5">{user.rate_limit_bytes_per_second} B/s</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Separator />

      {/* Credentials Tabs */}
      <Tabs defaultValue="passwords">
        <TabsList>
          <TabsTrigger value="passwords">
            <KeyRound className="h-4 w-4 mr-1.5" />
            Passwords
          </TabsTrigger>
          <TabsTrigger value="sso">
            <Mail className="h-4 w-4 mr-1.5" />
            SSO
          </TabsTrigger>
          <TabsTrigger value="public-keys">
            <ShieldCheck className="h-4 w-4 mr-1.5" />
            Public Keys
          </TabsTrigger>
          <TabsTrigger value="roles">
            <User className="h-4 w-4 mr-1.5" />
            Roles
          </TabsTrigger>
        </TabsList>

        <TabsContent value="passwords" className="mt-4">
          <PasswordsTab userId={user.id} />
        </TabsContent>
        <TabsContent value="sso" className="mt-4">
          <SsoTab userId={user.id} />
        </TabsContent>
        <TabsContent value="public-keys" className="mt-4">
          <PublicKeysTab userId={user.id} />
        </TabsContent>
        <TabsContent value="roles" className="mt-4">
          <RolesTab userId={user.id} />
        </TabsContent>
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
