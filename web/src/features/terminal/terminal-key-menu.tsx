import type { TerminalKey } from './key-sequence'
import { Popover } from '@base-ui/react/popover'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Keyboard } from 'lucide-react'
import * as React from 'react'

export type TerminalKeyLabels = Record<TerminalKey, string> & { toolbar: string }

const DEFAULT_LABELS: TerminalKeyLabels = {
  'toolbar': 'Terminal keys',
  'esc': 'Esc',
  'tab': 'Tab',
  'ctrl-c': 'Ctrl+C',
  'ctrl-d': 'Ctrl+D',
  'ctrl-z': 'Ctrl+Z',
  'ctrl-l': 'Ctrl+L',
  'up': 'Up',
  'down': 'Down',
  'left': 'Left',
  'right': 'Right',
}

const TEXT_KEYS: readonly TerminalKey[] = ['esc', 'tab', 'ctrl-c', 'ctrl-d', 'ctrl-z', 'ctrl-l']
const ARROW_KEYS: readonly { key: TerminalKey, Icon: typeof ArrowUp }[] = [
  { key: 'left', Icon: ArrowLeft },
  { key: 'up', Icon: ArrowUp },
  { key: 'down', Icon: ArrowDown },
  { key: 'right', Icon: ArrowRight },
]

const KEY_CLASS = 'focus-ring inline-flex h-8 items-center justify-center rounded-md bg-white/5 px-2 font-mono text-[12px] text-zinc-200 hover:bg-white/10'

export interface TerminalKeyMenuProps {
  onKey: (key: TerminalKey) => void
  labels?: Partial<TerminalKeyLabels>
}

// Status-bar trigger that opens the special keys (Esc, Ctrl+…, arrows) in a
// popover. Each key hands focus back to the terminal; the popover ignores that
// focus-out so keys can be pressed repeatedly, and closes on an outside press,
// Escape or the trigger.
export function TerminalKeyMenu({ onKey, labels }: TerminalKeyMenuProps) {
  const merged: TerminalKeyLabels = { ...DEFAULT_LABELS, ...labels }
  // Keep focus in the terminal so the soft keyboard and cursor stay put.
  const keepFocus = React.useCallback((event: React.MouseEvent) => {
    event.preventDefault()
  }, [])

  const [open, setOpen] = React.useState(false)

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        if (!next && details.reason === 'focus-out')
          return
        setOpen(next)
      }}
    >
      <Popover.Trigger
        className="focus-ring inline-flex h-5 items-center gap-1 rounded px-1.5 hover:bg-white/10 hover:text-zinc-200 data-[popup-open]:bg-white/10 data-[popup-open]:text-zinc-200"
        aria-label={merged.toolbar}
        title={merged.toolbar}
      >
        <Keyboard size={13} />
        <span>{merged.toolbar}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={6} className="z-50 outline-none">
          <Popover.Popup
            initialFocus={false}
            finalFocus={false}
            className="w-[232px] rounded-lg border border-white/10 bg-[#161a22] p-2 shadow-[0_12px_30px_rgba(0,0,0,0.35)] outline-none"
          >
            <div role="toolbar" aria-label={merged.toolbar} className="grid grid-cols-3 gap-1.5">
              {TEXT_KEYS.map(key => (
                <button key={key} type="button" className={KEY_CLASS} onMouseDown={keepFocus} onClick={() => onKey(key)}>
                  {merged[key]}
                </button>
              ))}
            </div>
            <div className="mt-1.5 grid grid-cols-4 gap-1.5">
              {ARROW_KEYS.map(({ key, Icon }) => (
                <button
                  key={key}
                  type="button"
                  className={KEY_CLASS}
                  aria-label={merged[key]}
                  title={merged[key]}
                  onMouseDown={keepFocus}
                  onClick={() => onKey(key)}
                >
                  <Icon size={14} />
                </button>
              ))}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
