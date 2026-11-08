import type { SftpEntry } from '@/shared/lib/api/sftp'
import { describe, expect, it } from 'vitest'
import { applySelection, bytesToDataUrl, fileType, isBinary, NO_SELECTION, previewMode, sortEntries } from './entries'

function entry(name: string, kind: string, size: number | null = 1, mtime: number | null = 1): SftpEntry {
  return { name, kind, size, mtime, permissions: 0o644, user: null, group: null, uid: 0, gid: 0 }
}

describe('sortEntries', () => {
  const entries = [entry('b.log', 'file', 5, 30), entry('zdir', 'dir', 0, 10), entry('a10', 'file', 9, 20), entry('a2', 'file', 1, 40), entry('adir', 'dir', 0, 50)]
  const names = (key: 'name' | 'size' | 'mtime', order: 'asc' | 'desc') => sortEntries(entries, { key, order }).map(item => item.name)

  it('keeps directories first in either direction', () => {
    expect(names('name', 'asc')).toEqual(['adir', 'zdir', 'a2', 'a10', 'b.log'])
    expect(names('name', 'desc')).toEqual(['zdir', 'adir', 'b.log', 'a10', 'a2'])
  })

  it('sorts by size and modification time', () => {
    expect(names('size', 'desc')).toEqual(['adir', 'zdir', 'a10', 'b.log', 'a2'])
    expect(names('mtime', 'asc')).toEqual(['zdir', 'adir', 'a10', 'b.log', 'a2'])
  })
})

describe('applySelection', () => {
  const order = ['a', 'b', 'c', 'd']

  it('replaces, toggles and extends from the anchor', () => {
    const one = applySelection(NO_SELECTION, order, 'b', 'single')
    expect([...one.names]).toEqual(['b'])
    const two = applySelection(one, order, 'd', 'toggle')
    expect([...two.names].sort()).toEqual(['b', 'd'])
    expect([...applySelection(two, order, 'd', 'toggle').names]).toEqual(['b'])
    const range = applySelection(one, order, 'd', 'range')
    expect([...range.names].sort()).toEqual(['b', 'c', 'd'])
    expect(range.anchor).toBe('b')
    expect([...applySelection(range, order, 'a', 'range').names].sort()).toEqual(['a', 'b'])
  })

  it('treats a range without an anchor as a single selection', () => {
    expect([...applySelection(NO_SELECTION, order, 'c', 'range').names]).toEqual(['c'])
  })
})

describe('previewMode', () => {
  it('previews images and anything that may be text within the size limits', () => {
    expect(previewMode(entry('a.PNG', 'file', 1024))).toBe('image')
    expect(previewMode(entry('a.png', 'file', 21 * 1024 * 1024))).toBeNull()
    expect(previewMode(entry('nginx.conf', 'file', 1024))).toBe('text')
    expect(previewMode(entry('Dockerfile', 'file', 1024))).toBe('text')
    expect(previewMode(entry('big.log', 'file', 2 * 1024 * 1024))).toBeNull()
  })

  it('does not fetch media, archives, unknown sizes or non-files', () => {
    expect(previewMode(entry('a.mp4', 'file'))).toBeNull()
    expect(previewMode(entry('a.tar.gz', 'file'))).toBeNull()
    expect(previewMode(entry('a.txt', 'file', null))).toBeNull()
    expect(previewMode(entry('a.txt', 'symlink'))).toBeNull()
    expect(previewMode(entry('a', 'dir'))).toBeNull()
  })
})

describe('content helpers', () => {
  it('classifies by kind and extension', () => {
    expect(fileType(entry('x.png', 'dir'))).toBe('dir')
    expect(fileType(entry('x.zip', 'file'))).toBe('archive')
    expect(fileType(entry('x.yaml', 'file'))).toBe('text')
    expect(fileType(entry('x', 'file'))).toBe('other')
  })

  it('detects binary content by a NUL byte', () => {
    expect(isBinary(new TextEncoder().encode('plain\ntext'))).toBe(false)
    expect(isBinary(new Uint8Array([65, 0, 66]))).toBe(true)
  })

  it('encodes bytes as a data URL', () => {
    expect(bytesToDataUrl(new TextEncoder().encode('hi!'), 'image/png')).toBe('data:image/png;base64,aGkh')
  })
})
