import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel } from '@/shared/components/ui/form'
import { Input } from '@/shared/components/ui/input'
import { Switch } from '@/shared/components/ui/switch'
import { PageHeader } from '@/shared/components/page-header'
import { useParametersQuery, useUpdateParametersMutation } from '@/features/admin/api'
import type { ParameterUpdate } from '@/features/admin/lib/api'

export function Component() {
  const { t } = useTranslation(['admin', 'common'])

  const parametersQuery = useParametersQuery()
  const updateMutation = useUpdateParametersMutation()

  const form = useForm<ParameterUpdate>({
    defaultValues: {
      allow_own_credential_management: false,
      minimize_password_login: false,
      ssh_client_auth_publickey: true,
      ssh_client_auth_password: true,
      ssh_client_auth_keyboard_interactive: true,
      rate_limit_bytes_per_second: undefined,
    },
  })

  useEffect(() => {
    if (parametersQuery.data) {
      form.reset({
        allow_own_credential_management: parametersQuery.data.allow_own_credential_management,
        minimize_password_login: parametersQuery.data.minimize_password_login,
        ssh_client_auth_publickey: parametersQuery.data.ssh_client_auth_publickey,
        ssh_client_auth_password: parametersQuery.data.ssh_client_auth_password,
        ssh_client_auth_keyboard_interactive: parametersQuery.data.ssh_client_auth_keyboard_interactive,
        rate_limit_bytes_per_second: parametersQuery.data.rate_limit_bytes_per_second ?? undefined,
      })
    }
  }, [parametersQuery.data, form])

  async function onSubmit(values: ParameterUpdate) {
    try {
      await updateMutation.mutateAsync({
        ...values,
        rate_limit_bytes_per_second: values.rate_limit_bytes_per_second
          ? Number(values.rate_limit_bytes_per_second)
          : undefined,
      })
      toast.success(t('admin:parameters.saved'))
    } catch {
      toast.error(t('admin:parameters.saveFailed'))
    }
  }

  if (parametersQuery.isLoading) {
    return (
      <div className="text-muted-foreground text-sm">{t('common:actions.loading')}</div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('admin:pages.parameters')}
        description={t('admin:parameters.description')}
      />

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          {/* Access Control */}
          <Card>
            <CardHeader>
              <CardTitle>{t('admin:parameters.sections.accessControl')}</CardTitle>
              <CardDescription>{t('admin:parameters.sections.accessControlDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="allow_own_credential_management"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel>{t('admin:parameters.fields.allowOwnCredentialManagement')}</FormLabel>
                      <FormDescription>{t('admin:parameters.fields.allowOwnCredentialManagementDesc')}</FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="minimize_password_login"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel>{t('admin:parameters.fields.minimizePasswordLogin')}</FormLabel>
                      <FormDescription>{t('admin:parameters.fields.minimizePasswordLoginDesc')}</FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {/* SSH Client Authentication */}
          <Card>
            <CardHeader>
              <CardTitle>{t('admin:parameters.sections.sshClientAuth')}</CardTitle>
              <CardDescription>{t('admin:parameters.sections.sshClientAuthDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="ssh_client_auth_publickey"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel>{t('admin:parameters.fields.sshClientAuthPublickey')}</FormLabel>
                      <FormDescription>{t('admin:parameters.fields.sshClientAuthPublickeyDesc')}</FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="ssh_client_auth_password"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel>{t('admin:parameters.fields.sshClientAuthPassword')}</FormLabel>
                      <FormDescription>{t('admin:parameters.fields.sshClientAuthPasswordDesc')}</FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="ssh_client_auth_keyboard_interactive"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border p-4">
                    <div className="space-y-0.5">
                      <FormLabel>{t('admin:parameters.fields.sshClientAuthKeyboardInteractive')}</FormLabel>
                      <FormDescription>{t('admin:parameters.fields.sshClientAuthKeyboardInteractiveDesc')}</FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {/* Network */}
          <Card>
            <CardHeader>
              <CardTitle>{t('admin:parameters.sections.network')}</CardTitle>
              <CardDescription>{t('admin:parameters.sections.networkDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="rate_limit_bytes_per_second"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('admin:parameters.fields.rateLimitBytesPerSecond')}</FormLabel>
                    <FormDescription>{t('admin:parameters.fields.rateLimitBytesPerSecondDesc')}</FormDescription>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        placeholder={t('admin:parameters.fields.rateLimitPlaceholder')}
                        value={field.value ?? ''}
                        onChange={(e) => {
                          const val = e.target.value
                          field.onChange(val === '' ? undefined : Number(val))
                        }}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? t('common:actions.loading') : t('common:actions.save')}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  )
}
