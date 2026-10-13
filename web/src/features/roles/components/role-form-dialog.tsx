import type { Role } from '@/shared/types/domain'
import { ShieldCheck } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useCreateRole, useUpdateRole } from '@/features/roles/hooks/use-roles-queries'
import { DrawerFooter } from '@/shared/components/drawer-footer'
import { FormDialog, FormDialogDescription, FormDialogTitle } from '@/shared/components/form-dialog'
import { Badge } from '@/shared/ui/badge'
import { Card } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Textarea } from '@/shared/ui/textarea'

export type RoleFormMode = 'create' | 'edit'

export interface RoleFormDialogProps {
  open: boolean
  mode: RoleFormMode
  role: Role | null
  onClose: () => void
  onSaved?: (role: Role) => void
  finalFocusRef?: React.RefObject<HTMLElement | null>
}

interface DraftState {
  name: string
  description: string
}

const NAME_MIN = 2
const NAME_MAX = 64

function emptyDraft(): DraftState {
  return { name: '', description: '' }
}

function draftFromRole(role: Role): DraftState {
  return { name: role.name, description: role.description }
}

function draftsEqual(a: DraftState, b: DraftState) {
  return a.name === b.name && a.description === b.description
}

function nameError(name: string, t: (key: string) => string): string | null {
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    return t('roles.errors.nameRequired')
  }
  if (trimmed.length < NAME_MIN) {
    return t('roles.errors.nameTooShort')
  }
  if (trimmed.length > NAME_MAX) {
    return t('roles.errors.nameTooLong')
  }
  return null
}

export function RoleFormDialog(props: RoleFormDialogProps) {
  return (
    <RoleFormDialogBody
      key={`${props.open ? 'open' : 'closed'}-${props.mode}-${props.role?.id ?? 'new'}`}
      {...props}
    />
  )
}

function RoleFormDialogBody({ open, mode, role, onClose, onSaved, finalFocusRef }: RoleFormDialogProps) {
  const { t } = useTranslation()
  const createMutation = useCreateRole()
  const updateMutation = useUpdateRole()

  const initialDraft = React.useMemo<DraftState>(() => {
    if (role && (mode === 'edit' || mode === 'create')) {
      return draftFromRole(role)
    }
    return emptyDraft()
  }, [mode, role])

  const [draft, setDraft] = React.useState<DraftState>(() => initialDraft)
  const [original] = React.useState<DraftState>(() => (mode === 'edit' && role ? initialDraft : emptyDraft()))
  const [touched, setTouched] = React.useState(false)
  const nameRef = React.useRef<HTMLInputElement | null>(null)

  React.useLayoutEffect(() => {
    if (!open)
      return
    queueMicrotask(() => nameRef.current?.focus())
  }, [open])

  const isBuiltin = mode === 'edit' && Boolean(role?.builtin)
  const isDirty = !draftsEqual(draft, original)
  const validationError = nameError(draft.name, t)
  const canSave = validationError === null
    && !createMutation.isPending
    && !updateMutation.isPending

  function patch<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft(prev => ({ ...prev, [key]: value }))
  }

  const save = React.useCallback(async () => {
    setTouched(true)
    if (validationError !== null) {
      queueMicrotask(() => nameRef.current?.focus())
      return
    }
    const body = {
      name: draft.name.trim(),
      description: draft.description.trim(),
    }
    if (mode === 'edit' && role) {
      const updated = await updateMutation.mutateAsync({ id: role.id, patch: body })
      if (updated) {
        onSaved?.(updated)
      }
    }
    else {
      const created = await createMutation.mutateAsync(body)
      onSaved?.(created)
    }
    onClose()
  }, [validationError, draft, mode, role, createMutation, updateMutation, onSaved, onClose])

  const onFormKeyDown = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void save()
    }
  }

  const header = (
    <div className="flex items-center gap-3 border-b border-border px-6 py-5">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
        <ShieldCheck size={18} />
      </div>
      <div className="min-w-0">
        <FormDialogTitle className="m-0 flex flex-wrap items-center gap-2 text-[17px] font-semibold leading-tight">
          {mode === 'create'
            ? t('roles.form.titleNew')
            : draft.name || t('roles.form.titleEdit')}
          {isBuiltin ? <Badge tone="info">{t('roles.kind.builtin')}</Badge> : null}
        </FormDialogTitle>
        <FormDialogDescription className="mt-0.5 text-[13px] text-muted-foreground">
          {mode === 'create' ? t('roles.form.descNew') : t('roles.form.descEdit')}
        </FormDialogDescription>
      </div>
    </div>
  )

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      width="xl"
      dirty={isDirty}
      discardTitle={t('roles.unsaved.title')}
      discardBody={t('roles.unsaved.body')}
      discardLabel={t('roles.unsaved.discard')}
      finalFocusRef={finalFocusRef}
      header={header}
      footer={requestClose => (
        <DrawerFooter
          onCancel={requestClose}
          saveAsSubmit
          saveDisabled={!canSave}
          form="role-form-dialog-form"
        />
      )}
    >
      <form
        id="role-form-dialog-form"
        className="flex w-full flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
        onKeyDown={onFormKeyDown}
      >
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <div className="sm:col-span-1">
            <Label htmlFor="role-name">{t('fields.name')}</Label>
            <Input
              ref={nameRef}
              id="role-name"
              value={draft.name}
              onChange={(event) => {
                patch('name', event.target.value)
                if (!touched) {
                  setTouched(true)
                }
              }}
              placeholder={t('roles.form.namePlaceholder')}
              disabled={isBuiltin}
              maxLength={NAME_MAX + 4}
              aria-invalid={touched && validationError !== null ? true : undefined}
              aria-describedby={touched && validationError ? 'role-name-error' : undefined}
            />
            {touched && validationError
              ? (
                  <div id="role-name-error" className="mt-1.5 text-[12px] text-destructive">
                    {validationError}
                  </div>
                )
              : null}
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="role-description">{t('fields.description')}</Label>
            <Textarea
              id="role-description"
              rows={2}
              value={draft.description}
              onChange={event => patch('description', event.target.value)}
              placeholder={t('roles.form.descriptionPlaceholder')}
            />
          </div>
          {isBuiltin
            ? (
                <Card className="flex items-start gap-2.5 bg-[hsl(var(--muted)/0.5)] p-3 text-[12px] sm:col-span-2">
                  <ShieldCheck size={14} className="mt-0.5 text-muted-foreground" />
                  <div>
                    <div className="font-medium text-foreground">{t('roles.form.builtin')}</div>
                    <div className="text-muted-foreground">{t('roles.form.builtinHint')}</div>
                  </div>
                </Card>
              )
            : null}
        </div>
      </form>
    </FormDialog>
  )
}
