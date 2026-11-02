import type { User } from '@/shared/types/domain'
import { ShieldCheck, Trash2, User as UserIcon } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useRoles } from '@/features/roles/hooks/use-roles-queries'
import { useLiveSessions, usePastSessions } from '@/features/sessions/hooks/use-sessions-queries'
import { useCreateUser, useUpdateUser, useUserRoles } from '@/features/users/hooks/use-users-queries'
import { DrawerFooter } from '@/shared/components/drawer-footer'
import { EmptyState } from '@/shared/components/empty-state'
import { FormDialog, FormDialogDescription, FormDialogTitle } from '@/shared/components/form-dialog'
import { Pager } from '@/shared/components/pager'
import { StatusDot } from '@/shared/components/status-dot'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Switch } from '@/shared/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/ui/tabs'

const SESSIONS_PAGE_SIZE = 20

export type UserFormMode = 'create' | 'edit'

export interface UserFormDialogProps {
  open: boolean
  mode: UserFormMode
  user: User | null
  onClose: () => void
  onSaved?: (user: User) => void
  onRequestDelete?: (user: User) => void
  finalFocusRef?: React.RefObject<HTMLElement | null>
}

interface DraftState {
  name: string
  username: string
  // Role IDs (synced via /admin/api/users/:id/roles/:role_id on save).
  roles: Set<string>
  // Create mode only: initial password credential (optional).
  password: string
}

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]*$/

function emptyDraft(): DraftState {
  return {
    name: '',
    username: '',
    roles: new Set<string>(),
    password: '',
  }
}

function draftFromUser(user: User): DraftState {
  return {
    name: user.name,
    username: user.username,
    // Persisted role bindings load async (useUserRoles) and are seeded
    // into both draft and original once available.
    roles: new Set<string>(),
    password: '',
  }
}

function draftsEqual(a: DraftState, b: DraftState) {
  if (a.name !== b.name || a.username !== b.username || a.password !== b.password) {
    return false
  }
  if (a.roles.size !== b.roles.size) {
    return false
  }
  for (const role of a.roles) {
    if (!b.roles.has(role)) {
      return false
    }
  }
  return true
}

interface DraftErrors {
  name?: string
  username?: string
}

function validate(draft: DraftState, t: (key: string) => string): DraftErrors {
  const errors: DraftErrors = {}
  if (!draft.name.trim()) {
    errors.name = t('users.errors.nameRequired')
  }
  const username = draft.username.trim()
  if (!username) {
    errors.username = t('users.errors.usernameRequired')
  }
  else if (!USERNAME_RE.test(username)) {
    errors.username = t('users.errors.usernameFormat')
  }
  return errors
}

export function UserFormDialog(props: UserFormDialogProps) {
  return (
    <UserFormDialogBody
      key={`${props.open ? 'open' : 'closed'}-${props.mode}-${props.user?.id ?? 'new'}`}
      {...props}
    />
  )
}

function UserFormDialogBody({ open, mode, user, onClose, onSaved, onRequestDelete, finalFocusRef }: UserFormDialogProps) {
  const { t } = useTranslation()
  const roles = useRoles().data ?? []
  const liveSessions = useLiveSessions().data ?? []
  const [pastOffset, setPastOffset] = React.useState(0)
  const pastQuery = usePastSessions(
    { offset: pastOffset, limit: SESSIONS_PAGE_SIZE, username: user?.username },
    mode === 'edit' && !!user,
  )
  const pastSessions = pastQuery.data?.items ?? []
  const pastTotal = pastQuery.data?.total ?? 0
  const createMutation = useCreateUser()
  const updateMutation = useUpdateUser()

  const initial = React.useMemo<DraftState>(
    () => (mode === 'edit' && user ? draftFromUser(user) : emptyDraft()),
    [mode, user],
  )

  const [tab, setTab] = React.useState<'general' | 'roles' | 'sessions'>('general')
  const [draft, setDraft] = React.useState<DraftState>(() => initial)
  const [original, setOriginal] = React.useState<DraftState>(() => initial)
  const [touched, setTouched] = React.useState(false)
  const nameRef = React.useRef<HTMLInputElement | null>(null)

  // Seed role toggles from the persisted user-role bindings once loaded
  // (render-time seeding keeps user toggles after the initial seed).
  const userRolesQuery = useUserRoles(mode === 'edit' ? user?.id : undefined)
  const loadedRoles = userRolesQuery.data
  const [seededFrom, setSeededFrom] = React.useState<typeof loadedRoles>(undefined)
  if (loadedRoles && loadedRoles !== seededFrom) {
    setSeededFrom(loadedRoles)
    const ids = loadedRoles.map(role => role.id)
    setDraft(prev => ({ ...prev, roles: new Set(ids) }))
    setOriginal(prev => ({ ...prev, roles: new Set(ids) }))
  }

  React.useLayoutEffect(() => {
    if (!open)
      return
    queueMicrotask(() => nameRef.current?.focus())
  }, [open])

  const errors = React.useMemo(() => validate(draft, t), [draft, t])
  const hasErrors = Boolean(errors.name || errors.username)
  const isDirty = !draftsEqual(draft, original)
  const isPending = createMutation.isPending || updateMutation.isPending

  function patch<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft(prev => ({ ...prev, [key]: value }))
    if (!touched) {
      setTouched(true)
    }
  }

  function toggleRole(roleId: string, checked: boolean) {
    setDraft((prev) => {
      const next = new Set(prev.roles)
      if (checked) {
        next.add(roleId)
      }
      else {
        next.delete(roleId)
      }
      return { ...prev, roles: next }
    })
    if (!touched) {
      setTouched(true)
    }
  }

  const save = React.useCallback(async () => {
    setTouched(true)
    if (hasErrors || isPending) {
      return
    }
    const base = {
      name: draft.name.trim(),
      username: draft.username.trim(),
    }
    const roleIds = [...draft.roles]
    if (mode === 'edit' && user) {
      const updated = await updateMutation.mutateAsync({ id: user.id, patch: base, roleIds })
      if (updated) {
        onSaved?.(updated)
      }
    }
    else {
      const created = await createMutation.mutateAsync({
        ...base,
        roleIds,
        password: draft.password || undefined,
      })
      onSaved?.(created)
    }
    onClose()
  }, [draft, mode, user, hasErrors, isPending, createMutation, updateMutation, onSaved, onClose])

  const onFormKeyDown = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void save()
    }
  }

  const userSessions = user
    ? [
        ...liveSessions.filter(session => session.user === user.username).map(session => ({ ...session, when: session.duration, state: 'live' as const })),
        ...pastSessions.map(session => ({ ...session, when: session.started, state: 'closed' as const })),
      ]
    : []

  const showError = (key: keyof DraftErrors) => touched ? errors[key] : undefined

  const header = (
    <div className="flex items-center gap-3 border-b border-border px-6 py-5">
      <Avatar name={draft.name || draft.username || '?'} size={40} />
      <div className="min-w-0">
        <FormDialogTitle className="m-0 truncate text-[17px] font-semibold leading-tight">
          {mode === 'edit' && user ? (draft.name || user.name) : t('users.form.titleNew')}
        </FormDialogTitle>
        <FormDialogDescription className="mono mt-0.5 truncate text-[13px] text-muted-foreground">
          {mode === 'edit' && user ? user.username : t('users.form.descNew')}
        </FormDialogDescription>
      </div>
    </div>
  )

  const tabsStrip = (
    <div className="border-b border-border px-6 pt-2">
      <Tabs value={tab} onChange={next => setTab(next as typeof tab)}>
        <TabsList className="gap-1 bg-transparent p-0">
          {(['general', 'roles', ...(mode === 'edit' ? ['sessions' as const] : [])] as const).map(value => (
            <TabsTrigger
              key={value}
              value={value}
              className={`h-9 rounded-none bg-transparent px-2.5 shadow-none ${tab === value ? 'border-b-2 border-foreground' : 'border-b-2 border-transparent'}`}
            >
              {t(`users.form.tabs.${value}`)}
              {value === 'roles' ? ` · ${draft.roles.size}` : ''}
              {value === 'sessions' && mode === 'edit' ? ` · ${userSessions.length - pastSessions.length + pastTotal}` : ''}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  )

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      width="lg"
      dirty={isDirty && !isPending}
      discardTitle={t('users.unsaved.title')}
      discardBody={t('users.unsaved.body')}
      discardLabel={t('users.unsaved.discard')}
      finalFocusRef={finalFocusRef}
      header={header}
      belowHeader={tabsStrip}
      scrollResetKey={tab}
      footer={requestClose => (
        <DrawerFooter
          leftAction={mode === 'edit' && user && onRequestDelete
            ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => onRequestDelete(user)}
                >
                  <Trash2 size={13} />
                  <span>{t('actions.delete')}</span>
                </Button>
              )
            : undefined}
          onCancel={requestClose}
          saveAsSubmit
          form="user-form-dialog-form"
          isPending={isPending}
          saveDisabled={touched && hasErrors}
        />
      )}
    >
      <form
        id="user-form-dialog-form"
        className="flex w-full flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
        onKeyDown={onFormKeyDown}
      >
        <Tabs className="w-full self-stretch" value={tab} onChange={next => setTab(next as typeof tab)}>
          <TabsContent value="general">
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="user-name">{t('fields.name')}</Label>
                <Input
                  ref={nameRef}
                  id="user-name"
                  value={draft.name}
                  onChange={event => patch('name', event.target.value)}
                  placeholder={t('users.form.namePlaceholder')}
                  aria-invalid={Boolean(showError('name')) || undefined}
                  aria-describedby={showError('name') ? 'user-name-error' : undefined}
                />
                {showError('name')
                  ? <FieldError id="user-name-error">{errors.name}</FieldError>
                  : null}
              </div>
              <div>
                <Label htmlFor="user-username">{t('users.fields.username')}</Label>
                <Input
                  id="user-username"
                  className="mono"
                  value={draft.username}
                  onChange={event => patch('username', event.target.value)}
                  placeholder={t('users.form.usernamePlaceholder')}
                  aria-invalid={Boolean(showError('username')) || undefined}
                  aria-describedby={showError('username') ? 'user-username-error' : undefined}
                />
                {showError('username')
                  ? <FieldError id="user-username-error">{errors.username}</FieldError>
                  : null}
              </div>
              {mode === 'create'
                ? (
                    <div className="sm:col-span-2">
                      <Label htmlFor="user-password">{t('users.fields.password')}</Label>
                      <Input
                        id="user-password"
                        type="password"
                        autoComplete="new-password"
                        value={draft.password}
                        onChange={event => patch('password', event.target.value)}
                        placeholder={t('users.form.passwordPlaceholder')}
                      />
                      <div className="mt-1.5 text-[12px] text-muted-foreground">{t('users.form.passwordHint')}</div>
                    </div>
                  )
                : null}
            </div>
          </TabsContent>

          <TabsContent value="roles">
            <Card className="p-0">
              {roles.length === 0
                ? (
                    <div className="p-6">
                      <EmptyState
                        title={t('users.form.noRoles')}
                        description={t('users.form.noRolesHint')}
                      />
                    </div>
                  )
                : roles.map((role, index) => (
                    <div
                      key={role.id}
                      className="flex items-center gap-2.5 p-3"
                      style={{ borderTop: index === 0 ? 'none' : '1px solid hsl(var(--border))' }}
                    >
                      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-secondary">
                        <ShieldCheck size={14} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13.5px] font-medium">{role.name}</span>
                          {role.builtin ? <Badge tone="info">built-in</Badge> : null}
                        </div>
                        <div className="text-[12px] text-muted-foreground">{role.description}</div>
                      </div>
                      <Switch
                        checked={draft.roles.has(role.id)}
                        onCheckedChange={checked => toggleRole(role.id, checked)}
                        aria-label={role.name}
                      />
                    </div>
                  ))}
            </Card>
          </TabsContent>

          <TabsContent value="sessions">
            {userSessions.length === 0
              ? (
                  <div className="p-6">
                    <EmptyState
                      title={t('users.form.noSessions')}
                    />
                  </div>
                )
              : (
                  <div className="flex flex-col gap-2">
                    {userSessions.map(session => (
                      <div
                        key={session.id}
                        className="flex items-center gap-2.5 rounded-md border border-border p-3"
                      >
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary text-foreground">
                          <UserIcon size={15} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px]">
                            <span className="mono font-medium">{session.target}</span>
                            <span className="text-muted-foreground"> · </span>
                            <span className="text-muted-foreground">{session.protocol.toUpperCase()}</span>
                          </div>
                          <div className="text-[12px] text-muted-foreground">{session.when}</div>
                        </div>
                        <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                          <StatusDot tone={session.state === 'live' ? 'success' : 'muted'} />
                          <span>{t(`status.${session.state}`)}</span>
                        </span>
                      </div>
                    ))}
                    <Pager offset={pastOffset} pageSize={SESSIONS_PAGE_SIZE} total={pastTotal} onOffsetChange={setPastOffset} />
                  </div>
                )}
          </TabsContent>
        </Tabs>
      </form>
    </FormDialog>
  )
}

function FieldError({ id, children }: { id?: string, children: React.ReactNode }) {
  return (
    <div id={id} className="mt-1.5 text-[12px] text-destructive">
      {children}
    </div>
  )
}
