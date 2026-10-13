import type { CommandReviewItem } from '@/shared/lib/api/command-reviews'
import { Check, Gavel, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  useApproveCommandReview,
  useCommandReviews,
  useRejectCommandReview,
} from '@/features/command-reviews/hooks/use-command-reviews-queries'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { StatCard } from '@/shared/components/stat-card'
import { Avatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import { Skeleton } from '@/shared/ui/skeleton'

function formatTs(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime()))
    return value
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function CommandReviewsPage() {
  const { t } = useTranslation()
  const reviewsQuery = useCommandReviews()
  const reviews = reviewsQuery.data ?? []
  const isLoading = reviewsQuery.isLoading

  return (
    <>
      <PageHeader
        title={t('nav.adminCommandReviews')}
        description={t('commandReviews.description')}
        breadcrumbs={[{ label: t('section.admin') }, { label: t('nav.adminCommandReviews') }]}
      />

      <div className="grid gap-3 px-6 pt-4 sm:grid-cols-2">
        <StatCard label={t('commandReviews.stats.pending')} value={reviews.length} icon={Gavel} />
      </div>

      <div className="flex flex-col gap-3 px-6 pb-6 pt-4">
        {isLoading
          ? Array.from({ length: 3 }, (_, index) => <Skeleton key={`review-skeleton-${index}`} className="h-[92px] w-full rounded-lg" />)
          : reviews.length === 0
            ? (
                <EmptyState
                  icon={Gavel}
                  title={t('commandReviews.empty.title')}
                  description={t('commandReviews.empty.description')}
                />
              )
            : reviews.map(review => <ReviewCard key={review.id} review={review} />)}
      </div>
    </>
  )
}

function ReviewCard({ review }: { review: CommandReviewItem }) {
  const { t } = useTranslation()
  const approve = useApproveCommandReview()
  const reject = useRejectCommandReview()
  const busy = approve.isPending || reject.isPending

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Avatar name={review.username ?? '?'} size={20} />
              <span className="text-foreground">{review.username ?? t('commandReviews.unknownUser')}</span>
            </span>
            <span aria-hidden="true">·</span>
            <span className="mono">{review.target_name}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular">{formatTs(review.requested_at)}</span>
            {review.acl_rule_name
              ? (
                  <>
                    <span aria-hidden="true">·</span>
                    <Badge tone="warning">{review.acl_rule_name}</Badge>
                  </>
                )
              : null}
          </div>
          <pre className="mono m-0 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/50 px-3 py-2 text-[12.5px] text-foreground">
            {review.command}
          </pre>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => { void reject.mutateAsync(review.id) }}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <X size={14} />
            <span>{t('commandReviews.actions.reject')}</span>
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => { void approve.mutateAsync(review.id) }}
          >
            <Check size={14} />
            <span>{t('commandReviews.actions.approve')}</span>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
