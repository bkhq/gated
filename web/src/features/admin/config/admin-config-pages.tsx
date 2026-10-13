import type { Target, TargetGroup, TargetKind } from '@/shared/types/domain'
import { Folder, FolderPlus, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useCreateTargetGroup, useDeleteTargetGroup, useTargetGroups, useUpdateTargetGroup } from '@/features/target-groups/hooks/use-target-groups-queries'
import { useTargets } from '@/features/targets/hooks/use-targets-queries'
import { DeleteWithReferencesDialog } from '@/shared/components/delete-with-references-dialog'
import { DiscardChangesDialog } from '@/shared/components/discard-changes-dialog'
import { DrawerFooter } from '@/shared/components/drawer-footer'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { RowActionsMenu } from '@/shared/components/row-actions-menu'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { Drawer } from '@/shared/ui/drawer'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Separator } from '@/shared/ui/separator'
import { Skeleton } from '@/shared/ui/skeleton'
import { Textarea } from '@/shared/ui/textarea'

interface DrawerState {
  mode: 'create' | 'edit'
  group: TargetGroup | null
}

interface GroupCardData {
  group: TargetGroup
  liveMembers: number
  kinds: TargetKind[]
}

function deriveGroupData(groups: TargetGroup[], targets: Target[]): GroupCardData[] {
  // Backend Target.group_id is a UUID (mapped through to Target.group in
  // use-targets-queries); match by id, not name.
  return groups.map((group) => {
    const members = targets.filter(target => target.group === group.id)
    const kinds: TargetKind[] = []
    for (const member of members) {
      if (!kinds.includes(member.kind)) {
        kinds.push(member.kind)
      }
    }
    return { group, liveMembers: members.length, kinds }
  })
}

export function AdminTargetGroupsPage() {
  const { t } = useTranslation()
  const groupsQuery = useTargetGroups()
  const targetsQuery = useTargets()
  const [drawer, setDrawer] = React.useState<DrawerState | null>(null)
  const [pendingDelete, setPendingDelete] = React.useState<TargetGroup | null>(null)
  const [query, setQuery] = React.useState('')

  const groups = groupsQuery.data
  const targets = targetsQuery.data
  const cards = React.useMemo(
    () => deriveGroupData(groups ?? [], targets ?? []),
    [groups, targets],
  )

  const filtered = React.useMemo(() => {
    if (!query.trim()) {
      return cards
    }
    const needle = query.toLowerCase()
    return cards.filter(card =>
      card.group.name.toLowerCase().includes(needle)
      || card.group.description.toLowerCase().includes(needle),
    )
  }, [cards, query])

  const openCreate = () => setDrawer({ mode: 'create', group: null })
  const openEdit = (group: TargetGroup) => setDrawer({ mode: 'edit', group })
  const closeDrawer = () => setDrawer(null)

  return (
    <>
      <PageHeader
        title={t('nav.adminTargetGroups')}
        description={t('targetGroups.description')}
        breadcrumbs={[
          { label: t('section.admin') },
          { label: t('nav.adminTargetGroups') },
        ]}
        actions={(
          <Button size="sm" onClick={openCreate}>
            <Plus size={13} />
            <span>{t('targetGroups.actions.newGroup')}</span>
          </Button>
        )}
      />

      <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-4">
        <div className="w-[320px]">
          <Input
            icon={Search}
            placeholder={t('targetGroups.searchPlaceholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            aria-label={t('actions.search')}
          />
        </div>
        {query
          ? (
              <Button variant="ghost" size="sm" onClick={() => setQuery('')}>
                {t('actions.clearFilters')}
              </Button>
            )
          : null}
        <span className="flex-1" />
        <span className="text-[12px] text-muted-foreground">
          {filtered.length}
          {' / '}
          {cards.length}
        </span>
      </div>

      <div className="px-6 pb-6">
        {groupsQuery.isLoading
          ? <GroupGridSkeleton />
          : cards.length === 0
            ? (
                <EmptyState
                  icon={FolderPlus}
                  title={t('targetGroups.empty.title')}
                  description={t('targetGroups.empty.description')}
                  action={(
                    <Button size="sm" onClick={openCreate}>
                      <Plus size={13} />
                      <span>{t('targetGroups.actions.newGroup')}</span>
                    </Button>
                  )}
                />
              )
            : filtered.length === 0
              ? (
                  <EmptyState
                    icon={Search}
                    title={t('targetGroups.empty.filteredTitle')}
                    description={t('targetGroups.empty.filteredDescription')}
                    action={(
                      <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                        {t('actions.clearFilters')}
                      </Button>
                    )}
                  />
                )
              : (
                  <div
                    className="grid gap-3"
                    style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
                  >
                    {filtered.map(card => (
                      <GroupCard
                        key={card.group.id}
                        data={card}
                        onEdit={() => openEdit(card.group)}
                        onDelete={() => setPendingDelete(card.group)}
                      />
                    ))}
                  </div>
                )}
      </div>

      <TargetGroupFormDrawer
        open={drawer !== null}
        mode={drawer?.mode ?? 'create'}
        group={drawer?.group ?? null}
        onClose={closeDrawer}
      />

      <DeleteTargetGroupDialog
        group={pendingDelete}
        onClose={() => setPendingDelete(null)}
      />
    </>
  )
}

function GroupGridSkeleton() {
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
    >
      {Array.from({ length: 6 }).map((_, index) => (
        <Card key={`skeleton-${String(index)}`} className="p-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2.5">
              <Skeleton className="h-9 w-9 rounded-md" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
            <Skeleton className="h-4 w-full" />
            <Separator />
            <Skeleton className="h-4 w-full" />
          </div>
        </Card>
      ))}
    </div>
  )
}

function GroupCard({ data, onEdit, onDelete }: {
  data: GroupCardData
  onEdit: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const { group, liveMembers, kinds } = data
  const memberCount = liveMembers
  const membersLabel = t(memberCount === 1 ? 'targetGroups.card.membersOne' : 'targetGroups.card.membersOther', { count: memberCount })

  return (
    <Card
      className="cursor-pointer transition-colors duration-150 ease-out hover:border-foreground/30 hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)]"
      onClick={onEdit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onEdit()
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={group.name}
    >
      <div className="flex flex-col gap-2.5 p-4">
        <div className="flex items-start gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary text-foreground">
            <Folder size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14.5px] font-semibold">{group.name}</div>
            <div className="truncate text-[12px] text-muted-foreground">{membersLabel}</div>
          </div>
          <div onClick={event => event.stopPropagation()} role="presentation">
            <RowActionsMenu
              items={[
                { label: t('actions.edit'), icon: Pencil, onClick: onEdit },
                'separator' as const,
                { label: t('actions.delete'), icon: Trash2, danger: true, onClick: onDelete },
              ]}
            />
          </div>
        </div>

        {group.description
          ? <div className="line-clamp-2 text-[12.5px] text-muted-foreground">{group.description}</div>
          : null}

        {kinds.length > 0
          ? (
              <div className="flex flex-wrap gap-1">
                {kinds.map(kind => <Badge key={kind} tone="outline">{kind}</Badge>)}
              </div>
            )
          : null}
      </div>
    </Card>
  )
}

interface GroupDraft {
  name: string
  description: string
}

function draftFromGroup(group: TargetGroup): GroupDraft {
  return {
    name: group.name,
    description: group.description,
  }
}

function emptyGroupDraft(): GroupDraft {
  return { name: '', description: '' }
}

function draftsEqual(a: GroupDraft, b: GroupDraft) {
  return a.name === b.name && a.description === b.description
}

interface TargetGroupFormDrawerProps {
  open: boolean
  mode: 'create' | 'edit'
  group: TargetGroup | null
  onClose: () => void
}

function TargetGroupFormDrawer(props: TargetGroupFormDrawerProps) {
  return (
    <TargetGroupFormDrawerBody
      key={`${props.open ? 'open' : 'closed'}-${props.mode}-${props.group?.id ?? 'new'}`}
      {...props}
    />
  )
}

function TargetGroupFormDrawerBody({ open, mode, group, onClose }: TargetGroupFormDrawerProps) {
  const { t } = useTranslation()
  const createMutation = useCreateTargetGroup()
  const updateMutation = useUpdateTargetGroup()

  const initial = React.useMemo<GroupDraft>(
    () => (mode === 'edit' && group ? draftFromGroup(group) : emptyGroupDraft()),
    [mode, group],
  )
  const [draft, setDraft] = React.useState<GroupDraft>(() => initial)
  const [original] = React.useState<GroupDraft>(() => initial)
  const [touched, setTouched] = React.useState(false)
  const [confirmDiscard, setConfirmDiscard] = React.useState(false)
  const nameRef = React.useRef<HTMLInputElement | null>(null)

  React.useLayoutEffect(() => {
    if (!open)
      return
    queueMicrotask(() => nameRef.current?.focus())
  }, [open])

  const isDirty = !draftsEqual(draft, original)
  const nameError = touched && !draft.name.trim()
  const canSave = draft.name.trim().length > 0 && !createMutation.isPending && !updateMutation.isPending

  const requestClose = React.useCallback(() => {
    if (isDirty) {
      setConfirmDiscard(true)
      return
    }
    onClose()
  }, [isDirty, onClose])

  const patch = <K extends keyof GroupDraft>(key: K, value: GroupDraft[K]) => {
    setDraft(prev => ({ ...prev, [key]: value }))
  }

  const save = React.useCallback(async () => {
    setTouched(true)
    if (!canSave || !draft.name.trim()) {
      return
    }
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim(),
    }
    if (mode === 'edit' && group) {
      await updateMutation.mutateAsync({ id: group.id, patch: payload })
    }
    else {
      await createMutation.mutateAsync(payload)
    }
    onClose()
  }, [canSave, draft, mode, group, createMutation, updateMutation, onClose])

  const onFormKeyDown = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void save()
    }
  }

  return (
    <>
      <Drawer open={open} onClose={requestClose} width={520}>
        <form
          className="flex h-full flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
          onKeyDown={onFormKeyDown}
        >
          <div className="flex items-start justify-between gap-3 border-b border-border px-6 py-5">
            <div className="min-w-0">
              <h2 className="m-0 text-[17px] font-semibold">
                {mode === 'create' ? t('targetGroups.form.titleNew') : draft.name || t('targetGroups.form.titleEdit')}
              </h2>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {mode === 'create' ? t('targetGroups.form.descNew') : t('targetGroups.form.descEdit')}
              </p>
            </div>
            <Button type="button" variant="ghost" size="icon-sm" onClick={requestClose} aria-label={t('actions.close')}>
              <X size={15} />
            </Button>
          </div>

          <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-6">
            <div>
              <Label htmlFor="target-group-name">{t('targetGroups.form.nameLabel')}</Label>
              <Input
                ref={nameRef}
                id="target-group-name"
                value={draft.name}
                onChange={(event) => {
                  patch('name', event.target.value)
                  if (!touched) {
                    setTouched(true)
                  }
                }}
                placeholder={t('targetGroups.form.namePlaceholder')}
                aria-invalid={nameError || undefined}
                aria-describedby={nameError ? 'target-group-name-error' : undefined}
              />
              {nameError
                ? (
                    <div id="target-group-name-error" className="mt-1.5 text-[12px] text-destructive">
                      {t('targetGroups.errors.nameRequired')}
                    </div>
                  )
                : null}
            </div>

            <div>
              <Label htmlFor="target-group-description">{t('targetGroups.form.descriptionLabel')}</Label>
              <Textarea
                id="target-group-description"
                rows={3}
                value={draft.description}
                onChange={event => patch('description', event.target.value)}
                placeholder={t('targetGroups.form.descriptionPlaceholder')}
              />
            </div>

            {/* Access is granted per-target via role bindings (the target
                form's Roles tab) — the backend has no group-level role
                model, so this form intentionally stops at name/description. */}
          </div>

          <DrawerFooter
            onCancel={requestClose}
            saveAsSubmit
            saveDisabled={!canSave}
          />
        </form>
      </Drawer>

      <DiscardChangesDialog
        open={confirmDiscard}
        title={t('targetGroups.unsaved.title')}
        body={t('targetGroups.unsaved.body')}
        discardLabel={t('targetGroups.unsaved.discard')}
        onCancel={() => setConfirmDiscard(false)}
        onDiscard={() => {
          setConfirmDiscard(false)
          onClose()
        }}
      />
    </>
  )
}

function DeleteTargetGroupDialog({ group, onClose }: {
  group: TargetGroup | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const targets = useTargets().data ?? []
  const deleteMutation = useDeleteTargetGroup()

  if (!group) {
    return null
  }

  const inUse = targets.filter(target => target.group === group.id).length
  const hasMembers = inUse > 0

  const confirm = async () => {
    await deleteMutation.mutateAsync(group.id)
    onClose()
  }

  return (
    <DeleteWithReferencesDialog
      open
      title={t('targetGroups.delete.title')}
      body={t('targetGroups.delete.body', { name: group.name })}
      warning={hasMembers
        ? {
            title: t('targetGroups.delete.warnTitle'),
            body: t('targetGroups.delete.warnBody', { members: inUse }),
          }
        : null}
      hasReferences={hasMembers}
      onClose={onClose}
      onConfirm={() => { void confirm() }}
      isPending={deleteMutation.isPending}
    />
  )
}
