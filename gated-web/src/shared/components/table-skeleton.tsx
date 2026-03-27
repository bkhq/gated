import { Skeleton } from '@/shared/components/ui/skeleton'

interface TableSkeletonProps {
  columns?: number
  rows?: number
}

export function TableSkeleton({ columns = 4, rows = 5 }: TableSkeletonProps) {
  return (
    <div className="rounded-md border">
      <div className="border-b bg-muted/40">
        <div className="flex items-center gap-4 px-4 h-10">
          {Array.from({ length: columns }).map((_, i) => (
            <Skeleton key={`hdr-${String(i)}`} className="h-3.5 flex-1 max-w-[120px]" />
          ))}
        </div>
      </div>
      <div>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={`row-${String(i)}`} className="flex items-center gap-4 px-4 h-12 border-b last:border-b-0">
            {Array.from({ length: columns }).map((_, j) => (
              <Skeleton key={`cell-${String(j)}`} className="h-4 flex-1 max-w-[160px]" />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
