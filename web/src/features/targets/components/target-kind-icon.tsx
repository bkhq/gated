import type { LucideIcon } from 'lucide-react'
import type { TargetKind } from '@/shared/types/domain'
import { Database, Globe, Network, Terminal } from 'lucide-react'

interface KindVisual {
  icon: LucideIcon
  hue: string
}

const KIND: Record<TargetKind, KindVisual> = {
  ssh: { icon: Terminal, hue: '210 86% 60%' },
  mysql: { icon: Database, hue: '36 85% 55%' },
  postgres: { icon: Database, hue: '198 78% 48%' },
  http: { icon: Globe, hue: '160 65% 45%' },
}

const FALLBACK: KindVisual = { icon: Network, hue: '210 12% 50%' }

export function TargetKindIcon({ kind, size = 32 }: { kind: TargetKind, size?: number }) {
  const visual = KIND[kind] ?? FALLBACK
  const Icon = visual.icon
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-lg"
      style={{
        width: size,
        height: size,
        background: `hsl(${visual.hue} / 0.14)`,
        color: `hsl(${visual.hue})`,
      }}
    >
      <Icon size={Math.round(size * 0.45)} />
    </span>
  )
}
