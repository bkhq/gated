import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import { useCreateLdapServerMutation } from '@/features/admin/api'
import { PageHeader } from '@/shared/components/page-header'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/components/ui/card'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/shared/components/ui/form'
import { Input } from '@/shared/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/components/ui/select'
import { Switch } from '@/shared/components/ui/switch'

const schema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.string().optional(),
  bind_dn: z.string().min(1),
  bind_password: z.string().min(1),
  user_filter: z.string().optional(),
  tls_mode: z.enum(['Disabled', 'Preferred', 'Required'] as const).optional(),
  tls_verify: z.boolean().optional(),
  enabled: z.boolean().optional(),
  auto_link_sso_users: z.boolean().optional(),
  description: z.string().optional(),
  username_attribute: z.enum(['Cn', 'Uid', 'Email', 'UserPrincipalName', 'SamAccountName'] as const).optional(),
  ssh_key_attribute: z.string().optional(),
  uuid_attribute: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

export function Component() {
  const { t } = useTranslation(['admin', 'common'])
  const navigate = useNavigate()
  const createMutation = useCreateLdapServerMutation()

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      host: '',
      port: '389',
      bind_dn: '',
      bind_password: '',
      user_filter: '(objectClass=person)',
      tls_mode: 'Preferred',
      tls_verify: true,
      enabled: true,
      auto_link_sso_users: false,
      description: '',
      username_attribute: 'Uid',
      ssh_key_attribute: 'sshPublicKey',
      uuid_attribute: 'entryUUID',
    },
  })

  const onSubmit = async (values: FormValues) => {
    try {
      const server = await createMutation.mutateAsync({
        ...values,
        port: values.port != null && values.port !== '' ? Number(values.port) : undefined,
      })
      toast.success(t('ldap.created'))
      void navigate(`../${server.id}`)
    }
    catch {
      toast.error(t('ldap.createError'))
    }
  }

  return (
    <div>
      <PageHeader title={t('pages.createLdapServer')} />

      <Form {...form}>
        <form onSubmit={e => void form.handleSubmit(onSubmit)(e)} className="space-y-6 max-w-2xl">
          {/* Connection Info */}
          <Card>
            <CardHeader>
              <CardTitle>{t('ldap.sections.connection')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('ldap.fields.name')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('ldap.placeholders.name')} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2">
                  <FormField
                    control={form.control}
                    name="host"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('ldap.fields.host')}</FormLabel>
                        <FormControl>
                          <Input placeholder="ldap.example.com" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="port"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('ldap.fields.port')}</FormLabel>
                      <FormControl>
                        <Input type="number" placeholder="389" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="tls_mode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('ldap.fields.tlsMode')}</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="Disabled">{t('ldap.tls.disabled')}</SelectItem>
                          <SelectItem value="Preferred">{t('ldap.tls.preferred')}</SelectItem>
                          <SelectItem value="Required">{t('ldap.tls.required')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="tls_verify"
                  render={({ field }) => (
                    <FormItem className="flex flex-col justify-end pb-2">
                      <div className="flex items-center gap-2">
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                        <FormLabel className="!mt-0">{t('ldap.fields.tlsVerify')}</FormLabel>
                      </div>
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('ldap.fields.description')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('ldap.placeholders.description')} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {/* Auth Info */}
          <Card>
            <CardHeader>
              <CardTitle>{t('ldap.sections.auth')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="bind_dn"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('ldap.fields.bindDn')}</FormLabel>
                    <FormControl>
                      <Input placeholder="cn=admin,dc=example,dc=com" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="bind_password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('ldap.fields.bindPassword')}</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="••••••••" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {/* Search Config */}
          <Card>
            <CardHeader>
              <CardTitle>{t('ldap.sections.search')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField
                control={form.control}
                name="user_filter"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('ldap.fields.userFilter')}</FormLabel>
                    <FormControl>
                      <Input placeholder="(objectClass=person)" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="username_attribute"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('ldap.fields.usernameAttribute')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="Cn">cn</SelectItem>
                        <SelectItem value="Uid">uid</SelectItem>
                        <SelectItem value="Email">email</SelectItem>
                        <SelectItem value="UserPrincipalName">userPrincipalName</SelectItem>
                        <SelectItem value="SamAccountName">sAMAccountName</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="ssh_key_attribute"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('ldap.fields.sshKeyAttribute')}</FormLabel>
                      <FormControl>
                        <Input placeholder="sshPublicKey" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="uuid_attribute"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('ldap.fields.uuidAttribute')}</FormLabel>
                      <FormControl>
                        <Input placeholder="entryUUID" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex items-center gap-6 pt-2">
                <FormField
                  control={form.control}
                  name="enabled"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-2">
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                      <FormLabel className="!mt-0">{t('ldap.fields.enabled')}</FormLabel>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="auto_link_sso_users"
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-2">
                      <FormControl>
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                      </FormControl>
                      <FormLabel className="!mt-0">{t('ldap.fields.autoLinkSso')}</FormLabel>
                    </FormItem>
                  )}
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex gap-3">
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? t('common.saving') : t('actions.create', { ns: 'common' })}
            </Button>
            <Button type="button" variant="outline" onClick={() => void navigate(-1)}>
              {t('actions.cancel', { ns: 'common' })}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  )
}
