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
import { CopyButton } from '@/shared/components/copy-button'
import { useApiTokensQuery, useCreateApiTokenMutation, useDeleteApiTokenMutation } from '@/features/gateway/api'
import type { ExistingApiToken } from '@/features/gateway/lib/api-client'

const createTokenSchema = z.object({
  label: z.string().min(1),
  expiryDays: z.coerce.number().int().min(1).max(365),
})
type CreateTokenForm = z.infer<typeof createTokenSchema>

function TokenRow({ token, onDelete }: { token: ExistingApiToken; onDelete: (id: string) => void }) {
  const { t } = useTranslation('gateway')
  return (
    <div className="flex items-center gap-2 py-3 border-b last:border-0">
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">{token.label}</p>
        <p className="text-xs text-muted-foreground">
          {t('apiTokens.created', { date: new Date(token.created).toLocaleDateString() })}
          {' · '}
          {t('apiTokens.expires', { date: new Date(token.expiry).toLocaleDateString() })}
        </p>
      </div>
      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive shrink-0" onClick={() => onDelete(token.id)}>
        <Trash2 className="size-4" />
      </Button>
    </div>
  )
}

function CreateTokenDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(['gateway', 'common'])
  const createToken = useCreateApiTokenMutation()
  const [newSecret, setNewSecret] = useState<string | null>(null)

  const form = useForm<CreateTokenForm>({
    resolver: zodResolver(createTokenSchema),
    defaultValues: { label: '', expiryDays: 30 },
  })

  async function onSubmit(values: CreateTokenForm) {
    const expiry = new Date()
    expiry.setDate(expiry.getDate() + values.expiryDays)
    try {
      const result = await createToken.mutateAsync({ label: values.label, expiry: expiry.toISOString() })
      setNewSecret(result.secret)
    } catch {
      toast.error(t('gateway:apiTokens.createError'))
    }
  }

  function handleClose() {
    setNewSecret(null)
    form.reset()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('gateway:apiTokens.createTitle')}</DialogTitle>
        </DialogHeader>

        {newSecret ? (
          <div className="space-y-4">
            <p className="text-sm font-medium text-amber-600 dark:text-amber-400">{t('gateway:apiTokens.secretWarning')}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-muted px-3 py-2 rounded font-mono break-all">{newSecret}</code>
              <CopyButton value={newSecret} label={t('common:actions.copy')} />
            </div>
            <DialogFooter>
              <Button onClick={handleClose}>{t('common:actions.close')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="label"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('gateway:apiTokens.label')}</FormLabel>
                    <FormControl><Input placeholder={t('gateway:apiTokens.labelPlaceholder')} {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="expiryDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('gateway:apiTokens.expiryDays')}</FormLabel>
                    <FormControl><Input type="number" min={1} max={365} {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={handleClose}>
                  {t('common:actions.cancel')}
                </Button>
                <Button type="submit" disabled={createToken.isPending}>
                  {createToken.isPending ? t('common:actions.loading') : t('gateway:apiTokens.create')}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function Component() {
  const { t } = useTranslation(['gateway', 'common'])
  const tokensQuery = useApiTokensQuery()
  const deleteToken = useDeleteApiTokenMutation()
  const [createOpen, setCreateOpen] = useState(false)

  const tokens = tokensQuery.data ?? []

  async function handleDelete(id: string) {
    try {
      await deleteToken.mutateAsync(id)
      toast.success(t('gateway:apiTokens.deleteSuccess'))
    } catch {
      toast.error(t('gateway:apiTokens.deleteError'))
    }
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-heading font-semibold">{t('gateway:pages.apiTokens')}</h1>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4 mr-1" />
          {t('gateway:apiTokens.create')}
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t('gateway:apiTokens.listTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {tokensQuery.isPending && <p className="text-sm text-muted-foreground">{t('common:actions.loading')}</p>}
          {tokensQuery.isSuccess && tokens.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('gateway:apiTokens.empty')}</p>
          )}
          {tokens.map(token => (
            <TokenRow key={token.id} token={token} onDelete={handleDelete} />
          ))}
        </CardContent>
      </Card>

      <CreateTokenDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}
