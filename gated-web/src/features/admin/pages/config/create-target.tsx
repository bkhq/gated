import type { FormValues } from './target-form'
import { useNavigate } from 'react-router'
import { useCreateTarget, useTargetGroupsQuery } from '@/features/admin/api'
import { PageHeader } from '@/shared/components/page-header'
import { buildRequest, EMPTY_DEFAULTS, TargetForm } from './target-form'

export function Component() {
  const navigate = useNavigate()
  const createMutation = useCreateTarget()
  const { data: groups = [] } = useTargetGroupsQuery()

  function onSubmit(values: FormValues) {
    createMutation.mutate(buildRequest(values), {
      onSuccess: (target) => {
        void navigate(`/ui/admin/config/targets/${target.id}`)
      },
    })
  }

  return (
    <div className="max-w-2xl">
      <PageHeader title="Create Target" description="Add a new connection target" />
      <TargetForm
        defaultValues={EMPTY_DEFAULTS}
        groups={groups}
        onSubmit={onSubmit}
        isSubmitting={createMutation.isPending}
        submitLabel="Create Target"
      />
    </div>
  )
}
