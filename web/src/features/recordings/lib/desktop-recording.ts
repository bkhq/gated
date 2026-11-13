interface Rect { x: number, y: number, width: number, height: number }

/** One line of a desktop recording, as the gateway writes it. */
export type DesktopRecordingItem
  = | { type: 'resize', time: number, width: number, height: number }
    | { type: 'png_image', time: number, rect: Rect, keyframe?: boolean, data: string }
    | { type: 'jpeg_image', time: number, rect: Rect, data: string }
    | { type: 'copy_rect', time: number, dst: Rect, src_x: number, src_y: number }
    | { type: 'key_input', time: number, keysym: number, down: boolean }
    | { type: 'scancode_input', time: number, code: number, extended: boolean, down: boolean }
    | { type: 'pointer_input', time: number, x: number, y: number, buttons: number }
    | { type: 'wheel_input', time: number, x: number, y: number, vertical: boolean, delta: number }
    | { type: 'clipboard_input', time: number, text: string }

const ITEM_TYPES = new Set<string>([
  'resize',
  'png_image',
  'jpeg_image',
  'copy_rect',
  'key_input',
  'scancode_input',
  'pointer_input',
  'wheel_input',
  'clipboard_input',
])

/**
 * The items of a recording. A line that does not parse is skipped: the last
 * line of a recording still being written is usually cut short.
 */
export function parseDesktopRecording(text: string): DesktopRecordingItem[] {
  const items: DesktopRecordingItem[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0)
      continue
    let value: unknown
    try {
      value = JSON.parse(line)
    }
    catch {
      continue
    }
    if (typeof value !== 'object' || value === null)
      continue
    const { type, time } = value as { type?: unknown, time?: unknown }
    if (typeof type === 'string' && ITEM_TYPES.has(type) && typeof time === 'number')
      items.push(value as DesktopRecordingItem)
  }
  return items
}

export function recordingDuration(items: DesktopRecordingItem[]): number {
  return items.at(-1)?.time ?? 0
}

/** How many items happened at or before `time`. */
export function itemsThrough(items: DesktopRecordingItem[], time: number): number {
  let low = 0
  let high = items.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (items[middle]!.time <= time)
      low = middle + 1
    else
      high = middle
  }
  return low
}

/**
 * Where to start drawing to show the first `target` items when the first
 * `applied` are already on screen: the last keyframe when it saves work or
 * when playback goes back, else where playback is.
 */
export function seekStart(items: DesktopRecordingItem[], applied: number, target: number): number {
  const floor = target >= applied ? applied : 0
  for (let index = target - 1; index >= floor; index--) {
    const item = items[index]!
    if (item.type === 'png_image' && item.keyframe === true)
      return index
  }
  return floor
}

/** The last pointer position among the first `end` items. */
export function pointerBefore(items: DesktopRecordingItem[], end: number): { x: number, y: number } | null {
  for (let index = end - 1; index >= 0; index--) {
    const item = items[index]!
    if (item.type === 'pointer_input')
      return { x: item.x, y: item.y }
  }
  return null
}
