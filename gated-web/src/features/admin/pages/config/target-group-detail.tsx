import { useState } from 'react'
import { useParams, useNavigate } from 'react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Layers, Server, Trash2 } from 'lucide-react'
import { Link } from 'react-router'
import { type ColumnDef } from '@tanstack/react-table'
import {
  useTargetGroupQuery,
  useUpdateTargetGroupMutation,
  useDeleteTargetGroupMutation,
  useTargetsByGroupQuery,
} from '@/features/admin/api'
import { type BootstrapThemeColor, type Target } from '@/features/admin/lib/api'
import { PageHeader } from '@/shared/components/page-header'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { DataTable } from '@/shared/components/data-table'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { Separator } from '@/shared/components/ui/separator'
import { Badge } from '@/shared/components/ui/badge'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'

const COLORS: BootstrapThemeColor[] = [
  'Primary', 'Secondary', 'Success', 'Danger', 'Warning', 'Info', 'Light', 'Dark',
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

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  color: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

function EditForm({ groupId, defaultValues }: { groupId: string; defaultValues: FormValues }) {
  const updateGroup = useUpdateTargetGroupMutation()

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
          description: values.description || undefined,
          color: (values.color as BootstrapThemeColor) || undefined,
        },
      })
      toast.success('Target group updated')
    } catch {
      toast.error('Failed to update target group')
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
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
              <FormLabel>Description</FormLabel>
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
              <FormLabel>Color</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="No color" />
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
            {updateGroup.isPending ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </form>
    </Form>
  )
}

function TargetsSection({ groupId }: { groupId: string }) {
  const { data: targets, isLoading } = useTargetsByGroupQuery(groupId)

  const columns: ColumnDef<Target>[] = [
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }) => (
        <Link
          to={`/@gated/admin/config/targets/${row.original.id}`}
          className="font-medium hover:underline flex items-center gap-2"
        >
          <Server className="h-4 w-4 text-muted-foreground shrink-0" />
          {row.original.name}
        </Link>
      ),
    },
    {
      accessorKey: 'description',
      header: 'Description',
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.description || '—'}</span>
      ),
    },
    {
      accessorKey: 'options.kind',
      header: 'Type',
      cell: ({ row }) => (
        <Badge variant="secondary">{row.original.options.kind}</Badge>
      ),
    },
  ]

  if (isLoading) return <Skeleton className="h-24 w-full" />

  if (!targets || targets.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-6">
        No targets in this group.
      </p>
    )
  }

  return (
    <DataTable
      columns={columns}
      data={targets}
      searchPlaceholder="Search targets..."
    />
  )
}

export function Component() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data: group, isLoading } = useTargetGroupQuery(id!)
  const deleteGroup = useDeleteTargetGroupMutation()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  async function handleDelete() {
    if (!group) return
    try {
      await deleteGroup.mutateAsync(group.id)
      toast.success(`Target group "${group.name}" deleted`)
      navigate('/@gated/admin/config/target-groups')
    } catch {
      toast.error('Failed to delete target group')
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
    return <p className="text-muted-foreground">Target group not found.</p>
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {group.color && (
              <Badge className={colorVariantMap[group.color] ?? ''}>{group.color}</Badge>
            )}
            {group.name}
          </span>
        }
        description={group.description || undefined}
        actions={
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete Group
          </Button>
        }
      />

      {/* Edit Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4" />
            Group Settings
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
        <h2 className="text-lg font-semibold mb-4">Associated Targets</h2>
        <TargetsSection groupId={group.id} />
      </div>

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={`Delete group "${group.name}"?`}
        description="This will permanently delete the target group. Targets in this group will not be deleted."
        confirmLabel="Delete"
        onConfirm={handleDelete}
      />
    </div>
  )
}
