import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import { useCreateUser } from '@/features/admin/api'
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
import { Textarea } from '@/shared/components/ui/textarea'

const schema = z.object({
  username: z.string().min(1, 'Username is required'),
  description: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

export function Component() {
  const { t } = useTranslation(['admin', 'common'])
  const tc = (key: string) => t(key, { ns: 'common' })
  const navigate = useNavigate()
  const createUser = useCreateUser()

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { username: '', description: '' },
  })

  async function onSubmit(values: FormValues) {
    try {
      const user = await createUser.mutateAsync({
        username: values.username,
        description: values.description != null && values.description !== '' ? values.description : undefined,
      })
      toast.success(t('users.created'))
      void navigate(`/ui/admin/config/users/${user.id}`)
    }
    catch {
      toast.error(t('users.createError'))
    }
  }

  return (
    <div className="max-w-lg">
      <PageHeader title={t('users.create')} description={t('users.createDescription')} />

      <Card>
        <CardContent className="pt-6">
          <Form {...form}>
            <form onSubmit={e => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('users.fields.username')}</FormLabel>
                    <FormControl>
                      <Input placeholder={t('users.fields.usernamePlaceholder')} {...field} />
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
                    <FormLabel>{t('users.fields.description')}</FormLabel>
                    <FormControl>
                      <Textarea placeholder={t('users.fields.descriptionPlaceholder')} rows={3} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex gap-2 pt-2">
                <Button type="submit" disabled={createUser.isPending}>
                  {createUser.isPending ? tc('actions.loading') : t('users.create')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void navigate('/ui/admin/config/users')}
                >
                  {tc('actions.cancel')}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  )
}
