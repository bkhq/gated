import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import { KeyRound, Coins } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/shared/components/ui/form'
import { Input } from '@/shared/components/ui/input'
import { Separator } from '@/shared/components/ui/separator'
import { useInfoQuery, useChangePasswordMutation } from '@/features/gateway/api'

const changePasswordSchema = z.object({
  password: z.string().min(1),
  confirm: z.string().min(1),
}).refine(d => d.password === d.confirm, {
  message: 'profile.changePassword.errors.mismatch',
  path: ['confirm'],
})

type ChangePasswordForm = z.infer<typeof changePasswordSchema>

export function Component() {
  const { t } = useTranslation(['gateway', 'common'])
  const infoQuery = useInfoQuery()
  const changePasswordMutation = useChangePasswordMutation()

  const form = useForm<ChangePasswordForm>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { password: '', confirm: '' },
  })

  async function onSubmit(values: ChangePasswordForm) {
    try {
      await changePasswordMutation.mutateAsync(values.password)
      form.reset()
      toast.success(t('gateway:profile.changePassword.success'))
    } catch {
      toast.error(t('gateway:profile.changePassword.error'))
    }
  }

  const username = infoQuery.data?.username

  return (
    <div className="space-y-8 max-w-xl">
      <div>
        <h1 className="text-2xl font-heading font-semibold">{t('gateway:pages.profile')}</h1>
        {username && (
          <p className="text-muted-foreground mt-1">{t('gateway:profile.loggedInAs', { username })}</p>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('gateway:profile.changePassword.title')}</CardTitle>
          <CardDescription>{t('gateway:profile.changePassword.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('gateway:profile.changePassword.newPassword')}</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="confirm"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('gateway:profile.changePassword.confirmPassword')}</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={changePasswordMutation.isPending}>
                {changePasswordMutation.isPending
                  ? t('common:actions.loading')
                  : t('gateway:profile.changePassword.submit')}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      <Separator />

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">{t('gateway:profile.securitySection')}</h2>
        <div className="flex flex-col gap-2">
          <Button asChild variant="outline" className="justify-start gap-2 w-fit">
            <Link to="/@gated/ui/profile/credentials">
              <KeyRound className="size-4" />
              {t('gateway:pages.credentials')}
            </Link>
          </Button>
          <Button asChild variant="outline" className="justify-start gap-2 w-fit">
            <Link to="/@gated/ui/profile/api-tokens">
              <Coins className="size-4" />
              {t('gateway:pages.apiTokens')}
            </Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
