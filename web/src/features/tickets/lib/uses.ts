import type { TFunction } from 'i18next'

/** Remaining uses of a ticket; `null` means unlimited. */
export function ticketUsesLabel(t: TFunction, usesLeft: number | null): string {
  return usesLeft === null ? t('tickets.uses.unlimited') : t('tickets.uses.left', { count: usesLeft })
}

export function ticketDeleteWarning(t: TFunction, usesLeft: number | null): string {
  return usesLeft === null
    ? t('tickets.delete.warnBodyUnlimited')
    : t('tickets.delete.warnBody', { uses: usesLeft })
}
