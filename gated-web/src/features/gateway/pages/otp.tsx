import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import { ResponseError, useOtpLoginMutation } from '@/features/gateway/api'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/shared/components/ui/form'
import { Input } from '@/shared/components/ui/input'
import { useAuthStore } from '@/shared/stores/auth'

const otpSchema = z.object({
  otp: z.string().min(6).max(8),
})

type OtpForm = z.infer<typeof otpSchema>

export function Component() {
  const { t } = useTranslation(['gateway', 'common'])
  const navigate = useNavigate()
  const location = useLocation()
  const setAuth = useAuthStore(s => s.setAuth)

  const state = location.state as { username?: string, from?: string } | null
  const username = state?.username ?? ''
  const from = state?.from ?? '/ui'

  const form = useForm<OtpForm>({
    resolver: zodResolver(otpSchema),
    defaultValues: { otp: '' },
  })

  const otpMutation = useOtpLoginMutation()

  async function onSubmit(values: OtpForm) {
    try {
      await otpMutation.mutateAsync(values)
      if (username)
        setAuth(username, false)
      void navigate(from, { replace: true })
    }
    catch (err) {
      if (err instanceof ResponseError && err.response.status === 401) {
        toast.error(t('gateway:otp.errors.invalid'))
        form.reset()
      }
      else {
        toast.error(t('gateway:otp.errors.failed'))
      }
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('gateway:otp.title')}</CardTitle>
          <CardDescription>{t('gateway:otp.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Form {...form}>
            <form onSubmit={e => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
              <FormField
                control={form.control}
                name="otp"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('gateway:otp.code')}</FormLabel>
                    <FormControl>
                      <Input
                        autoComplete="one-time-code"
                        inputMode="numeric"
                        maxLength={8}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" className="w-full" disabled={otpMutation.isPending}>
                {otpMutation.isPending ? t('common:actions.loading') : t('gateway:otp.submit')}
              </Button>
            </form>
          </Form>
          <Button variant="ghost" size="sm" className="w-full" render={<Link to="/ui/login" />}>
            {t('gateway:otp.back')}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
