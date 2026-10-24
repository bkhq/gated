import type { SortDir } from './sort'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'

export interface SortHeaderProps {
  label: string
  active: boolean
  dir: SortDir
  onClick: () => void
}

// Clickable table header that shows ascending/descending sort affordance.
// Place the parent <TH aria-sort={...}> to expose state to assistive tech;
// this component renders only the button itself.
export function SortHeader({ label, active, dir, onClick }: SortHeaderProps) {
  const Icon = active ? (dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring -mx-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-xs font-medium uppercase tracking-[0.04em] text-muted-foreground transition hover:text-foreground data-active:text-foreground"
      data-active={active || undefined}
    >
      <span>{label}</span>
      <Icon size={11} aria-hidden="true" className={active ? 'text-foreground' : ''} />
    </button>
  )
}
