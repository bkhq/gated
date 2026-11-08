import { ChevronRight, Pencil } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/shared/lib/utils'
import { Input } from '@/shared/ui/input'
import { pathSegments } from './lib/paths'

/** Chevron-separated path; the empty area or the pencil switches to typing a path. */
export function PathBar({ cwd, onNavigate }: { cwd: string, onNavigate: (path: string) => void }) {
  const { t } = useTranslation()
  // null = show the current directory; a string while the user edits the path.
  const [draft, setDraft] = React.useState<string | null>(null)

  if (draft !== null) {
    return (
      <form
        className="min-w-[160px] flex-1"
        onSubmit={(event) => {
          event.preventDefault()
          if (draft.trim()) {
            setDraft(null)
            onNavigate(draft.trim())
          }
        }}
      >
        <Input
          className="mono text-[12.5px]"
          wrapperClassName="h-8"
          autoFocus
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape')
              setDraft(null)
          }}
          onBlur={() => setDraft(null)}
          aria-label={t('files.pathLabel')}
        />
      </form>
    )
  }

  const segments = pathSegments(cwd)
  return (
    <div
      className="flex h-8 min-w-[160px] flex-1 cursor-text items-center gap-1 pl-1 pr-0.5"
      onClick={(event) => {
        // Only clicks on the empty area switch to editing; segments navigate.
        if (event.target === event.currentTarget)
          setDraft(cwd)
      }}
    >
      <nav aria-label={t('files.breadcrumbs')} className="flex min-w-0 items-center gap-0.5 overflow-x-auto whitespace-nowrap text-[13px] [scrollbar-width:none]">
        {segments.map((segment, index) => (
          <React.Fragment key={segment.path}>
            {index > 0 ? <ChevronRight size={13} className="shrink-0 text-muted-foreground" /> : null}
            <button
              type="button"
              className={cn(
                'focus-ring max-w-48 shrink-0 truncate rounded px-1 py-0.5 hover:bg-accent hover:text-foreground',
                index === segments.length - 1 ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
              onClick={() => onNavigate(segment.path)}
            >
              {segment.name}
            </button>
          </React.Fragment>
        ))}
      </nav>
      <button
        type="button"
        className="focus-ring ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={t('files.editPath')}
        title={t('files.editPath')}
        onClick={() => setDraft(cwd)}
      >
        <Pencil size={13} />
      </button>
    </div>
  )
}
