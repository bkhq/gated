import type { Ticket } from '@/shared/types/domain'
import type { TicketDraft } from '@/shared/types/drafts'
import { Calendar, Clock, Hash, Key, Trash2, X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useTargets } from '@/features/targets/hooks/use-targets-queries'
import { useCreateTicket, useDeleteTicket, useRevokeTicket } from '@/features/tickets/hooks/use-tickets-queries'
import { ticketDeleteWarning, ticketUsesLabel } from '@/features/tickets/lib/uses'
import { DrawerFooter } from '@/shared/components/drawer-footer'
import { FormDialog, FormDialogDescription, FormDialogTitle } from '@/shared/components/form-dialog'
import { formatTicketExpiresIn, isTicketExpiringSoon, isTicketExpiryFuture } from '@/shared/types/domain'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Checkbox } from '@/shared/ui/checkbox'
import { Dialog } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Select } from '@/shared/ui/select'
import { Textarea } from '@/shared/ui/textarea'

export type TicketFormMode = 'create' | 'edit'

export interface TicketFormDialogProps {
  open: boolean
  mode: TicketFormMode
  ticket: Ticket | null
  onClose: () => void
  onDeleted?: () => void
  // `secret` is present only after create (one-time; build the share link from it).
  onSaved?: (ticket: Ticket, secret?: string) => void
  finalFocusRef?: React.RefObject<HTMLElement | null>
}

const EXPIRES_PRESETS: { value: string, hours: number }[] = [
  { value: '1h', hours: 1 },
  { value: '4h', hours: 4 },
  { value: '24h', hours: 24 },
  { value: '7d', hours: 24 * 7 },
  { value: '14d', hours: 24 * 14 },
  { value: '30d', hours: 24 * 30 },
]

const PRESET_KEYS = new Set(EXPIRES_PRESETS.map(p => p.value))

const STATE_TONE: Record<Ticket['state'], 'success' | 'mono' | 'warning'> = {
  active: 'success',
  consumed: 'mono',
  expired: 'warning',
}

interface DraftState {
  name: string
  scope: string
  usesLimit: number
  expiresPreset: string
  expiresAt: string
  purpose: string
}

function fromHoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
}

function toLocalInputValue(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const tzOffsetMs = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - tzOffsetMs).toISOString().slice(0, 16)
}

function fromLocalInputValue(value: string): string {
  if (!value) {
    return ''
  }
  return new Date(value).toISOString()
}

function emptyDraft(): DraftState {
  return {
    name: '',
    scope: '',
    usesLimit: 1,
    expiresPreset: '24h',
    expiresAt: fromHoursFromNow(24),
    purpose: '',
  }
}

function draftFromTicket(ticket: Ticket): DraftState {
  return {
    name: ticket.name,
    scope: ticket.scope,
    usesLimit: ticket.usesLimit,
    expiresPreset: 'custom',
    expiresAt: ticket.expiresAt,
    purpose: ticket.purpose,
  }
}

function draftsEqual(a: DraftState, b: DraftState) {
  return (
    a.name === b.name
    && a.scope === b.scope
    && a.usesLimit === b.usesLimit
    && a.expiresAt === b.expiresAt
    && a.purpose === b.purpose
  )
}

export function TicketFormDialog(props: TicketFormDialogProps) {
  return (
    <TicketFormDialogBody
      key={`${props.open ? 'open' : 'closed'}-${props.mode}-${props.ticket?.id ?? 'new'}`}
      {...props}
    />
  )
}

function TicketFormDialogBody({ open, mode, ticket, onClose, onDeleted, onSaved, finalFocusRef }: TicketFormDialogProps) {
  const { t } = useTranslation()
  const targetsQuery = useTargets()
  const createMutation = useCreateTicket()
  const deleteMutation = useDeleteTicket()
  const revokeMutation = useRevokeTicket()

  const initial = React.useMemo<DraftState>(
    () => (mode === 'edit' && ticket ? draftFromTicket(ticket) : emptyDraft()),
    [mode, ticket],
  )
  const [draft, setDraft] = React.useState<DraftState>(() => initial)
  const [original] = React.useState<DraftState>(() => initial)
  const [touched, setTouched] = React.useState(false)
  const [confirmRevoke, setConfirmRevoke] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const nameRef = React.useRef<HTMLInputElement | null>(null)

  React.useLayoutEffect(() => {
    if (!open)
      return
    queueMicrotask(() => nameRef.current?.focus())
  }, [open])

  const patch = <K extends keyof DraftState>(key: K, value: DraftState[K]) => {
    setDraft(prev => ({ ...prev, [key]: value }))
  }

  const onPresetChange = (preset: string) => {
    if (preset === 'custom') {
      setDraft(prev => ({ ...prev, expiresPreset: preset }))
      return
    }
    const found = EXPIRES_PRESETS.find(p => p.value === preset)
    if (!found) {
      return
    }
    setDraft(prev => ({ ...prev, expiresPreset: preset, expiresAt: fromHoursFromNow(found.hours) }))
  }

  const onCustomDateChange = (value: string) => {
    const iso = fromLocalInputValue(value)
    setDraft(prev => ({ ...prev, expiresPreset: 'custom', expiresAt: iso }))
  }

  const isReadOnly = mode === 'edit'
  const trimmedName = draft.name.trim()
  const trimmedScope = draft.scope.trim()
  const nameError = trimmedName.length === 0
  const scopeError = trimmedScope.length === 0
  // usesLimit 0 means unlimited.
  const unlimitedUses = draft.usesLimit === 0
  const usesError = !unlimitedUses && (!Number.isFinite(draft.usesLimit) || draft.usesLimit < 1)
  const expiresError = !isTicketExpiryFuture(draft.expiresAt)
  const hasFieldErrors = nameError || scopeError || usesError || expiresError

  const isDirty = !draftsEqual(draft, original)
  const isBusy = createMutation.isPending
  const canSave = !isReadOnly && !hasFieldErrors && !isBusy

  const save = React.useCallback(async () => {
    setTouched(true)
    if (!canSave) {
      return
    }
    const payload: TicketDraft = {
      name: trimmedName,
      scope: trimmedScope,
      usesLimit: draft.usesLimit,
      expiresAt: draft.expiresAt,
      purpose: draft.purpose.trim(),
    }
    const created = await createMutation.mutateAsync(payload)
    onSaved?.(created.ticket, created.secret)
    onClose()
  }, [canSave, trimmedName, trimmedScope, draft, createMutation, onSaved, onClose])

  const remove = React.useCallback(async () => {
    if (mode !== 'edit' || !ticket) {
      return
    }
    await deleteMutation.mutateAsync(ticket.id)
    onDeleted?.()
    onClose()
  }, [mode, ticket, deleteMutation, onDeleted, onClose])

  const revoke = React.useCallback(async () => {
    if (mode !== 'edit' || !ticket) {
      return
    }
    await revokeMutation.mutateAsync(ticket.id)
    onClose()
  }, [mode, ticket, revokeMutation, onClose])

  const onFormKeyDown = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void save()
    }
  }

  const targetsData = targetsQuery.data

  const scopeOptions = React.useMemo(
    () => (targetsData ?? []).map(target => ({ value: target.name, label: target.name })),
    [targetsData],
  )

  const presetOptions = React.useMemo(() => [
    ...EXPIRES_PRESETS.map(preset => ({ value: preset.value, label: t(`tickets.form.expiresPresets.${preset.value}`) })),
    { value: 'custom', label: t('tickets.form.expiresPresets.custom') },
  ], [t])

  const previewExpiresIn = expiresError ? '—' : formatTicketExpiresIn(draft.expiresAt)
  const showSoonHint = !expiresError && draft.expiresAt && isTicketExpiringSoon({ state: 'active', expiresAt: draft.expiresAt })

  const header = (
    <div className="flex items-start gap-3 border-b border-border px-6 py-5">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-foreground">
        <Key size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <FormDialogTitle className="m-0 flex items-center gap-2 truncate text-[17px] font-semibold leading-tight">
          <span className="truncate">
            {mode === 'create' ? t('tickets.form.titleNew') : (trimmedName || ticket?.name || t('tickets.form.titleEdit'))}
          </span>
          {ticket
            ? <Badge tone={STATE_TONE[ticket.state]}>{t(`tickets.state.${ticket.state}`)}</Badge>
            : null}
        </FormDialogTitle>
        <FormDialogDescription className="mt-0.5 truncate text-[13px] text-muted-foreground">
          {mode === 'create' ? t('tickets.form.descNew') : t('tickets.form.descEdit')}
        </FormDialogDescription>
      </div>
    </div>
  )

  return (
    <>
      <FormDialog
        open={open}
        onClose={onClose}
        width="lg"
        dirty={isDirty}
        discardTitle={t('tickets.unsaved.title')}
        discardBody={t('tickets.unsaved.body')}
        discardLabel={t('tickets.unsaved.discard')}
        finalFocusRef={finalFocusRef}
        header={header}
        footer={requestClose => (
          <DrawerFooter
            leftAction={mode === 'edit' && ticket
              ? (
                  <div className="flex items-center gap-1.5">
                    {ticket.state === 'active'
                      ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirmRevoke(true)}
                            disabled={revokeMutation.isPending}
                          >
                            <X size={13} />
                            <span>{t('tickets.actions.revoke')}</span>
                          </Button>
                        )
                      : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-[hsl(var(--destructive))]"
                      onClick={() => setConfirmDelete(true)}
                      disabled={deleteMutation.isPending}
                    >
                      <Trash2 size={13} />
                      <span>{t('actions.delete')}</span>
                    </Button>
                  </div>
                )
              : undefined}
            onCancel={requestClose}
            hideSave={isReadOnly}
            saveAsSubmit
            form="ticket-form-dialog-form"
            saveDisabled={!canSave}
            saveLabel={mode === 'create' ? t('tickets.actions.newTicket') : undefined}
          />
        )}
      >
        <form
          id="ticket-form-dialog-form"
          className="flex w-full flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
          onKeyDown={onFormKeyDown}
        >
          {ticket
            ? (
                <div className="rounded-md border border-border bg-[hsl(var(--muted)/0.4)] px-3 py-2.5 text-[12.5px] text-muted-foreground">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>
                      {t('tickets.form.issuedBy')}
                      :
                      {' '}
                      <span className="text-foreground">{ticket.issuedBy}</span>
                    </span>
                    <span>·</span>
                    <span>
                      {t('tickets.form.issuedAt')}
                      :
                      {' '}
                      <span className="mono">{ticket.issuedAt.replace('T', ' ').slice(0, 16)}</span>
                    </span>
                    <span>·</span>
                    <span className="mono">{ticket.id}</span>
                  </div>
                </div>
              )
            : null}

          <div>
            <Label htmlFor="ticket-name">{t('fields.name')}</Label>
            <Input
              ref={nameRef}
              id="ticket-name"
              value={draft.name}
              onChange={(event) => {
                patch('name', event.target.value)
                if (!touched) {
                  setTouched(true)
                }
              }}
              placeholder={t('tickets.form.namePlaceholder')}
              disabled={isReadOnly}
              aria-invalid={touched && nameError ? true : undefined}
              aria-describedby={touched && nameError ? 'ticket-name-error' : undefined}
            />
            {touched && nameError
              ? (
                  <div id="ticket-name-error" className="mt-1.5 text-[12px] text-destructive">
                    {t('tickets.errors.nameRequired')}
                  </div>
                )
              : null}
          </div>

          <div>
            <Label htmlFor="ticket-scope">{t('tickets.fields.scope')}</Label>
            <Select
              id="ticket-scope"
              value={draft.scope}
              onValueChange={(value) => {
                patch('scope', value)
                if (!touched) {
                  setTouched(true)
                }
              }}
              options={scopeOptions}
              placeholder={t('tickets.form.scopePlaceholder')}
              disabled={isReadOnly}
            />
            {touched && scopeError
              ? (
                  <div id="ticket-scope-error" className="mt-1.5 text-[12px] text-destructive">
                    {t('tickets.errors.scopeRequired')}
                  </div>
                )
              : (
                  <div id="ticket-scope-hint" className="mt-1.5 text-[12px] text-muted-foreground">
                    {t('tickets.form.scopeHint')}
                  </div>
                )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ticket-uses-limit">{t('tickets.form.usesLabel')}</Label>
              <Input
                id="ticket-uses-limit"
                icon={Hash}
                type="number"
                min={1}
                max={9999}
                step={1}
                className="mono"
                value={!unlimitedUses && Number.isFinite(draft.usesLimit) ? String(draft.usesLimit) : ''}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10)
                  patch('usesLimit', Number.isNaN(parsed) ? Number.NaN : parsed)
                  if (!touched) {
                    setTouched(true)
                  }
                }}
                disabled={isReadOnly || unlimitedUses}
                aria-invalid={touched && usesError ? true : undefined}
                aria-describedby={touched && usesError ? 'ticket-uses-limit-error' : 'ticket-uses-limit-hint'}
              />
              <Checkbox
                className="mt-2 text-[12.5px]"
                label={t('tickets.form.usesUnlimited')}
                checked={unlimitedUses}
                onCheckedChange={checked => patch('usesLimit', checked ? 0 : 1)}
                disabled={isReadOnly}
              />
              {touched && usesError
                ? <div id="ticket-uses-limit-error" className="mt-1.5 text-[12px] text-destructive">{t('tickets.errors.usesInvalid')}</div>
                : (
                    <div id="ticket-uses-limit-hint" className="mt-1.5 text-[12px] text-muted-foreground">
                      {ticket
                        ? ticketUsesLabel(t, ticket.usesLeft)
                        : t('tickets.form.usesHint')}
                    </div>
                  )}
            </div>
            <div>
              <Label htmlFor="ticket-expires-preset">{t('tickets.form.expiresLabel')}</Label>
              <Select
                id="ticket-expires-preset"
                value={PRESET_KEYS.has(draft.expiresPreset) ? draft.expiresPreset : 'custom'}
                onValueChange={onPresetChange}
                options={presetOptions}
                disabled={isReadOnly}
              />
              <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Clock size={11} />
                <span>{t('tickets.form.expiresPreview', { when: previewExpiresIn })}</span>
                {showSoonHint
                  ? (
                      <span className="ml-auto flex items-center gap-1 text-[hsl(var(--destructive))]">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-[hsl(var(--destructive))]" />
                        <span>{t('tickets.form.expiresSoon')}</span>
                      </span>
                    )
                  : null}
              </div>
            </div>
          </div>

          {(draft.expiresPreset === 'custom' || !PRESET_KEYS.has(draft.expiresPreset))
            ? (
                <div>
                  <Label htmlFor="ticket-expires-at">{t('tickets.form.customDateLabel')}</Label>
                  <Input
                    id="ticket-expires-at"
                    icon={Calendar}
                    type="datetime-local"
                    className="mono"
                    value={toLocalInputValue(draft.expiresAt)}
                    onChange={event => onCustomDateChange(event.target.value)}
                    disabled={isReadOnly}
                    aria-invalid={touched && expiresError ? true : undefined}
                    aria-describedby={touched && expiresError ? 'ticket-expires-at-error' : undefined}
                  />
                  {touched && expiresError
                    ? <div id="ticket-expires-at-error" className="mt-1.5 text-[12px] text-destructive">{t('tickets.errors.expiresInvalid')}</div>
                    : null}
                </div>
              )
            : null}

          <div>
            <Label htmlFor="ticket-purpose">{t('tickets.form.purposeLabel')}</Label>
            <Textarea
              id="ticket-purpose"
              rows={3}
              value={draft.purpose}
              onChange={event => patch('purpose', event.target.value)}
              placeholder={t('tickets.form.purposePlaceholder')}
              disabled={isReadOnly}
            />
            <div className="mt-1.5 text-[12px] text-muted-foreground">{t('tickets.form.purposeHint')}</div>
          </div>

          {isReadOnly && ticket
            ? (
                <div className="rounded-md border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.08)] p-3 text-[12.5px]">
                  <div className="font-semibold text-foreground">
                    {t('tickets.form.details')}
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    {t('tickets.form.immutableHint')}
                  </div>
                </div>
              )
            : null}
        </form>
      </FormDialog>

      <Dialog open={confirmRevoke} onClose={() => setConfirmRevoke(false)} width={440}>
        <div className="flex flex-col">
          <div className="px-6 pb-3 pt-5">
            <h3 className="m-0 text-[16px] font-semibold">{t('tickets.revoke.title')}</h3>
            <p className="mt-2 text-[13.5px] text-muted-foreground">
              {t('tickets.revoke.body', { name: ticket?.name ?? '' })}
            </p>
            <div className="mt-3 rounded-md border border-border bg-[hsl(var(--muted)/0.4)] p-3 text-[12.5px] text-muted-foreground">
              {t('tickets.revoke.auditHint')}
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-3">
            <Button variant="outline" onClick={() => setConfirmRevoke(false)}>{t('actions.cancel')}</Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmRevoke(false)
                void revoke()
              }}
              disabled={revokeMutation.isPending}
            >
              {t('tickets.actions.revoke')}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} width={440}>
        <div className="flex flex-col">
          <div className="px-6 pb-3 pt-5">
            <h3 className="m-0 text-[16px] font-semibold">{t('tickets.delete.title')}</h3>
            <p className="mt-2 text-[13.5px] text-muted-foreground">
              {t('tickets.delete.body', { name: ticket?.name ?? '' })}
            </p>
            {ticket?.state === 'active'
              ? (
                  <div className="mt-3 rounded-md border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.08)] p-3 text-[12.5px] text-[hsl(var(--warning))]">
                    <div className="font-semibold">{t('tickets.delete.warnTitle')}</div>
                    <div className="text-muted-foreground">
                      {ticketDeleteWarning(t, ticket.usesLeft)}
                    </div>
                  </div>
                )
              : null}
          </div>
          <div className="flex justify-end gap-2 border-t border-border px-6 py-3">
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>{t('actions.cancel')}</Button>
            {ticket?.state === 'active'
              ? (
                  <Button
                    onClick={() => {
                      setConfirmDelete(false)
                      void revoke()
                    }}
                    disabled={revokeMutation.isPending}
                  >
                    {t('tickets.delete.revokeInstead')}
                  </Button>
                )
              : (
                  <Button
                    variant="destructive"
                    onClick={() => {
                      setConfirmDelete(false)
                      void remove()
                    }}
                    disabled={deleteMutation.isPending}
                  >
                    {t('actions.delete')}
                  </Button>
                )}
          </div>
        </div>
      </Dialog>
    </>
  )
}
