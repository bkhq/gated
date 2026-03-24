import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/shared/components/ui/form'
import { Input } from '@/shared/components/ui/input'
import { Button } from '@/shared/components/ui/button'
import { Switch } from '@/shared/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { Loader2 } from 'lucide-react'
import type { Target, TargetDataRequest, TargetGroup } from '@/features/admin/lib/api'

// ── Schema ────────────────────────────────────────────────────────────────────

export const formSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string(),
  group_id: z.string(),
  rate_limit: z.string(),

  target_type: z.enum(['Ssh', 'Kubernetes', 'MySql', 'Postgres', 'WebAdmin', 'Api']),

  // SSH
  ssh_host: z.string(),
  ssh_port: z.string(),
  ssh_username: z.string(),
  ssh_allow_insecure_algos: z.boolean(),
  ssh_auth_type: z.enum(['Password', 'PublicKey']),
  ssh_password: z.string(),

  // Kubernetes
  k8s_cluster_url: z.string(),
  k8s_tls_mode: z.enum(['Disabled', 'Preferred', 'Required']),
  k8s_tls_verify: z.boolean(),
  k8s_auth_type: z.enum(['Token', 'Certificate']),
  k8s_token: z.string(),
  k8s_certificate: z.string(),
  k8s_private_key: z.string(),

  // MySQL
  mysql_host: z.string(),
  mysql_port: z.string(),
  mysql_username: z.string(),
  mysql_password: z.string(),
  mysql_tls_mode: z.enum(['Disabled', 'Preferred', 'Required']),
  mysql_tls_verify: z.boolean(),
  mysql_default_database: z.string(),

  // Postgres
  pg_host: z.string(),
  pg_port: z.string(),
  pg_username: z.string(),
  pg_password: z.string(),
  pg_tls_mode: z.enum(['Disabled', 'Preferred', 'Required']),
  pg_tls_verify: z.boolean(),
  pg_idle_timeout: z.string(),
  pg_default_database: z.string(),

  // API
  api_url: z.string(),
  api_tls_mode: z.enum(['Disabled', 'Preferred', 'Required']),
  api_tls_verify: z.boolean(),
})

export type FormValues = z.infer<typeof formSchema>

// ── Defaults ──────────────────────────────────────────────────────────────────

export const EMPTY_DEFAULTS: FormValues = {
  name: '',
  description: '',
  group_id: '',
  rate_limit: '',
  target_type: 'Ssh',
  ssh_host: '',
  ssh_port: '22',
  ssh_username: '',
  ssh_allow_insecure_algos: false,
  ssh_auth_type: 'PublicKey',
  ssh_password: '',
  k8s_cluster_url: '',
  k8s_tls_mode: 'Required',
  k8s_tls_verify: true,
  k8s_auth_type: 'Token',
  k8s_token: '',
  k8s_certificate: '',
  k8s_private_key: '',
  mysql_host: '',
  mysql_port: '3306',
  mysql_username: '',
  mysql_password: '',
  mysql_tls_mode: 'Preferred',
  mysql_tls_verify: true,
  mysql_default_database: '',
  pg_host: '',
  pg_port: '5432',
  pg_username: '',
  pg_password: '',
  pg_tls_mode: 'Preferred',
  pg_tls_verify: true,
  pg_idle_timeout: '',
  pg_default_database: '',
  api_url: '',
  api_tls_mode: 'Preferred',
  api_tls_verify: true,
}

// ── Converter: Target → FormValues ─────────────────────────────────────────────

export function targetToFormValues(target: Target): FormValues {
  const opts = target.options
  const base: FormValues = {
    ...EMPTY_DEFAULTS,
    name: target.name,
    description: target.description ?? '',
    group_id: target.group_id ?? '',
    rate_limit: target.rate_limit_bytes_per_second?.toString() ?? '',
    target_type: opts.kind,
  }

  switch (opts.kind) {
    case 'Ssh':
      return {
        ...base,
        ssh_host: opts.host,
        ssh_port: opts.port.toString(),
        ssh_username: opts.username,
        ssh_allow_insecure_algos: opts.allow_insecure_algos ?? false,
        ssh_auth_type: opts.auth.kind,
        ssh_password: opts.auth.kind === 'Password' ? opts.auth.password : '',
      }
    case 'Kubernetes':
      return {
        ...base,
        k8s_cluster_url: opts.cluster_url,
        k8s_tls_mode: opts.tls.mode,
        k8s_tls_verify: opts.tls.verify,
        k8s_auth_type: opts.auth.kind,
        k8s_token: opts.auth.kind === 'Token' ? opts.auth.token : '',
        k8s_certificate: opts.auth.kind === 'Certificate' ? opts.auth.certificate : '',
        k8s_private_key: opts.auth.kind === 'Certificate' ? opts.auth.private_key : '',
      }
    case 'MySql':
      return {
        ...base,
        mysql_host: opts.host,
        mysql_port: opts.port.toString(),
        mysql_username: opts.username,
        mysql_password: opts.password ?? '',
        mysql_tls_mode: opts.tls.mode,
        mysql_tls_verify: opts.tls.verify,
        mysql_default_database: opts.default_database_name ?? '',
      }
    case 'Postgres':
      return {
        ...base,
        pg_host: opts.host,
        pg_port: opts.port.toString(),
        pg_username: opts.username,
        pg_password: opts.password ?? '',
        pg_tls_mode: opts.tls.mode,
        pg_tls_verify: opts.tls.verify,
        pg_idle_timeout: opts.idle_timeout ?? '',
        pg_default_database: opts.default_database_name ?? '',
      }
    case 'WebAdmin':
      return base
    case 'Api':
      return {
        ...base,
        api_url: opts.url,
        api_tls_mode: opts.tls.mode,
        api_tls_verify: opts.tls.verify,
      }
  }
}

// ── Converter: FormValues → TargetDataRequest ─────────────────────────────────

export function buildRequest(values: FormValues): TargetDataRequest {
  const base = {
    name: values.name,
    description: values.description || undefined,
    group_id: (values.group_id && values.group_id !== '__none__') ? values.group_id : undefined,
    rate_limit_bytes_per_second: values.rate_limit ? parseInt(values.rate_limit, 10) : undefined,
  }

  switch (values.target_type) {
    case 'Ssh':
      return {
        ...base,
        options: {
          kind: 'Ssh',
          host: values.ssh_host,
          port: parseInt(values.ssh_port, 10) || 22,
          username: values.ssh_username,
          allow_insecure_algos: values.ssh_allow_insecure_algos || undefined,
          auth:
            values.ssh_auth_type === 'Password'
              ? { kind: 'Password', password: values.ssh_password }
              : { kind: 'PublicKey' },
        },
      }
    case 'Kubernetes':
      return {
        ...base,
        options: {
          kind: 'Kubernetes',
          cluster_url: values.k8s_cluster_url,
          tls: { mode: values.k8s_tls_mode, verify: values.k8s_tls_verify },
          auth:
            values.k8s_auth_type === 'Token'
              ? { kind: 'Token', token: values.k8s_token }
              : {
                  kind: 'Certificate',
                  certificate: values.k8s_certificate,
                  private_key: values.k8s_private_key,
                },
        },
      }
    case 'MySql':
      return {
        ...base,
        options: {
          kind: 'MySql',
          host: values.mysql_host,
          port: parseInt(values.mysql_port, 10) || 3306,
          username: values.mysql_username,
          password: values.mysql_password || undefined,
          tls: { mode: values.mysql_tls_mode, verify: values.mysql_tls_verify },
          default_database_name: values.mysql_default_database || undefined,
        },
      }
    case 'Postgres':
      return {
        ...base,
        options: {
          kind: 'Postgres',
          host: values.pg_host,
          port: parseInt(values.pg_port, 10) || 5432,
          username: values.pg_username,
          password: values.pg_password || undefined,
          tls: { mode: values.pg_tls_mode, verify: values.pg_tls_verify },
          idle_timeout: values.pg_idle_timeout || undefined,
          default_database_name: values.pg_default_database || undefined,
        },
      }
    case 'WebAdmin':
      return { ...base, options: { kind: 'WebAdmin' } }
    case 'Api':
      return {
        ...base,
        options: {
          kind: 'Api',
          url: values.api_url,
          tls: { mode: values.api_tls_mode, verify: values.api_tls_verify },
          headers: {},
        },
      }
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useTargetForm(defaultValues: FormValues) {
  return useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues,
  })
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function TlsFields({
  form,
  prefix,
}: {
  form: ReturnType<typeof useTargetForm>
  prefix: 'k8s' | 'mysql' | 'pg' | 'api'
}) {
  const modeField = `${prefix}_tls_mode` as const
  const verifyField = `${prefix}_tls_verify` as const

  return (
    <div className="grid grid-cols-2 gap-4">
      <FormField
        control={form.control}
        name={modeField}
        render={({ field }) => (
          <FormItem>
            <FormLabel>TLS Mode</FormLabel>
            <Select onValueChange={field.onChange} value={field.value}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="Disabled">Disabled</SelectItem>
                <SelectItem value="Preferred">Preferred</SelectItem>
                <SelectItem value="Required">Required</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name={verifyField}
        render={({ field }) => (
          <FormItem className="flex flex-row items-center gap-3 space-y-0 pt-8">
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
            <FormLabel className="font-normal">Verify TLS</FormLabel>
          </FormItem>
        )}
      />
    </div>
  )
}

// ── Main Form Fields Component ─────────────────────────────────────────────────

interface TargetFormFieldsProps {
  form: ReturnType<typeof useTargetForm>
  groups: TargetGroup[]
  typeReadOnly?: boolean
}

export function TargetFormFields({ form, groups, typeReadOnly = false }: TargetFormFieldsProps) {
  const targetType = form.watch('target_type')
  const sshAuthType = form.watch('ssh_auth_type')
  const k8sAuthType = form.watch('k8s_auth_type')

  return (
    <div className="space-y-6">
      {/* Common fields */}
      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="target_type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Type</FormLabel>
              <Select
                onValueChange={field.onChange}
                value={field.value}
                disabled={typeReadOnly}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="Ssh">SSH</SelectItem>
                  <SelectItem value="Kubernetes">Kubernetes</SelectItem>
                  <SelectItem value="MySql">MySQL</SelectItem>
                  <SelectItem value="Postgres">PostgreSQL</SelectItem>
                  <SelectItem value="WebAdmin">Web Admin</SelectItem>
                  <SelectItem value="Api">API</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input placeholder="my-server" {...field} />
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
            <FormControl>
              <Input placeholder="Optional description" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="group_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Group</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="No group" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="__none__">No group</SelectItem>
                  {groups.map(g => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="rate_limit"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Rate Limit (bytes/s)</FormLabel>
              <FormControl>
                <Input placeholder="Unlimited" type="number" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      {/* SSH fields */}
      {targetType === 'Ssh' && (
        <div className="space-y-4 rounded-md border p-4">
          <h3 className="font-medium text-sm">SSH Connection</h3>
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="ssh_host"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Host</FormLabel>
                  <FormControl>
                    <Input placeholder="192.168.1.1" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="ssh_port"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Port</FormLabel>
                  <FormControl>
                    <Input type="number" placeholder="22" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <FormField
            control={form.control}
            name="ssh_username"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Username</FormLabel>
                <FormControl>
                  <Input placeholder="root" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="ssh_allow_insecure_algos"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center gap-3 space-y-0">
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
                <FormLabel className="font-normal">Allow insecure algorithms</FormLabel>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="ssh_auth_type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Authentication</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="PublicKey">Public Key</SelectItem>
                    <SelectItem value="Password">Password</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          {sshAuthType === 'Password' && (
            <FormField
              control={form.control}
              name="ssh_password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
                  <FormControl>
                    <Input type="password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </div>
      )}

      {/* Kubernetes fields */}
      {targetType === 'Kubernetes' && (
        <div className="space-y-4 rounded-md border p-4">
          <h3 className="font-medium text-sm">Kubernetes Connection</h3>
          <FormField
            control={form.control}
            name="k8s_cluster_url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Cluster URL</FormLabel>
                <FormControl>
                  <Input placeholder="https://kubernetes.example.com:6443" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <TlsFields form={form} prefix="k8s" />
          <FormField
            control={form.control}
            name="k8s_auth_type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Authentication</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="Token">Token</SelectItem>
                    <SelectItem value="Certificate">Certificate</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          {k8sAuthType === 'Token' && (
            <FormField
              control={form.control}
              name="k8s_token"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Token</FormLabel>
                  <FormControl>
                    <Input type="password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
          {k8sAuthType === 'Certificate' && (
            <div className="space-y-4">
              <FormField
                control={form.control}
                name="k8s_certificate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Certificate (PEM)</FormLabel>
                    <FormControl>
                      <Input placeholder="-----BEGIN CERTIFICATE-----" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="k8s_private_key"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Private Key (PEM)</FormLabel>
                    <FormControl>
                      <Input type="password" placeholder="-----BEGIN PRIVATE KEY-----" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          )}
        </div>
      )}

      {/* MySQL fields */}
      {targetType === 'MySql' && (
        <div className="space-y-4 rounded-md border p-4">
          <h3 className="font-medium text-sm">MySQL Connection</h3>
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="mysql_host"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Host</FormLabel>
                  <FormControl>
                    <Input placeholder="db.example.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="mysql_port"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Port</FormLabel>
                  <FormControl>
                    <Input type="number" placeholder="3306" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="mysql_username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Username</FormLabel>
                  <FormControl>
                    <Input placeholder="root" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="mysql_password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
                  <FormControl>
                    <Input type="password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <TlsFields form={form} prefix="mysql" />
          <FormField
            control={form.control}
            name="mysql_default_database"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Default Database</FormLabel>
                <FormControl>
                  <Input placeholder="Optional" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      )}

      {/* Postgres fields */}
      {targetType === 'Postgres' && (
        <div className="space-y-4 rounded-md border p-4">
          <h3 className="font-medium text-sm">PostgreSQL Connection</h3>
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="pg_host"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Host</FormLabel>
                  <FormControl>
                    <Input placeholder="db.example.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="pg_port"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Port</FormLabel>
                  <FormControl>
                    <Input type="number" placeholder="5432" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="pg_username"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Username</FormLabel>
                  <FormControl>
                    <Input placeholder="postgres" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="pg_password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
                  <FormControl>
                    <Input type="password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <TlsFields form={form} prefix="pg" />
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="pg_default_database"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Default Database</FormLabel>
                  <FormControl>
                    <Input placeholder="Optional" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="pg_idle_timeout"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Idle Timeout</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. 30s" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>
      )}

      {/* API fields */}
      {targetType === 'Api' && (
        <div className="space-y-4 rounded-md border p-4">
          <h3 className="font-medium text-sm">API Connection</h3>
          <FormField
            control={form.control}
            name="api_url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>URL</FormLabel>
                <FormControl>
                  <Input placeholder="https://api.example.com" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <TlsFields form={form} prefix="api" />
        </div>
      )}

      {/* WebAdmin: no extra fields needed */}
    </div>
  )
}

// ── Form Wrapper ───────────────────────────────────────────────────────────────

interface TargetFormProps {
  defaultValues: FormValues
  groups: TargetGroup[]
  onSubmit: (values: FormValues) => void
  isSubmitting?: boolean
  submitLabel?: string
  typeReadOnly?: boolean
}

export function TargetForm({
  defaultValues,
  groups,
  onSubmit,
  isSubmitting,
  submitLabel = 'Save',
  typeReadOnly,
}: TargetFormProps) {
  const form = useTargetForm(defaultValues)

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <TargetFormFields form={form} groups={groups} typeReadOnly={typeReadOnly} />
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {submitLabel}
        </Button>
      </form>
    </Form>
  )
}
