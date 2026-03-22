import { useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { z } from 'zod'
import { Trash2, Plus } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/shared/components/ui/dialog'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/shared/components/ui/form'
import { Input } from '@/shared/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { CopyButton } from '@/shared/components/copy-button'
import {
  useCredentialsQuery,
  useAddPublicKeyMutation,
  useDeletePublicKeyMutation,
  useAddOtpMutation,
  useDeleteOtpMutation,
} from '@/features/gateway/api'
import type { ExistingPublicKeyCredential, ExistingOtpCredential, ExistingCertificateCredential } from '@/features/gateway/lib/api-client'

// ---- Public Keys ----

const addKeySchema = z.object({
  label: z.string().min(1),
  openssh_public_key: z.string().min(1),
})
type AddKeyForm = z.infer<typeof addKeySchema>

function PublicKeyRow({ pk, onDelete }: { pk: ExistingPublicKeyCredential; onDelete: (id: string) => void }) {
  const { t } = useTranslation('gateway')
  return (
    <div className="flex items-center gap-2 py-2 border-b last:border-0">
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">{pk.label}</p>
        <p className="text-xs text-muted-foreground font-mono truncate">{pk.abbreviated}</p>
        {pk.date_added && (
          <p className="text-xs text-muted-foreground">{t('credentials.addedOn', { date: new Date(pk.date_added).toLocaleDateString() })}</p>
        )}
      </div>
      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => onDelete(pk.id)}>
        <Trash2 className="size-4" />
      </Button>
    </div>
  )
}

function AddPublicKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(['gateway', 'common'])
  const addKey = useAddPublicKeyMutation()

  const form = useForm<AddKeyForm>({
    resolver: zodResolver(addKeySchema),
    defaultValues: { label: '', openssh_public_key: '' },
  })

  async function onSubmit(values: AddKeyForm) {
    try {
      await addKey.mutateAsync(values)
      form.reset()
      onOpenChange(false)
      toast.success(t('gateway:credentials.publicKeys.addSuccess'))
    } catch {
      toast.error(t('gateway:credentials.publicKeys.addError'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('gateway:credentials.publicKeys.addTitle')}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('gateway:credentials.label')}</FormLabel>
                  <FormControl><Input {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="openssh_public_key"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('gateway:credentials.publicKeys.publicKey')}</FormLabel>
                  <FormControl>
                    <textarea
                      className="w-full min-h-[80px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-y"
                      placeholder="ssh-rsa AAAA..."
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('common:actions.cancel')}
              </Button>
              <Button type="submit" disabled={addKey.isPending}>
                {addKey.isPending ? t('common:actions.loading') : t('common:actions.add')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

// ---- OTP ----

function OtpRow({ otp, onDelete, index }: { otp: ExistingOtpCredential; onDelete: (id: string) => void; index: number }) {
  const { t } = useTranslation('gateway')
  return (
    <div className="flex items-center gap-2 py-2 border-b last:border-0">
      <div className="flex-1">
        <p className="text-sm">{t('credentials.otp.item', { index: index + 1 })}</p>
        <p className="text-xs text-muted-foreground font-mono">{otp.id}</p>
      </div>
      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => onDelete(otp.id)}>
        <Trash2 className="size-4" />
      </Button>
    </div>
  )
}

function AddOtpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(['gateway', 'common'])
  const addOtp = useAddOtpMutation()
  const [provisioningUri, setProvisioningUri] = useState<string | null>(null)

  function generateSecret(): number[] {
    const arr = new Uint8Array(20)
    crypto.getRandomValues(arr)
    return Array.from(arr)
  }

  async function handleAdd() {
    const secretKey = generateSecret()
    try {
      await addOtp.mutateAsync({ secret_key: secretKey })
      // Build a simple TOTP URI for display
      const base32 = btoa(String.fromCharCode(...secretKey))
        .replace(/=/g, '')
        .replace(/\+/g, 'A')
        .replace(/\//g, 'B')
      setProvisioningUri(`otpauth://totp/Gated?secret=${base32}`)
    } catch {
      toast.error(t('gateway:credentials.otp.addError'))
    }
  }

  function handleClose() {
    setProvisioningUri(null)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('gateway:credentials.otp.addTitle')}</DialogTitle>
        </DialogHeader>
        {provisioningUri ? (
          <div className="space-y-4">
            <p className="text-sm">{t('gateway:credentials.otp.addedInfo')}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-muted px-2 py-1 rounded font-mono break-all">{provisioningUri}</code>
              <CopyButton value={provisioningUri} label={t('common:actions.copy')} />
            </div>
            <p className="text-xs text-muted-foreground">{t('gateway:credentials.otp.scanOnce')}</p>
            <DialogFooter>
              <Button onClick={handleClose}>{t('common:actions.close')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm">{t('gateway:credentials.otp.addDescription')}</p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleClose}>
                {t('common:actions.cancel')}
              </Button>
              <Button onClick={handleAdd} disabled={addOtp.isPending}>
                {addOtp.isPending ? t('common:actions.loading') : t('common:actions.generate')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---- Certificates ----

function CertificateRow({ cert }: { cert: ExistingCertificateCredential }) {
  const { t } = useTranslation('gateway')
  return (
    <div className="flex items-center gap-2 py-2 border-b last:border-0">
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">{cert.label}</p>
        <p className="text-xs text-muted-foreground font-mono truncate">{cert.fingerprint}</p>
        {cert.date_added && (
          <p className="text-xs text-muted-foreground">{t('credentials.addedOn', { date: new Date(cert.date_added).toLocaleDateString() })}</p>
        )}
      </div>
    </div>
  )
}

// ---- Main Page ----

export function Component() {
  const { t } = useTranslation(['gateway', 'common'])
  const credQuery = useCredentialsQuery()
  const deleteKey = useDeletePublicKeyMutation()
  const deleteOtp = useDeleteOtpMutation()

  const [addKeyOpen, setAddKeyOpen] = useState(false)
  const [addOtpOpen, setAddOtpOpen] = useState(false)

  const credentials = credQuery.data

  async function handleDeleteKey(id: string) {
    try {
      await deleteKey.mutateAsync(id)
      toast.success(t('gateway:credentials.publicKeys.deleteSuccess'))
    } catch {
      toast.error(t('gateway:credentials.publicKeys.deleteError'))
    }
  }

  async function handleDeleteOtp(id: string) {
    try {
      await deleteOtp.mutateAsync(id)
      toast.success(t('gateway:credentials.otp.deleteSuccess'))
    } catch {
      toast.error(t('gateway:credentials.otp.deleteError'))
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-heading font-semibold">{t('gateway:pages.credentials')}</h1>

      <Tabs defaultValue="public-keys">
        <TabsList>
          <TabsTrigger value="public-keys">{t('gateway:credentials.publicKeys.tab')}</TabsTrigger>
          <TabsTrigger value="otp">{t('gateway:credentials.otp.tab')}</TabsTrigger>
          <TabsTrigger value="certificates">{t('gateway:credentials.certificates.tab')}</TabsTrigger>
        </TabsList>

        <TabsContent value="public-keys" className="mt-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between pb-3">
              <CardTitle className="text-base">{t('gateway:credentials.publicKeys.tab')}</CardTitle>
              <Button size="sm" variant="outline" onClick={() => setAddKeyOpen(true)}>
                <Plus className="size-4 mr-1" />
                {t('common:actions.add')}
              </Button>
            </CardHeader>
            <CardContent>
              {credQuery.isPending && <p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p>}
              {credentials?.public_keys.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('gateway:credentials.publicKeys.empty')}</p>
              )}
              {credentials?.public_keys.map(pk => (
                <PublicKeyRow key={pk.id} pk={pk} onDelete={handleDeleteKey} />
              ))}
            </CardContent>
          </Card>
          <AddPublicKeyDialog open={addKeyOpen} onOpenChange={setAddKeyOpen} />
        </TabsContent>

        <TabsContent value="otp" className="mt-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between pb-3">
              <CardTitle className="text-base">{t('gateway:credentials.otp.tab')}</CardTitle>
              <Button size="sm" variant="outline" onClick={() => setAddOtpOpen(true)}>
                <Plus className="size-4 mr-1" />
                {t('common:actions.add')}
              </Button>
            </CardHeader>
            <CardContent>
              {credQuery.isPending && <p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p>}
              {credentials?.otp.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('gateway:credentials.otp.empty')}</p>
              )}
              {credentials?.otp.map((otp, i) => (
                <OtpRow key={otp.id} otp={otp} index={i} onDelete={handleDeleteOtp} />
              ))}
            </CardContent>
          </Card>
          <AddOtpDialog open={addOtpOpen} onOpenChange={setAddOtpOpen} />
        </TabsContent>

        <TabsContent value="certificates" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t('gateway:credentials.certificates.tab')}</CardTitle>
            </CardHeader>
            <CardContent>
              {credQuery.isPending && <p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p>}
              {credentials?.certificates.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('gateway:credentials.certificates.empty')}</p>
              )}
              {credentials?.certificates.map(cert => (
                <CertificateRow key={cert.id} cert={cert} />
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
