import type { DesktopRecordingItem } from './desktop-recording'
import { describe, expect, it } from 'vitest'
import { itemsThrough, parseDesktopRecording, pointerBefore, recordingDuration, seekStart } from './desktop-recording'

const rect = { x: 0, y: 0, width: 4, height: 2 }
const items: DesktopRecordingItem[] = [
  { type: 'resize', time: 0, width: 4, height: 2 },
  { type: 'png_image', time: 0.1, rect, keyframe: true, data: 'AA==' },
  { type: 'pointer_input', time: 1, x: 3, y: 1, buttons: 0 },
  { type: 'jpeg_image', time: 2, rect, data: 'AA==' },
  { type: 'png_image', time: 10, rect, keyframe: true, data: 'AA==' },
  { type: 'key_input', time: 11, keysym: 0x61, down: true },
]

describe('parseDesktopRecording', () => {
  it('reads one item per line and skips what it cannot read', () => {
    const text = [
      JSON.stringify(items[0]),
      '',
      '{"type":"png_image","time":0.1,"rect":',
      '{"type":"from_the_future","time":1}',
      '{"time":2}',
      JSON.stringify(items[2]),
    ].join('\n')
    expect(parseDesktopRecording(text)).toEqual([items[0], items[2]])
  })
})

describe('recordingDuration', () => {
  it('is the time of the last item', () => {
    expect(recordingDuration(items)).toBe(11)
    expect(recordingDuration([])).toBe(0)
  })
})

describe('itemsThrough', () => {
  it('counts the items at or before a time', () => {
    expect(itemsThrough(items, -1)).toBe(0)
    expect(itemsThrough(items, 0.1)).toBe(2)
    expect(itemsThrough(items, 5)).toBe(4)
    expect(itemsThrough(items, 99)).toBe(6)
  })
})

describe('seekStart', () => {
  it('continues from where playback is when no keyframe is in between', () => {
    expect(seekStart(items, 2, 4)).toBe(2)
  })

  it('jumps to the last keyframe when one lies ahead', () => {
    expect(seekStart(items, 2, 6)).toBe(4)
  })

  it('restarts from the last keyframe when going back', () => {
    expect(seekStart(items, 6, 3)).toBe(1)
    expect(seekStart(items, 6, 5)).toBe(4)
  })

  it('restarts from the beginning before the first keyframe', () => {
    expect(seekStart(items, 4, 1)).toBe(0)
  })
})

describe('pointerBefore', () => {
  it('is the last pointer position before an item', () => {
    expect(pointerBefore(items, 2)).toBeNull()
    expect(pointerBefore(items, 5)).toEqual({ x: 3, y: 1 })
  })
})
