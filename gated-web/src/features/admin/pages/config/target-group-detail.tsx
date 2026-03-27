import type { ColumnDef } from '@tanstack/react-table'
import type { BootstrapThemeColor, Target } from '@/features/admin/lib/api'
import { zodResolver } from '@hookform/resolvers/zod'
import { Layers, Server, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import {
  useDeleteTargetGroupMutation,
  useTargetGroupQuery,
  useTargetsByGroupQuery,
  useUpdateTargetGroupMutation,
} from '@/features/admin/api'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { DataTable } from '@/shared/components/data-table'
import { PageHeader } from '@/shared/components/page-header'
import { Badge } from '@/shared/components/ui/badge'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { Separator } from '@/shared/components/ui/separator'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { Textarea } from '@/shared/components/ui/textarea'

const COLORS: BootstrapThemeColor[] = [
  'Primary',
  'Secondary',
  'Success',
  'Danger',
  'Warning',
  'Info',
  'Light',
  'Dark',
]

const colorVariantMap: Record<string, string> = {
  Primary: 'bg-blue-500 text-white',
  Secondary: 'bg-gray-500 text-white',
  Success: 'bg-green-500 text-white',
  Danger: 'bg-red-500 text-white',
  Warning: 'bg-yellow-500 text-white',
  Info: 'bg-cyan-500 text-white',
  Light: 'bg-gray-100 text-gray-800',
  Dark: 'bg-gray-800 text-white',
}

interface FormValues {
  name: string
  description?: string
  color?: string
}

function EditForm({ groupId, defaultValues }: { groupId: string, defaultValues: FormValues }) {
  const { t } = useTranslation(['admin', 'common'])
  const updateGroup = useUpdateTargetGroupMutation()

  const schema = z.object({
    name: z.string().min(1, t('admin:targetGroups.form.nameRequired')),
    description: z.string().optional(),
    color: z.string().optional(),
  })

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues,
  })

  async function onSubmit(values: FormValues) {
    try {
      await updateGroup.mutateAsync({
        id: groupId,
        req: {
          name: values.name,
          description: values.description != null && values.description !== '' ? values.description : undefined,
          color: values.color != null && values.color !== '' ? (values.color as BootstrapThemeColor) : undefined,
        },
      })
      toast.success(t('admin:targetGroups.updated'))
    }
    catch {
      toast.error(t('admin:targetGroups.updateError'))
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={e => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('admin:targetGroups.form.name')}</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('admin:targetGroups.form.description')}</FormLabel>
              <FormControl>
                <Textarea rows={3} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="color"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('admin:targetGroups.form.color')}</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder={t('admin:targetGroups.form.colorPlaceholder')} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {COLORS.map(c => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="pt-2">
          <Button type="submit" disabled={updateGroup.isPending}>
            {updateGroup.isPending ? t('admin:targetGroups.saving') : t('admin:targetGroups.saveChanges')}
          </Button>
        </div>
      </form>
    </Form>
  )
}

function TargetsSection({ groupId }: { groupId: string }) {
  const { t } = useTranslation(['admin', 'common'])
  const { data: targets, isLoading } = useTargetsByGroupQuery(groupId)

  const columns: ColumnDef<Target>[] = [
    {
      accessorKey: 'name',
      header: t('admin:targetGroups.columns.name'),
      cell: ({ row }) => (
        <Link
          to={`/ui/admin/config/targets/${row.original.id}`}
          className="font-medium hover:underline flex items-center gap-2"
        >
          <Server className="h-4 w-4 text-muted-foreground shrink-0" />
          {row.original.name}
        </Link>
      ),
    },
    {
      accessorKey: 'description',
      header: t('admin:targetGroups.columns.description'),
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.description || '—'}</span>
      ),
    },
    {
      accessorKey: 'options.kind',
      header: t('admin:targetGroups.columns.type'),
      cell: ({ row }) => (
        <Badge variant="secondary">{row.original.options.kind}</Badge>
      ),
    },
  ]

  if (isLoading)
    return <Skeleton className="h-24 w-full" />

  if (!targets || targets.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-6">
        {t('admin:targetGroups.noTargets')}
      </p>
    )
  }

  return (
    <DataTable
      columns={columns}
      data={targets}
      searchPlaceholder={t('admin:targetGroups.searchTargets')}
    />
  )
}

export function Component() {
  const { t } = useTranslation(['admin', 'common'])
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data: group, isLoading } = useTargetGroupQuery(id!)
  const deleteGroup = useDeleteTargetGroupMutation()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  async function handleDelete() {
    if (!group)
      return
    try {
      await deleteGroup.mutateAsync(group.id)
      toast.success(t('admin:targetGroups.deleted', { name: group.name }))
      void navigate('/ui/admin/config/target-groups')
    }
    catch {
      toast.error(t('admin:targetGroups.deleteError'))
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

  if (!group) {
    return <p className="text-muted-foreground">{t('admin:targetGroups.notFound')}</p>
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={(
          <span className="flex items-center gap-2">
            {group.color != null && (
              <Badge className={colorVariantMap[group.color] ?? ''}>{group.color}</Badge>
            )}
            {group.name}
          </span>
        )}
        description={group.description || undefined}
        actions={(
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            {t('admin:targetGroups.deleteGroup')}
          </Button>
        )}
      />

      {/* Edit Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4" />
            {t('admin:targetGroups.groupSettings')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EditForm
            groupId={group.id}
            defaultValues={{
              name: group.name,
              description: group.description ?? '',
              color: group.color ?? '',
            }}
          />
        </CardContent>
      </Card>

      <Separator />

      {/* Targets in this group */}
      <div>
        <h2 className="text-lg font-semibold mb-4">{t('admin:targetGroups.associatedTargets')}</h2>
        <TargetsSection groupId={group.id} />
      </div>

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t('admin:targetGroups.deleteTitle', { name: group.name })}
        description={t('admin:targetGroups.deleteDescriptionDetail')}
        confirmLabel={t('admin:common.delete')}
        onConfirm={() => void handleDelete()}
      />
    </div>
  )
}
