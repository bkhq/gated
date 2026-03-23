import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useCreateTargetGroupMutation } from '@/features/admin/api'
import { type BootstrapThemeColor } from '@/features/admin/lib/api'
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
import { Card, CardContent } from '@/shared/components/ui/card'
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

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  color: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

export function Component() {
  const navigate = useNavigate()
  const createGroup = useCreateTargetGroupMutation()

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', description: '', color: '' },
  })

  async function onSubmit(values: FormValues) {
    try {
      const group = await createGroup.mutateAsync({
        name: values.name,
        description: values.description || undefined,
        color: (values.color as BootstrapThemeColor) || undefined,
      })
      toast.success(`Target group "${group.name}" created`)
      navigate(`/ui/admin/config/target-groups/${group.id}`)
    } catch {
      toast.error('Failed to create target group')
    }
  }

  return (
    <div className="max-w-lg">
      <PageHeader title="Create Target Group" description="Add a new target group" />

      <Card>
        <CardContent className="pt-6">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. production-servers" {...field} />
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
                      <Textarea placeholder="Optional description" rows={3} {...field} />
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
                          <SelectValue placeholder="Select a color (optional)" />
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

              <div className="flex gap-2 pt-2">
                <Button type="submit" disabled={createGroup.isPending}>
                  {createGroup.isPending ? 'Creating...' : 'Create Group'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => navigate('/ui/admin/config/target-groups')}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  )
}
