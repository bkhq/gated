import type { BootstrapThemeColor } from '@/features/admin/lib/api'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import { useCreateTargetGroupMutation } from '@/features/admin/api'
import { PageHeader } from '@/shared/components/page-header'
import { Button } from '@/shared/components/ui/button'
import { Card, CardContent } from '@/shared/components/ui/card'
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

export function Component() {
  const { t } = useTranslation(['admin', 'common'])
  const navigate = useNavigate()
  const createGroup = useCreateTargetGroupMutation()

  const schema = z.object({
    name: z.string().min(1, t('admin:targetGroups.form.nameRequired')),
    description: z.string().optional(),
    color: z.string().optional(),
  })

  type FormValues = z.infer<typeof schema>

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', description: '', color: '' },
  })

  async function onSubmit(values: FormValues) {
    try {
      const group = await createGroup.mutateAsync({
        name: values.name,
        description: values.description != null && values.description !== '' ? values.description : undefined,
        color: values.color != null && values.color !== '' ? (values.color as BootstrapThemeColor) : undefined,
      })
      toast.success(t('admin:targetGroups.created', { name: group.name }))
      void navigate(`/ui/admin/config/target-groups/${group.id}`)
    }
    catch {
      toast.error(t('admin:targetGroups.createError'))
    }
  }

  return (
    <div className="max-w-lg">
      <PageHeader title={t('admin:targetGroups.createTitle')} description={t('admin:targetGroups.createDescription')} />

      <Card>
        <CardContent className="pt-6">
          <Form {...form}>
            <form onSubmit={e => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('admin:targetGroups.form.name')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('admin:targetGroups.form.namePlaceholder')} {...field} />
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
                      <Textarea placeholder={t('admin:targetGroups.form.descriptionPlaceholder')} rows={3} {...field} />
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
                          <SelectValue placeholder={t('admin:targetGroups.form.colorSelectPlaceholder')} />
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
                  {createGroup.isPending ? t('admin:targetGroups.creating') : t('admin:targetGroups.createButton')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void navigate('/ui/admin/config/target-groups')}
                >
                  {t('admin:common.cancel')}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  )
}
