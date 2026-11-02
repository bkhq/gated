export type TerminalKey
  = | 'esc' | 'tab' | 'ctrl-c' | 'ctrl-d' | 'ctrl-z' | 'ctrl-l'
    | 'up' | 'down' | 'left' | 'right'

const CONTROL_SEQUENCES: Record<Exclude<TerminalKey, 'up' | 'down' | 'left' | 'right'>, string> = {
  'esc': '\x1B',
  'tab': '\t',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  'ctrl-z': '\x1A',
  'ctrl-l': '\x0C',
}

const ARROW_FINALS = { up: 'A', down: 'B', right: 'C', left: 'D' } as const

/** Bytes for `key`; arrows use SS3 when the terminal is in application cursor mode. */
export function keySequence(key: TerminalKey, applicationCursor: boolean): string {
  if (key in ARROW_FINALS)
    return `\x1B${applicationCursor ? 'O' : '['}${ARROW_FINALS[key as keyof typeof ARROW_FINALS]}`
  return CONTROL_SEQUENCES[key as keyof typeof CONTROL_SEQUENCES]
}
