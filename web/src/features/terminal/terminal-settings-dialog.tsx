import type { TerminalSettings, TerminalThemeName } from './terminal-settings'
import { RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import { Dialog, DialogBody, DialogFooter, DialogHeader } from '@/shared/ui/dialog'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Select } from '@/shared/ui/select'
import { Switch } from '@/shared/ui/switch'
import {
  DEFAULT_TERMINAL_SETTINGS,
  FONT_PRESETS,
  FONT_SIZES,
  TERMINAL_THEMES,
  terminalTheme,
} from './terminal-settings'

export interface TerminalSettingsDialogProps {
  open: boolean
  settings: TerminalSettings
  onChange: (patch: Partial<TerminalSettings>) => void
  onClose: () => void
}

const THEMES = Object.keys(TERMINAL_THEMES) as TerminalThemeName[]
const PADDINGS = [0, 4, 8, 12, 16, 24, 32]

/** Appearance and clipboard settings of the web terminal; changes apply immediately. */
export function TerminalSettingsDialog({ open, settings, onChange, onClose }: TerminalSettingsDialogProps) {
  const { t } = useTranslation()
  const theme = terminalTheme(settings)
  const preset = FONT_PRESETS.find(item => item.family === settings.fontFamily)?.id ?? 'custom'

  const colorField = (field: 'foreground' | 'background') => (
    <div className="flex items-center gap-2">
      <Label htmlFor={`terminal-${field}`} className="w-24 shrink-0">{t(`terminal.settings.${field}`)}</Label>
      <input
        id={`terminal-${field}`}
        type="color"
        className="h-8 w-12 cursor-pointer rounded border border-border bg-transparent"
        value={settings[field] ?? String(theme[field])}
        onChange={event => onChange({ [field]: event.target.value })}
      />
      {settings[field]
        ? (
            <Button variant="ghost" size="icon-sm" aria-label={t('terminal.settings.resetColor')} title={t('terminal.settings.resetColor')} onClick={() => onChange({ [field]: null })}>
              <RotateCcw size={13} />
            </Button>
          )
        : null}
    </div>
  )

  const toggle = (field: 'scrollbar' | 'copyOnSelect' | 'clipboardShortcuts') => (
    <div className="flex items-center justify-between gap-3 text-[13px]">
      <span aria-hidden="true">{t(`terminal.settings.${field}`)}</span>
      <Switch checked={settings[field]} onCheckedChange={checked => onChange({ [field]: checked })} aria-label={t(`terminal.settings.${field}`)} />
    </div>
  )

  return (
    <Dialog open={open} onClose={onClose} width={460}>
      <DialogHeader title={t('terminal.settings.title')} onClose={onClose} />
      <DialogBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="terminal-theme">{t('terminal.settings.theme')}</Label>
          <Select
            id="terminal-theme"
            value={settings.theme}
            onValueChange={value => onChange({ theme: value as TerminalThemeName })}
            options={THEMES.map(name => ({ value: name, label: t(`terminal.settings.themes.${name}`) }))}
          />
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {colorField('foreground')}
          {colorField('background')}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="terminal-font">{t('terminal.settings.font')}</Label>
          <Select
            id="terminal-font"
            value={preset}
            onValueChange={(value) => {
              const match = FONT_PRESETS.find(item => item.id === value)
              onChange({ fontFamily: match ? match.family : 'monospace' })
            }}
            options={[...FONT_PRESETS.map(item => item.id), 'custom'].map(id => ({ value: id, label: t(`terminal.settings.fonts.${id}`) }))}
          />
          {preset === 'custom'
            ? (
                <Input
                  aria-label={t('terminal.settings.customFont')}
                  className="mono text-[12px]"
                  value={settings.fontFamily}
                  placeholder="&quot;Fira Code&quot;, monospace"
                  onChange={event => onChange({ fontFamily: event.target.value })}
                />
              )
            : null}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="terminal-font-size">{t('terminal.settings.fontSize')}</Label>
            <Select
              id="terminal-font-size"
              value={String(settings.fontSize)}
              onValueChange={value => onChange({ fontSize: Number(value) })}
              options={FONT_SIZES.map(size => ({ value: String(size), label: String(size) }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="terminal-padding">{t('terminal.settings.padding')}</Label>
            <Select
              id="terminal-padding"
              value={String(settings.padding)}
              onValueChange={value => onChange({ padding: Number(value) })}
              options={PADDINGS.map(size => ({ value: String(size), label: String(size) }))}
            />
          </div>
        </div>
        <p className="m-0 -mt-2 text-[12px] text-muted-foreground">{t('terminal.settings.zoomHint')}</p>
        <div className="flex flex-col gap-3">
          {toggle('scrollbar')}
          {toggle('copyOnSelect')}
          {toggle('clipboardShortcuts')}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={() => onChange(DEFAULT_TERMINAL_SETTINGS)}>{t('terminal.settings.reset')}</Button>
        <Button size="sm" onClick={onClose}>{t('actions.close')}</Button>
      </DialogFooter>
    </Dialog>
  )
}
