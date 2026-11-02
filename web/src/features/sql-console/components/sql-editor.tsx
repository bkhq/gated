import type { SqlRowLimit } from './sql-editor-constants'
import { Play } from 'lucide-react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/shared/ui/button'
import { Select } from '@/shared/ui/select'
import { SQL_ROW_LIMITS } from './sql-editor-constants'

export interface SqlEditorProps {
  value: string
  onChange: (next: string) => void
  limit: SqlRowLimit
  onLimitChange: (next: SqlRowLimit) => void
  disabled?: boolean
  running?: boolean
  onRun: () => void
}

export function SqlEditor({ value, onChange, limit, onLimitChange, disabled, running, onRun }: SqlEditorProps) {
  const { t } = useTranslation()

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      if (!disabled && !running)
        onRun()
    }
  }, [disabled, running, onRun])

  const limitOptions = SQL_ROW_LIMITS.map(n => ({
    value: String(n),
    label: t('sqlConsole.editor.limitOption', { count: n }),
  }))

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="text-[12px] font-semibold text-foreground">{t('sqlConsole.editor.title')}</div>
        <div className="flex items-center gap-2">
          <label htmlFor="sql-row-limit" className="text-[11.5px] text-muted-foreground">
            {t('sqlConsole.editor.limit')}
          </label>
          <Select
            id="sql-row-limit"
            value={String(limit)}
            onValueChange={(next) => {
              const parsed = Number(next)
              if (SQL_ROW_LIMITS.includes(parsed as SqlRowLimit))
                onLimitChange(parsed as SqlRowLimit)
            }}
            options={limitOptions}
            className="h-7 w-[110px] text-[12px]"
            disabled={disabled}
          />
          <Button
            type="button"
            size="sm"
            onClick={onRun}
            disabled={disabled || running || value.trim().length === 0}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            title={t('sqlConsole.editor.runHint')}
          >
            <Play size={12} />
            <span>{running ? t('sqlConsole.editor.running') : t('sqlConsole.editor.run')}</span>
          </Button>
        </div>
      </div>
      <textarea
        value={value}
        onChange={event => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={t('sqlConsole.editor.placeholder')}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className="mono min-h-[140px] w-full resize-y bg-background px-3 py-2.5 text-[13px] leading-[1.6] text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={t('sqlConsole.editor.ariaLabel')}
      />
    </div>
  )
}
