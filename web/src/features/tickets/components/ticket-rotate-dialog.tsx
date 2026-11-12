import type { Ticket } from '@/shared/types/domain'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { useRotateTicket } from '../hooks/use-tickets-queries'

export interface TicketRotateDialogProps {
  /** The ticket to rotate; null closes the dialog. */
  ticket: Ticket | null
  onClose: () => void
  /** Receives the new secret, which is shown only once. */
  onRotated: (ticket: Ticket, secret: string) => void
}

/** Confirms replacing a ticket's secret, which ends the sessions opened with the old one. */
export function TicketRotateDialog({ ticket, onClose, onRotated }: TicketRotateDialogProps) {
  const { t } = useTranslation()
  const rotate = useRotateTicket()
  return (
    <Dialog open={ticket !== null} onClose={onClose} width={440}>
      <DialogHeader
        title={t('tickets.rotate.title')}
        description={t('tickets.rotate.body', { name: ticket?.name ?? '' })}
        onClose={onClose}
      />
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{t('actions.cancel')}</Button>
        <Button
          disabled={rotate.isPending}
          onClick={() => {
            if (!ticket)
              return
            rotate.mutate(ticket.id, {
              onSuccess: ({ secret }) => {
                onClose()
                onRotated(ticket, secret)
              },
            })
          }}
        >
          {t('tickets.actions.rotate')}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
