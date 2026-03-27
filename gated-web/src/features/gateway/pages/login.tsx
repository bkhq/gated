import type { LoginFailureResponse } from '@/features/gateway/lib/api'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, ShieldCheck } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import { ResponseError, useLoginMutation, useSsoProvidersQuery, useStartSsoMutation } from '@/features/gateway/api'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/shared/components/ui/form'
import { Input } from '@/shared/components/ui/input'
import { Separator } from '@/shared/components/ui/separator'
import { useAuthStore } from '@/shared/stores/auth'

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

type LoginForm = z.infer<typeof loginSchema>

export function Component() {
  const { t } = useTranslation(['gateway', 'common'])
  const navigate = useNavigate()
  const location = useLocation()
  const setAuth = useAuthStore(s => s.setAuth)

  const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/ui'

  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
  })

  const loginMutation = useLoginMutation()
  const startSsoMutation = useStartSsoMutation()
  const ssoProvidersQuery = useSsoProvidersQuery()

  async function onSubmit(values: LoginForm) {
    try {
      await loginMutation.mutateAsync(values)
      setAuth(values.username, false)
      void navigate(from, { replace: true })
    }
    catch (err) {
      if (err instanceof ResponseError) {
        if (err.response.status === 401) {
          try {
            const body = await err.response.json() as LoginFailureResponse
            if (body.state === 'OtpNeeded') {
              void navigate('/ui/otp', { state: { username: values.username, from } })
              return
            }
          }
          catch {
            // ignore parse error
          }
        }
        toast.error(t('gateway:login.errors.invalid'))
      }
      else {
        toast.error(t('gateway:login.errors.failed'))
      }
    }
  }

  async function handleSso(name: string) {
    try {
      const result = await startSsoMutation.mutateAsync({ name, next: from })
      window.location.href = result.url
    }
    catch {
      toast.error(t('gateway:login.errors.ssoFailed'))
    }
  }

  const ssoProviders = ssoProvidersQuery.data ?? []

  return (
    <div className="flex items-center justify-center min-h-[70vh]">
      <Card className="w-full max-w-sm shadow-lg border-border/60">
        <CardHeader className="text-center pb-2">
          <div className="flex justify-center mb-3">
            <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <ShieldCheck className="size-6" />
            </div>
          </div>
          <CardTitle className="text-xl">{t('gateway:pages.login')}</CardTitle>
          <CardDescription>{t('gateway:login.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Form {...form}>
            <form onSubmit={e => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('gateway:login.username')}</FormLabel>
                    <FormControl>
                      <Input autoComplete="username" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('gateway:login.password')}</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="current-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" className="w-full cursor-pointer" disabled={loginMutation.isPending}>
                {loginMutation.isPending && <Loader2 className="size-4 mr-2 animate-spin" />}
                {loginMutation.isPending ? t('common:actions.loading') : t('gateway:login.submit')}
              </Button>
            </form>
          </Form>

          {ssoProviders.length > 0 && (
            <>
              <div className="flex items-center gap-2">
                <Separator className="flex-1" />
                <span className="text-xs text-muted-foreground">{t('gateway:login.ssoSection')}</span>
                <Separator className="flex-1" />
              </div>
              <div className="space-y-2">
                {ssoProviders.map(provider => (
                  <Button
                    key={provider.name}
                    variant="outline"
                    className="w-full cursor-pointer"
                    onClick={() => void handleSso(provider.name)}
                    disabled={startSsoMutation.isPending}
                  >
                    {startSsoMutation.isPending && <Loader2 className="size-4 mr-2 animate-spin" />}
                    {t('gateway:login.loginWith', { name: provider.label })}
                  </Button>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
