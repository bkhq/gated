import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { CheckCircle2, XCircle, Users, Download, Loader2 } from 'lucide-react'
import type { ColumnDef } from '@tanstack/react-table'
import { PageHeader } from '@/shared/components/page-header'
import { DataTable } from '@/shared/components/data-table'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Switch } from '@/shared/components/ui/switch'
import { Badge } from '@/shared/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Separator } from '@/shared/components/ui/separator'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/shared/components/ui/form'
import {
  useLdapServerQuery,
  useUpdateLdapServerMutation,
  useLdapUsersQuery,
  useTestLdapMutation,
  useImportLdapUsersMutation,
} from '@/features/admin/api'
import type { LdapUserResponse, TestLdapServerResponse } from '@/features/admin/lib/api-client'

const schema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.string().min(1),
  bind_dn: z.string().min(1),
  bind_password: z.string().optional(),
  user_filter: z.string(),
  tls_mode: z.enum(['Disabled', 'Preferred', 'Required'] as const),
  tls_verify: z.boolean(),
  enabled: z.boolean(),
  auto_link_sso_users: z.boolean(),
  description: z.string().optional(),
  username_attribute: z.enum(['Cn', 'Uid', 'Email', 'UserPrincipalName', 'SamAccountName'] as const),
  ssh_key_attribute: z.string(),
  uuid_attribute: z.string(),
})

type FormValues = z.infer<typeof schema>

export function Component() {
  const { id } = useParams<{ id: string }>()
  const { t } = useTranslation(['admin', 'common'])
  const navigate = useNavigate()

  const [testResult, setTestResult] = useState<TestLdapServerResponse | null>(null)
  const [usersEnabled, setUsersEnabled] = useState(false)
  const [selectedDns, setSelectedDns] = useState<Set<string>>(new Set())

  const { data: server, isLoading } = useLdapServerQuery(id!)
  const { data: ldapUsers = [], isFetching: loadingUsers } = useLdapUsersQuery(id!, usersEnabled)
  const updateMutation = useUpdateLdapServerMutation(id!)
  const testMutation = useTestLdapMutation()
  const importMutation = useImportLdapUsersMutation(id!)

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

  useEffect(() => {
    if (server) {
      form.reset({
        name: server.name,
        host: server.host,
        port: String(server.port),
        bind_dn: server.bind_dn,
        bind_password: '',
        user_filter: server.user_filter,
        tls_mode: server.tls_mode,
        tls_verify: server.tls_verify,
        enabled: server.enabled,
        auto_link_sso_users: server.auto_link_sso_users,
        description: server.description,
        username_attribute: server.username_attribute,
        ssh_key_attribute: server.ssh_key_attribute,
        uuid_attribute: server.uuid_attribute,
      })
    }
  }, [server, form])

  const onSubmit = async (values: FormValues) => {
    try {
      await updateMutation.mutateAsync({
        name: values.name,
        host: values.host,
        port: Number(values.port),
        bind_dn: values.bind_dn,
        bind_password: values.bind_password || undefined,
        user_filter: values.user_filter,
        tls_mode: values.tls_mode,
        tls_verify: values.tls_verify,
        enabled: values.enabled,
        auto_link_sso_users: values.auto_link_sso_users,
        description: values.description,
        username_attribute: values.username_attribute,
        ssh_key_attribute: values.ssh_key_attribute,
        uuid_attribute: values.uuid_attribute,
      })
      toast.success(t('ldap.updated'))
    }
    catch {
      toast.error(t('ldap.updateError'))
    }
  }

  const handleTest = async () => {
    const values = form.getValues()
    try {
      const result = await testMutation.mutateAsync({
        host: values.host,
        port: Number(values.port),
        bind_dn: values.bind_dn,
        bind_password: values.bind_password ?? '',
        tls_mode: values.tls_mode,
        tls_verify: values.tls_verify,
      })
      setTestResult(result)
    }
    catch {
      toast.error(t('ldap.test.error'))
    }
  }

  const handleImport = async () => {
    const dns = Array.from(selectedDns)
    if (dns.length === 0) {
      toast.warning(t('ldap.users.selectFirst'))
      return
    }
    try {
      const imported = await importMutation.mutateAsync({ dns })
      toast.success(t('ldap.users.importSuccess', { count: imported.length }))
      setSelectedDns(new Set())
    }
    catch {
      toast.error(t('ldap.users.importError'))
    }
  }

  const userColumns: ColumnDef<LdapUserResponse>[] = [
    {
      id: 'select',
      header: () => (
        <input
          type="checkbox"
          className="h-4 w-4 rounded border"
          checked={ldapUsers.length > 0 && selectedDns.size === ldapUsers.length}
          onChange={e => setSelectedDns(e.target.checked ? new Set(ldapUsers.map(u => u.dn)) : new Set())}
        />
      ),
      cell: ({ row }) => (
        <input
          type="checkbox"
          className="h-4 w-4 rounded border"
          checked={selectedDns.has(row.original.dn)}
          onChange={(e) => {
            const next = new Set(selectedDns)
            if (e.target.checked)
              next.add(row.original.dn)
            else
              next.delete(row.original.dn)
            setSelectedDns(next)
          }}
        />
      ),
    },
    {
      accessorKey: 'username',
      header: t('ldap.userColumns.username'),
    },
    {
      accessorKey: 'display_name',
      header: t('ldap.userColumns.displayName'),
      cell: ({ row }) => row.original.display_name ?? '—',
    },
    {
      accessorKey: 'email',
      header: t('ldap.userColumns.email'),
      cell: ({ row }) => row.original.email ?? '—',
    },
    {
      accessorKey: 'dn',
      header: t('ldap.userColumns.dn'),
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground truncate max-w-[200px] block">
          {row.original.dn}
        </span>
      ),
    },
  ]

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!server) {
    return (
      <div>
        <PageHeader title={t('pages.ldapServerDetail', { id })} />
        <p className="text-muted-foreground">{t('ldap.notFound')}</p>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title={server.name}
        actions={(
          <Badge variant={server.enabled ? 'default' : 'secondary'}>
            {server.enabled ? t('ldap.status.enabled') : t('ldap.status.disabled')}
          </Badge>
        )}
      />

      <div className="space-y-6 max-w-2xl">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            {/* Connection */}
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
                        <Input {...field} />
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
                            <Input {...field} />
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
                          <Input type="number" {...field} />
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
                        <Input {...field} value={field.value ?? ''} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            {/* Auth */}
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
                        <Input {...field} />
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
                      <FormLabel>
                        {t('ldap.fields.bindPassword')}
                        <span className="text-muted-foreground font-normal ml-1 text-xs">
                          {t('ldap.fields.bindPasswordHint')}
                        </span>
                      </FormLabel>
                      <FormControl>
                        <Input type="password" placeholder="••••••••" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            {/* Search */}
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
                        <Input {...field} />
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
                          <Input {...field} />
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
                          <Input {...field} />
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
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? t('common.saving') : t('common.save')}
              </Button>
              <Button type="button" variant="outline" onClick={() => navigate(-1)}>
                {t('actions.cancel', { ns: 'common' })}
              </Button>
            </div>
          </form>
        </Form>

        <Separator />

        {/* Connection Test */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{t('ldap.test.title')}</CardTitle>
              <Button variant="outline" onClick={handleTest} disabled={testMutation.isPending}>
                {testMutation.isPending
                  ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        {t('ldap.test.testing')}
                      </>
                    )
                  : t('ldap.test.run')}
              </Button>
            </div>
          </CardHeader>
          {testResult && (
            <CardContent>
              <div className={`flex items-start gap-3 p-3 rounded-md ${testResult.success ? 'bg-green-50 dark:bg-green-950' : 'bg-red-50 dark:bg-red-950'}`}>
                {testResult.success
                  ? <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0 mt-0.5" />
                  : <XCircle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />}
                <div className="space-y-2">
                  <p className={`text-sm font-medium ${testResult.success ? 'text-green-800 dark:text-green-200' : 'text-red-800 dark:text-red-200'}`}>
                    {testResult.message}
                  </p>
                  {testResult.base_dns && testResult.base_dns.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">{t('ldap.test.baseDns')}:</p>
                      <div className="flex flex-wrap gap-1">
                        {testResult.base_dns.map(dn => (
                          <Badge key={dn} variant="secondary" className="font-mono text-xs">
                            {dn}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          )}
        </Card>

        <Separator />

        {/* LDAP Users */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                {t('ldap.users.title')}
              </CardTitle>
              <div className="flex items-center gap-2">
                {usersEnabled && selectedDns.size > 0 && (
                  <Button
                    size="sm"
                    onClick={handleImport}
                    disabled={importMutation.isPending}
                  >
                    {importMutation.isPending
                      ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            {t('ldap.users.importing')}
                          </>
                        )
                      : (
                          <>
                            <Download className="h-4 w-4 mr-2" />
                            {t('ldap.users.import', { count: selectedDns.size })}
                          </>
                        )}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setUsersEnabled(true)}
                  disabled={loadingUsers}
                >
                  {loadingUsers
                    ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          {t('common.loading')}
                        </>
                      )
                    : t('ldap.users.load')}
                </Button>
              </div>
            </div>
          </CardHeader>
          {usersEnabled && (
            <CardContent>
              {ldapUsers.length === 0 && !loadingUsers
                ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      {t('ldap.users.empty')}
                    </p>
                  )
                : (
                    <DataTable
                      columns={userColumns}
                      data={ldapUsers}
                      searchPlaceholder={t('ldap.users.searchPlaceholder')}
                    />
                  )}
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  )
}
