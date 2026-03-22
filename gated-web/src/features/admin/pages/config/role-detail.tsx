import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams, useNavigate } from 'react-router'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import type { ColumnDef } from '@tanstack/react-table'
import { PageHeader } from '@/shared/components/page-header'
import { Button } from '@/shared/components/ui/button'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/shared/components/ui/form'
import { Input } from '@/shared/components/ui/input'
import { Textarea } from '@/shared/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { DataTable } from '@/shared/components/data-table'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import {
  useRoleQuery,
  useUpdateRoleMutation,
  useDeleteRoleMutation,
  useRoleUsersQuery,
  useRoleTargetsQuery,
} from '@/features/admin/api'
import type { User, Target } from '@/features/admin/lib/api-client'

const schema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

export function Component() {
  const { id } = useParams<{ id: string }>()
  const { t } = useTranslation(['admin', 'common'])
  const navigate = useNavigate()
  const [deleteOpen, setDeleteOpen] = useState(false)

  const { data: role, isLoading } = useRoleQuery(id!)
  const { data: users = [] } = useRoleUsersQuery(id!)
  const { data: targets = [] } = useRoleTargetsQuery(id!)
  const updateMutation = useUpdateRoleMutation()
  const deleteMutation = useDeleteRoleMutation()

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    values: role ? { name: role.name, description: role.description ?? '' } : undefined,
  })

  const onSubmit = async (values: FormValues) => {
    try {
      await updateMutation.mutateAsync({
        id: id!,
        req: { name: values.name, description: values.description },
      })
      toast.success(t('roles.updated'))
    } catch {
      toast.error(t('roles.updateError'))
    }
  }

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(id!)
      toast.success(t('roles.deleted'))
      navigate('..')
    } catch {
      toast.error(t('roles.deleteError'))
    }
  }

  const userColumns: ColumnDef<User>[] = [
    {
      accessorKey: 'username',
      header: t('roles.usernameColumn'),
    },
    {
      accessorKey: 'description',
      header: t('roles.descriptionColumn'),
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.description || '—'}</span>
      ),
    },
  ]

  const targetColumns: ColumnDef<Target>[] = [
    {
      accessorKey: 'name',
      header: t('roles.targetNameColumn'),
    },
    {
      id: 'kind',
      header: t('roles.targetKindColumn'),
      cell: ({ row }) => row.original.options.kind,
    },
    {
      accessorKey: 'description',
      header: t('roles.descriptionColumn'),
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.description || '—'}</span>
      ),
    },
  ]

  if (isLoading) {
    return <p className="text-muted-foreground">{t('actions.loading', { ns: 'common' })}</p>
  }

  if (!role) {
    return <p className="text-destructive">{t('roles.notFound')}</p>
  }

  return (
    <div>
      <PageHeader
        title={role.name}
        actions={
          <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="h-4 w-4 mr-2" />
            {t('actions.delete', { ns: 'common' })}
          </Button>
        }
      />

      <Tabs defaultValue="info">
        <TabsList>
          <TabsTrigger value="info">{t('roles.tabInfo')}</TabsTrigger>
          <TabsTrigger value="users">
            {t('roles.tabUsers')} ({users.length})
          </TabsTrigger>
          <TabsTrigger value="targets">
            {t('roles.tabTargets')} ({targets.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="info" className="mt-6">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 max-w-lg">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('roles.name')}</FormLabel>
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
                    <FormLabel>{t('roles.description')}</FormLabel>
                    <FormControl>
                      <Textarea {...field} rows={3} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex gap-3">
                <Button type="submit" disabled={updateMutation.isPending}>
                  {t('actions.save', { ns: 'common' })}
                </Button>
                <Button type="button" variant="outline" onClick={() => form.reset()}>
                  {t('roles.reset')}
                </Button>
              </div>
            </form>
          </Form>
        </TabsContent>

        <TabsContent value="users" className="mt-6">
          <DataTable
            columns={userColumns}
            data={users}
            searchPlaceholder={t('roles.searchUsers')}
          />
        </TabsContent>

        <TabsContent value="targets" className="mt-6">
          <DataTable
            columns={targetColumns}
            data={targets}
            searchPlaceholder={t('roles.searchTargets')}
          />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('roles.deleteTitle')}
        description={t('roles.deleteDescription')}
        confirmLabel={t('actions.delete', { ns: 'common' })}
        onConfirm={handleDelete}
      />
    </div>
  )
}
