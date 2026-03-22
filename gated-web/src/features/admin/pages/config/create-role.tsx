import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { zodResolver } from '@hookform/resolvers/zod'
import { toast } from 'sonner'
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
import { useCreateRole } from '@/features/admin/api'

const schema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

export function Component() {
  const { t } = useTranslation(['admin', 'common'])
  const navigate = useNavigate()
  const createMutation = useCreateRole()

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', description: '' },
  })

  const onSubmit = async (values: FormValues) => {
    try {
      const role = await createMutation.mutateAsync({
        name: values.name,
        description: values.description,
      })
      toast.success(t('roles.created'))
      navigate(`../${role.id}`)
    } catch {
      toast.error(t('roles.createError'))
    }
  }

  return (
    <div>
      <PageHeader title={t('pages.createRole')} />

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 max-w-lg">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('roles.name')}</FormLabel>
                <FormControl>
                  <Input {...field} placeholder={t('roles.namePlaceholder')} />
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
                  <Textarea {...field} placeholder={t('roles.descriptionPlaceholder')} rows={3} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="flex gap-3">
            <Button type="submit" disabled={createMutation.isPending}>
              {t('actions.create', { ns: 'common' })}
            </Button>
            <Button type="button" variant="outline" onClick={() => navigate(-1)}>
              {t('actions.cancel', { ns: 'common' })}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  )
}
