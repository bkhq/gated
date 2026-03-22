import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { AlertTriangle, ArrowLeft, KeyRound } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Textarea } from '@/shared/components/ui/textarea'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/shared/components/ui/form'
import { CopyButton } from '@/shared/components/copy-button'
import { PageHeader } from '@/shared/components/page-header'
import { useCreateTicketMutation } from '@/features/admin/api'
import type { TicketAndSecret } from '@/features/admin/lib/api'

const schema = z.object({
  username: z.string().min(1),
  target_name: z.string().min(1),
  expiry: z.string().optional(),
  number_of_uses: z.string().optional(),
  description: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

export function Component() {
  const { t } = useTranslation('admin')
  const { t: tc } = useTranslation('common')
  const navigate = useNavigate()
  const createMutation = useCreateTicketMutation()
  const [result, setResult] = useState<TicketAndSecret | null>(null)

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      username: '',
      target_name: '',
      expiry: '',
      number_of_uses: '',
      description: '',
    },
  })

  const onSubmit = (values: FormValues) => {
    const numberOfUses = values.number_of_uses
      ? parseInt(values.number_of_uses, 10)
      : undefined

    createMutation.mutate(
      {
        username: values.username,
        target_name: values.target_name,
        expiry: values.expiry || undefined,
        number_of_uses: Number.isFinite(numberOfUses) ? numberOfUses : undefined,
        description: values.description || undefined,
      },
      {
        onSuccess: data => setResult(data),
      },
    )
  }

  if (result) {
    return (
      <div>
        <PageHeader
          title={t('tickets.secret.title')}
          actions={
            <Button
              variant="outline"
              onClick={() => void navigate('/@gated/admin/config/tickets')}
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              {tc('actions.back')}
            </Button>
          }
        />

        <div className="max-w-xl space-y-6">
          <div className="flex items-start gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-4">
            <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
            <p className="text-sm text-amber-700 dark:text-amber-400">
              {t('tickets.secret.warning')}
            </p>
          </div>

          <div className="rounded-md border p-6 space-y-3">
            <div className="flex items-center gap-2 text-muted-foreground">
              <KeyRound className="h-4 w-4" />
              <span className="text-sm font-medium">{t('tickets.secret.label')}</span>
            </div>
            <div className="flex items-center gap-3">
              <code className="flex-1 rounded bg-muted px-4 py-3 font-mono text-lg font-bold tracking-wider break-all">
                {result.secret}
              </code>
              <CopyButton value={result.secret} label={tc('actions.copy')} />
            </div>
          </div>

          <div className="rounded-md border p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('tickets.table.id')}</span>
              <span className="font-mono text-xs">{result.ticket.id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('tickets.table.username')}</span>
              <span>{result.ticket.username}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('tickets.table.target')}</span>
              <span>{result.ticket.target}</span>
            </div>
            {result.ticket.expiry && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('tickets.table.expiry')}</span>
                <span>{new Date(result.ticket.expiry).toLocaleString()}</span>
              </div>
            )}
            {result.ticket.uses_left !== undefined && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('tickets.table.usesLeft')}</span>
                <span>{result.ticket.uses_left}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <PageHeader
        title={t('pages.createTicket')}
        actions={
          <Button
            variant="outline"
            onClick={() => void navigate('/@gated/admin/config/tickets')}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            {tc('actions.back')}
          </Button>
        }
      />

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="max-w-xl space-y-6">
          <FormField
            control={form.control}
            name="username"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('tickets.form.username')} *</FormLabel>
                <FormControl>
                  <Input {...field} placeholder={t('tickets.form.usernamePlaceholder')} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="target_name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('tickets.form.targetName')} *</FormLabel>
                <FormControl>
                  <Input {...field} placeholder={t('tickets.form.targetNamePlaceholder')} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="expiry"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('tickets.form.expiry')}</FormLabel>
                <FormControl>
                  <Input {...field} type="datetime-local" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="number_of_uses"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('tickets.form.numberOfUses')}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type="number"
                    min={1}
                    placeholder={t('tickets.form.numberOfUsesPlaceholder')}
                  />
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
                <FormLabel>{t('tickets.form.description')}</FormLabel>
                <FormControl>
                  <Textarea {...field} placeholder={t('tickets.form.descriptionPlaceholder')} rows={3} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="flex gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => void navigate('/@gated/admin/config/tickets')}
            >
              {tc('actions.cancel')}
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? tc('actions.loading') : t('tickets.create')}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  )
}
