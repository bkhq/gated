import { useTranslation } from 'react-i18next'
import { Select } from '@/shared/ui/select'

/** Picks from the offered lifetimes how long a browser session stays signed in without activity. */
export function SessionLifetimeSelect({ id, value, options, onValueChange, disabled }: {
  id: string
  value: number
  options: number[]
  onValueChange: (seconds: number) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  return (
    <Select
      id={id}
      value={String(value)}
      disabled={disabled}
      onValueChange={next => onValueChange(Number(next))}
      options={options.map(seconds => ({
        value: String(seconds),
        label: seconds % 3600 === 0
          ? t('sessionLifetime.hours', { count: seconds / 3600 })
          : t('sessionLifetime.minutes', { count: Math.round(seconds / 60) }),
      }))}
    />
  )
}
