import type {
  CommandAclAction,
  CommandAclMatchType,
  CommandAclProtocol,
  CommandAclRule,
  CommandAclRuleRequest,
} from '@/shared/lib/api/command-acl'
import { ShieldBan } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  useCreateCommandAclRule,
  useUpdateCommandAclRule,
} from '@/features/command-acl/hooks/use-command-acl-queries'
import { useRoles } from '@/features/roles/hooks/use-roles-queries'
import { useTargets } from '@/features/targets/hooks/use-targets-queries'
import { DrawerFooter } from '@/shared/components/drawer-footer'
import { FormDialog, FormDialogDescription, FormDialogTitle } from '@/shared/components/form-dialog'
import { ApiError } from '@/shared/lib/api/http'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Select } from '@/shared/ui/select'
import { Switch } from '@/shared/ui/switch'
import { Textarea } from '@/shared/ui/textarea'

const PROTOCOLS: CommandAclProtocol[] = ['any', 'ssh', 'mysql', 'postgres']
const MATCH_TYPES: CommandAclMatchType[] = ['regex', 'keyword']
const ACTIONS: CommandAclAction[] = ['allow', 'deny', 'review']

const ALL_SCOPE = '__all__'

export type CommandAclFormMode = 'create' | 'edit'

export interface CommandAclFormDialogProps {
  open: boolean
  mode: CommandAclFormMode
  rule: CommandAclRule | null
  onClose: () => void
}

interface DraftState {
  name: string
  enabled: boolean
  priority: string
  protocol: CommandAclProtocol
  match_type: CommandAclMatchType
  pattern: string
  action: CommandAclAction
  target_id: string
  role_id: string
  description: string
}

function emptyDraft(): DraftState {
  return {
    name: '',
    enabled: true,
    priority: '0',
    protocol: 'any',
    match_type: 'keyword',
    pattern: '',
    action: 'deny',
    target_id: ALL_SCOPE,
    role_id: ALL_SCOPE,
    description: '',
  }
}

function draftFromRule(rule: CommandAclRule): DraftState {
  return {
    name: rule.name,
    enabled: rule.enabled,
    priority: String(rule.priority),
    protocol: rule.protocol,
    match_type: rule.match_type,
    pattern: rule.pattern,
    action: rule.action,
    target_id: rule.target_id ?? ALL_SCOPE,
    role_id: rule.role_id ?? ALL_SCOPE,
    description: rule.description ?? '',
  }
}

function draftToRequest(draft: DraftState): CommandAclRuleRequest {
  const priority = Number.parseInt(draft.priority, 10)
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    priority: Number.isFinite(priority) ? priority : 0,
    protocol: draft.protocol,
    match_type: draft.match_type,
    pattern: draft.pattern,
    action: draft.action,
    target_id: draft.target_id === ALL_SCOPE ? null : draft.target_id,
    role_id: draft.role_id === ALL_SCOPE ? null : draft.role_id,
    description: draft.description.trim() === '' ? null : draft.description.trim(),
  }
}

/** Server returns a bare JSON string reason on 400 (in ApiError.body). */
function serverReason(err: ApiError): string {
  return typeof err.body === 'string' ? err.body : err.message
}

export function CommandAclFormDialog(props: CommandAclFormDialogProps) {
  return (
    <CommandAclFormDialogBody
      key={`${props.open ? 'open' : 'closed'}-${props.mode}-${props.rule?.id ?? 'new'}`}
      {...props}
    />
  )
}

function CommandAclFormDialogBody({ open, mode, rule, onClose }: CommandAclFormDialogProps) {
  const { t } = useTranslation()
  const createMutation = useCreateCommandAclRule()
  const updateMutation = useUpdateCommandAclRule()
  const targetsQuery = useTargets()
  const rolesQuery = useRoles()

  const initialDraft = React.useMemo<DraftState>(
    () => (mode === 'edit' && rule ? draftFromRule(rule) : emptyDraft()),
    [mode, rule],
  )

  const [draft, setDraft] = React.useState<DraftState>(() => initialDraft)
  const [original] = React.useState<DraftState>(() => initialDraft)
  const [touched, setTouched] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)
  const nameRef = React.useRef<HTMLInputElement | null>(null)

  React.useLayoutEffect(() => {
    if (!open)
      return
    queueMicrotask(() => nameRef.current?.focus())
  }, [open])

  function patch<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setServerError(null)
    setDraft(prev => ({ ...prev, [key]: value }))
  }

  const nameError = draft.name.trim() === '' ? t('commandAcl.errors.nameRequired') : null
  const patternError = draft.pattern.trim() === '' ? t('commandAcl.errors.patternRequired') : null
  // Client-side hint only — the server compiles regex authoritatively.
  const regexHintError = React.useMemo(() => {
    if (draft.match_type !== 'regex' || draft.pattern.trim() === '')
      return null
    try {
      void new RegExp(draft.pattern)
      return null
    }
    catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }, [draft.match_type, draft.pattern])

  const isDirty = JSON.stringify(draft) !== JSON.stringify(original)
  const isPending = createMutation.isPending || updateMutation.isPending
  const canSave = nameError === null && patternError === null && !isPending

  const save = React.useCallback(async () => {
    setTouched(true)
    setServerError(null)
    if (draft.name.trim() === '' || draft.pattern.trim() === '') {
      queueMicrotask(() => nameRef.current?.focus())
      return
    }
    const body = draftToRequest(draft)
    try {
      if (mode === 'edit' && rule)
        await updateMutation.mutateAsync({ id: rule.id, body })
      else
        await createMutation.mutateAsync(body)
      onClose()
    }
    catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setServerError(serverReason(err))
        return
      }
      throw err
    }
  }, [draft, mode, rule, createMutation, updateMutation, onClose])

  const targetOptions = React.useMemo(() => [
    { value: ALL_SCOPE, label: t('commandAcl.scope.allTargets') },
    ...(targetsQuery.data ?? []).map(target => ({ value: target.id, label: target.name })),
  ], [targetsQuery.data, t])
  const roleOptions = React.useMemo(() => [
    { value: ALL_SCOPE, label: t('commandAcl.scope.allRoles') },
    ...(rolesQuery.data ?? []).map(role => ({ value: role.id, label: role.name })),
  ], [rolesQuery.data, t])

  const header = (
    <div className="flex items-center gap-3 border-b border-border px-6 py-5">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
        <ShieldBan size={18} />
      </div>
      <div className="min-w-0">
        <FormDialogTitle className="m-0 text-[17px] font-semibold leading-tight">
          {mode === 'create' ? t('commandAcl.form.titleNew') : draft.name || t('commandAcl.form.titleEdit')}
        </FormDialogTitle>
        <FormDialogDescription className="mt-0.5 text-[13px] text-muted-foreground">
          {mode === 'create' ? t('commandAcl.form.descNew') : t('commandAcl.form.descEdit')}
        </FormDialogDescription>
      </div>
    </div>
  )

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      width="lg"
      dirty={isDirty}
      discardTitle={t('commandAcl.unsaved.title')}
      discardBody={t('commandAcl.unsaved.body')}
      discardLabel={t('commandAcl.unsaved.discard')}
      header={header}
      footer={requestClose => (
        <DrawerFooter
          onCancel={requestClose}
          saveAsSubmit
          isPending={isPending}
          saveDisabled={!canSave}
          form="command-acl-form"
        />
      )}
    >
      <form
        id="command-acl-form"
        className="flex w-full flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        {serverError
          ? (
              <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
                {serverError}
              </div>
            )
          : null}

        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <div className="sm:col-span-1">
            <Label htmlFor="acl-name">{t('fields.name')}</Label>
            <Input
              ref={nameRef}
              id="acl-name"
              value={draft.name}
              onChange={(event) => {
                patch('name', event.target.value)
                if (!touched)
                  setTouched(true)
              }}
              placeholder={t('commandAcl.form.namePlaceholder')}
              aria-invalid={touched && nameError !== null ? true : undefined}
              aria-describedby={touched && nameError ? 'acl-name-error' : undefined}
            />
            {touched && nameError
              ? <div id="acl-name-error" className="mt-1.5 text-[12px] text-destructive">{nameError}</div>
              : null}
          </div>

          <div className="sm:col-span-1">
            <Label htmlFor="acl-priority">{t('commandAcl.fields.priority')}</Label>
            <Input
              id="acl-priority"
              type="number"
              value={draft.priority}
              onChange={event => patch('priority', event.target.value)}
              wrapperClassName="w-[160px]"
            />
            <div className="mt-1 text-[12px] text-muted-foreground">{t('commandAcl.fields.priorityHint')}</div>
          </div>

          <div className="sm:col-span-1">
            <Label htmlFor="acl-protocol">{t('fields.protocol')}</Label>
            <Select
              id="acl-protocol"
              value={draft.protocol}
              onValueChange={value => patch('protocol', value as CommandAclProtocol)}
              options={PROTOCOLS.map(p => ({ value: p, label: t(`commandAcl.protocol.${p}`) }))}
            />
          </div>

          <div className="sm:col-span-1">
            <Label htmlFor="acl-action">{t('commandAcl.fields.action')}</Label>
            <Select
              id="acl-action"
              value={draft.action}
              onValueChange={value => patch('action', value as CommandAclAction)}
              options={ACTIONS.map(a => ({ value: a, label: t(`commandAcl.action.${a}`) }))}
            />
          </div>

          <div className="sm:col-span-1">
            <Label htmlFor="acl-match-type">{t('commandAcl.fields.matchType')}</Label>
            <Select
              id="acl-match-type"
              value={draft.match_type}
              onValueChange={value => patch('match_type', value as CommandAclMatchType)}
              options={MATCH_TYPES.map(m => ({ value: m, label: t(`commandAcl.matchType.${m}`) }))}
            />
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="acl-pattern">{t('commandAcl.fields.pattern')}</Label>
            <Textarea
              id="acl-pattern"
              rows={2}
              className="mono"
              value={draft.pattern}
              onChange={event => patch('pattern', event.target.value)}
              placeholder={draft.match_type === 'regex' ? '^rm\\s+-rf' : 'rm -rf'}
              aria-invalid={touched && patternError !== null ? true : undefined}
              aria-describedby={touched && patternError ? 'acl-pattern-error' : undefined}
            />
            {touched && patternError
              ? <div id="acl-pattern-error" className="mt-1.5 text-[12px] text-destructive">{patternError}</div>
              : (
                  <div className="mt-1 text-[12px] text-muted-foreground">
                    {draft.match_type === 'regex' ? t('commandAcl.fields.patternRegexHint') : t('commandAcl.fields.patternKeywordHint')}
                  </div>
                )}
            {regexHintError
              ? <div className="mt-1 text-[12px] text-[hsl(var(--warning))]">{t('commandAcl.errors.regexHint', { error: regexHintError })}</div>
              : null}
          </div>

          <div className="sm:col-span-1">
            <Label htmlFor="acl-target">{t('commandAcl.fields.targetScope')}</Label>
            <Select
              id="acl-target"
              value={draft.target_id}
              onValueChange={value => patch('target_id', value)}
              options={targetOptions}
            />
          </div>

          <div className="sm:col-span-1">
            <Label htmlFor="acl-role">{t('commandAcl.fields.roleScope')}</Label>
            <Select
              id="acl-role"
              value={draft.role_id}
              onValueChange={value => patch('role_id', value)}
              options={roleOptions}
            />
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="acl-description">{t('fields.description')}</Label>
            <Textarea
              id="acl-description"
              rows={2}
              value={draft.description}
              onChange={event => patch('description', event.target.value)}
              placeholder={t('commandAcl.form.descriptionPlaceholder')}
            />
          </div>

          <label className="flex items-center gap-2.5 sm:col-span-2">
            <Switch
              checked={draft.enabled}
              onCheckedChange={value => patch('enabled', Boolean(value))}
              aria-label={t('commandAcl.fields.enabled')}
            />
            <span className="text-[13.5px]">{t('commandAcl.fields.enabled')}</span>
          </label>
        </div>
      </form>
    </FormDialog>
  )
}
