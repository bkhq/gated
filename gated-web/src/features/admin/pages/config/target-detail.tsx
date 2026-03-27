import type { FormValues } from './target-form'
import { Key, Loader2, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import {
  useAddTargetRole,
  useDeleteTarget,
  useRemoveTargetRole,
  useRoles,
  useTarget,
  useTargetGroupsQuery,
  useTargetRoles,
  useTargetSshHostKeys,
  useUpdateTarget,
} from '@/features/admin/api'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { Badge } from '@/shared/components/ui/badge'
import { Button } from '@/shared/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { buildRequest, TargetForm, targetToFormValues } from './target-form'

// ── Roles Tab ─────────────────────────────────────────────────────────────────

function RolesTab({ targetId }: { targetId: string }) {
  const { t } = useTranslation('admin')
  const [selectedRoleId, setSelectedRoleId] = useState('')

  const { data: assignedRoles, isLoading: rolesLoading } = useTargetRoles(targetId)
  const { data: allRoles } = useRoles()
  const addRole = useAddTargetRole()
  const removeRole = useRemoveTargetRole()

  const assignedIds = new Set(assignedRoles?.map(r => r.id) ?? [])
  const availableRoles = allRoles?.filter(r => !assignedIds.has(r.id)) ?? []

  function handleAdd() {
    if (selectedRoleId === '')
      return
    addRole.mutate(
      { targetId, roleId: selectedRoleId },
      { onSuccess: () => setSelectedRoleId('') },
    )
  }

  if (rolesLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Add role row */}
      <div className="flex gap-2">
        <Select value={selectedRoleId} onValueChange={v => setSelectedRoleId(v ?? '')}>
          <SelectTrigger className="flex-1 max-w-xs">
            <SelectValue placeholder={t('targets.roles.addPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {availableRoles.map(r => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          onClick={handleAdd}
          disabled={selectedRoleId === '' || addRole.isPending}
          size="sm"
        >
          {addRole.isPending
            ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              )
            : (
                <Plus className="h-4 w-4" />
              )}
          <span className="ml-1">{t('targets.roles.add')}</span>
        </Button>
      </div>

      {/* Assigned roles list */}
      {assignedRoles == null || assignedRoles.length === 0
        ? (
            <EmptyState
              icon={Key}
              title={t('targets.roles.empty')}
              description={t('targets.roles.emptyDescription')}
            />
          )
        : (
            <ul className="space-y-2">
              {assignedRoles.map(role => (
                <li
                  key={role.id}
                  className="flex items-center justify-between rounded-md border px-3 py-2"
                >
                  <div>
                    <span className="font-medium text-sm">{role.name}</span>
                    {role.description && (
                      <span className="ml-2 text-xs text-muted-foreground">{role.description}</span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    disabled={removeRole.isPending}
                    onClick={() => removeRole.mutate({ targetId, roleId: role.id })}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
    </div>
  )
}

// ── SSH Host Keys Tab ─────────────────────────────────────────────────────────

function SshHostKeysTab({ targetId }: { targetId: string }) {
  const { t } = useTranslation('admin')
  const { data: hostKeys, isLoading } = useTargetSshHostKeys(targetId, true)

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  if (hostKeys == null || hostKeys.length === 0) {
    return (
      <EmptyState
        icon={Key}
        title={t('targets.sshHostKeys.empty')}
        description={t('targets.sshHostKeys.emptyDescription')}
      />
    )
  }

  return (
    <ul className="space-y-2">
      {hostKeys.map(key => (
        <li key={key.id} className="rounded-md border px-3 py-2 space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{key.key_type}</Badge>
            <span className="text-sm font-medium">
              {key.host}
              :
              {key.port}
            </span>
          </div>
          <p className="font-mono text-xs text-muted-foreground break-all">{key.key_base64}</p>
        </li>
      ))}
    </ul>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function Component() {
  const { t } = useTranslation('admin')
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [deleteOpen, setDeleteOpen] = useState(false)

  const { data: target, isLoading } = useTarget(id ?? '')
  const { data: groups = [] } = useTargetGroupsQuery()
  const updateMutation = useUpdateTarget()
  const deleteMutation = useDeleteTarget()

  function onSubmit(values: FormValues) {
    if (id == null || id === '')
      return
    updateMutation.mutate({ id, req: buildRequest(values) })
  }

  function handleDelete() {
    if (id == null || id === '')
      return
    deleteMutation.mutate(id, {
      onSuccess: () => void navigate('/ui/admin/config/targets'),
    })
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-64 w-full max-w-2xl" />
      </div>
    )
  }

  if (!target) {
    return (
      <EmptyState
        title={t('targets.notFound')}
        description={t('targets.emptyDescription')}
        action={(
          <Button variant="outline" onClick={() => void navigate('/ui/admin/config/targets')}>
            {t('targets.title')}
          </Button>
        )}
      />
    )
  }

  const isSsh = target.options.kind === 'Ssh'

  return (
    <div>
      <PageHeader
        title={target.name}
        description={target.description || undefined}
        actions={(
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleteOpen(true)}
            disabled={deleteMutation.isPending}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t('common.delete')}
          </Button>
        )}
      />

      <Tabs defaultValue="details" className="space-y-4">
        <TabsList>
          <TabsTrigger value="details">{t('targets.tabs.details')}</TabsTrigger>
          <TabsTrigger value="roles">{t('targets.tabs.roles')}</TabsTrigger>
          {isSsh && <TabsTrigger value="ssh-keys">{t('targets.tabs.sshHostKeys')}</TabsTrigger>}
        </TabsList>

        <TabsContent value="details">
          <div className="max-w-2xl">
            <TargetForm
              defaultValues={targetToFormValues(target)}
              groups={groups}
              onSubmit={onSubmit}
              isSubmitting={updateMutation.isPending}
              submitLabel={t('targets.saveChanges')}
            />
          </div>
        </TabsContent>

        <TabsContent value="roles">
          <div className="max-w-2xl">
            <RolesTab targetId={target.id} />
          </div>
        </TabsContent>

        {isSsh && (
          <TabsContent value="ssh-keys">
            <div className="max-w-2xl">
              <SshHostKeysTab targetId={target.id} />
            </div>
          </TabsContent>
        )}
      </Tabs>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('targets.deleteTitle')}
        description={t('targets.deleteDescription')}
        confirmLabel={t('common.delete')}
        onConfirm={handleDelete}
      />
    </div>
  )
}
