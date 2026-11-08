import type { TargetRef } from '@/shared/lib/api/target-ref'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Folder } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { listDirectory } from '@/shared/lib/api/sftp'
import { refName } from '@/shared/lib/api/target-ref'
import { cn } from '@/shared/lib/utils'
import { sortEntries } from './lib/entries'
import { joinPath } from './lib/paths'

function isWithin(cwd: string, path: string): boolean {
  return cwd === path || cwd.startsWith(path === '/' ? '/' : `${path}/`)
}

interface TreeContext {
  target: TargetRef
  cwd: string
  /** Rows the user opened or closed; others follow the current directory. */
  toggled: ReadonlyMap<string, boolean>
  onToggle: (path: string, open: boolean) => void
  onNavigate: (path: string) => void
}

function TreeNode({ context, path, name, depth }: { context: TreeContext, path: string, name: string, depth: number }) {
  const { t } = useTranslation()
  const { target, cwd, toggled, onToggle, onNavigate } = context
  const open = toggled.get(path) ?? isWithin(cwd, path)
  const listing = useQuery({
    queryKey: ['sftp', refName(target), typeof target === 'string' ? null : target.account ?? null, path],
    queryFn: async ({ signal }) => listDirectory(target, path, signal),
    retry: false,
    // A folder that cannot be read just shows no children.
    meta: { inlineError: true },
    enabled: open,
  })
  const folders = sortEntries((listing.data?.entries ?? []).filter(entry => entry.kind === 'dir'), { key: 'name', order: 'asc' })
  return (
    <li>
      <div
        className={cn('flex h-7 items-center gap-0.5 rounded pr-1 text-[13px] hover:bg-accent/60', cwd === path && 'bg-accent text-accent-foreground')}
        style={{ paddingLeft: 4 + depth * 12 }}
      >
        <button
          type="button"
          className="focus-ring inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground"
          aria-label={t(open ? 'files.tree.collapse' : 'files.tree.expand', { name })}
          aria-expanded={open}
          onClick={() => onToggle(path, !open)}
        >
          <ChevronRight size={13} className={cn('transition-transform', open && 'rotate-90')} />
        </button>
        <button
          type="button"
          className="focus-ring flex min-w-0 flex-1 items-center gap-1.5 rounded py-0.5 text-left"
          aria-current={cwd === path ? 'true' : undefined}
          onClick={() => onNavigate(path)}
        >
          <Folder size={14} className="shrink-0 text-[hsl(var(--primary))]" />
          <span className="truncate" title={name}>{name}</span>
        </button>
      </div>
      {open && folders.length > 0
        ? (
            <ul className="m-0 list-none p-0">
              {folders.map(folder => (
                <TreeNode key={folder.name} context={context} path={joinPath(path, folder.name)} name={folder.name} depth={depth + 1} />
              ))}
            </ul>
          )
        : null}
    </li>
  )
}

/** Folders from the root, loaded as they open; the path to the current one opens by itself. */
export function FileTree({ target, cwd, onNavigate }: { target: TargetRef, cwd: string, onNavigate: (path: string) => void }) {
  const { t } = useTranslation()
  const [toggled, setToggled] = React.useState<ReadonlyMap<string, boolean>>(() => new Map())
  const onToggle = (path: string, open: boolean) => setToggled(prev => new Map(prev).set(path, open))
  return (
    <nav aria-label={t('files.tree.label')} className="p-1.5">
      <ul className="m-0 list-none p-0">
        <TreeNode context={{ target, cwd, toggled, onToggle, onNavigate }} path="/" name="/" depth={0} />
      </ul>
    </nav>
  )
}
