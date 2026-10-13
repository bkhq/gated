import type { InputProps } from './input'
import { Eye, EyeOff } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from './input'

export interface PasswordInputProps extends Omit<InputProps, 'type' | 'suffix' | 'icon'> {
  toggleLabelShow?: string
  toggleLabelHide?: string
}

export function PasswordInput({ toggleLabelShow, toggleLabelHide, ...props }: PasswordInputProps) {
  const { t } = useTranslation()
  const [visible, setVisible] = React.useState(false)
  const showLabel = toggleLabelShow ?? t('shared.passwordInput.show')
  const hideLabel = toggleLabelHide ?? t('shared.passwordInput.hide')
  const label = visible ? hideLabel : showLabel
  const Icon = visible ? EyeOff : Eye
  return (
    <Input
      {...props}
      type={visible ? 'text' : 'password'}
      suffix={(
        <button
          type="button"
          onClick={() => setVisible(v => !v)}
          aria-pressed={visible}
          aria-label={label}
          title={label}
          className="focus-ring inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Icon size={14} aria-hidden="true" />
        </button>
      )}
    />
  )
}
