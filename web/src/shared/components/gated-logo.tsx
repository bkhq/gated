import { DEFAULT_SITE_TITLE } from '@/shared/hooks/use-site-title'
import { cn } from '@/shared/lib/utils'

export function GatedMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <path d="M16 2 4 6v9c0 7.2 5.1 13 12 15 6.9-2 12-7.8 12-15V6L16 2Z" fill="hsl(var(--foreground))" />
      <path d="M11 12v8M16 11v10M21 12v8M9 14h14" stroke="hsl(var(--background))" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

export function GatedLogo({ compact = false, title = DEFAULT_SITE_TITLE }: { compact?: boolean, title?: string }) {
  return (
    <div className="inline-flex min-w-0 items-center gap-2.5">
      <GatedMark />
      {!compact && <span className="truncate text-base font-bold tracking-normal">{title}</span>}
    </div>
  )
}

/** Centered logo + site title used on the standalone entry screens. */
export function BrandHero({ title, heading = false, className }: { title: string, heading?: boolean, className?: string }) {
  const Title = heading ? 'h1' : 'p'
  return (
    <div className={cn('flex flex-col items-center gap-3 text-center', className)}>
      <GatedMark size={44} />
      <Title className="m-0 max-w-full break-words text-xl font-semibold tracking-tight text-foreground">{title}</Title>
    </div>
  )
}
