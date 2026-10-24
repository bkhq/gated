import type { TargetView } from '@/features/targets/hooks/use-target-view'
import { LayoutGrid, List } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function TargetViewToggle({ view, onChange }: { view: TargetView, onChange: (view: TargetView) => void }) {
  const { t } = useTranslation()
  return (
    <div
      role="group"
      aria-label={t('a11y.targets.viewModeGroup')}
      className="inline-flex rounded-md bg-muted p-[3px]"
    >
      {([['table', List, 'a11y.targets.viewTable'], ['grid', LayoutGrid, 'a11y.targets.viewGrid']] as const).map(([mode, Icon, labelKey]) => (
        <button
          key={mode}
          type="button"
          onClick={() => onChange(mode)}
          className={`focus-ring inline-flex h-[30px] w-9 items-center justify-center rounded-sm transition ${view === mode ? 'bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)]' : 'text-muted-foreground'}`}
          aria-label={t(labelKey)}
          aria-pressed={view === mode}
        >
          <Icon size={14} aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}
