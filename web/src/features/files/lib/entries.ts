import type { SftpEntry } from '@/shared/lib/api/sftp'

export type SortKey = 'name' | 'size' | 'mtime'

export interface SortState {
  key: SortKey
  order: 'asc' | 'desc'
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Directories always come first; the order applies within each group. */
export function sortEntries(entries: readonly SftpEntry[], sort: SortState): SftpEntry[] {
  const direction = sort.order === 'asc' ? 1 : -1
  const value = (entry: SftpEntry) => (sort.key === 'size' ? entry.size : entry.mtime) ?? 0
  return [...entries].sort((a, b) => {
    const group = Number(b.kind === 'dir') - Number(a.kind === 'dir')
    if (group !== 0)
      return group
    if (sort.key === 'name')
      return direction * nameCollator.compare(a.name, b.name)
    return direction * (value(a) - value(b)) || nameCollator.compare(a.name, b.name)
  })
}

export interface Selection {
  names: ReadonlySet<string>
  anchor: string | null
}

export type SelectMode = 'single' | 'toggle' | 'range'

export const NO_SELECTION: Selection = { names: new Set(), anchor: null }

/** `order` is the visible order of the entries, used for Shift ranges. */
export function applySelection(current: Selection, order: readonly string[], name: string, mode: SelectMode): Selection {
  if (mode === 'toggle') {
    const names = new Set(current.names)
    if (!names.delete(name))
      names.add(name)
    return { names, anchor: name }
  }
  const from = current.anchor === null ? -1 : order.indexOf(current.anchor)
  if (mode === 'range' && from !== -1) {
    const to = order.indexOf(name)
    return { names: new Set(order.slice(Math.min(from, to), Math.max(from, to) + 1)), anchor: current.anchor }
  }
  return { names: new Set([name]), anchor: name }
}

export type FileType = 'dir' | 'symlink' | 'image' | 'video' | 'audio' | 'archive' | 'text' | 'other'

const EXTENSIONS: [Exclude<FileType, 'dir' | 'symlink' | 'other'>, string[]][] = [
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif']],
  ['video', ['mp4', 'mkv', 'webm', 'mov', 'avi']],
  ['audio', ['mp3', 'wav', 'flac', 'ogg', 'm4a']],
  ['archive', ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'deb', 'rpm', 'iso', 'jar']],
  ['text', ['txt', 'md', 'log', 'conf', 'cfg', 'ini', 'toml', 'yaml', 'yml', 'json', 'xml', 'csv', 'sh', 'py', 'js', 'ts', 'go', 'rs', 'c', 'h', 'sql', 'html', 'css']],
]

function extension(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1).toLowerCase()
}

export function fileType(entry: Pick<SftpEntry, 'name' | 'kind'>): FileType {
  if (entry.kind === 'dir' || entry.kind === 'symlink')
    return entry.kind
  if (entry.name.includes('.')) {
    const found = EXTENSIONS.find(([, list]) => list.includes(extension(entry.name)))
    if (found)
      return found[0]
  }
  return 'other'
}

const MAX_TEXT_PREVIEW = 1024 * 1024
const MAX_IMAGE_PREVIEW = 20 * 1024 * 1024

/**
 * How a file can be previewed, or null when it should not be fetched. Files
 * without a known type may still be text (`Dockerfile`, `.bashrc`, `hosts`);
 * `isBinary` rejects the ones that are not.
 */
export function previewMode(entry: SftpEntry): 'text' | 'image' | null {
  if (entry.kind !== 'file' || entry.size == null)
    return null
  const type = fileType(entry)
  if (type === 'image')
    return entry.size <= MAX_IMAGE_PREVIEW ? 'image' : null
  if (type === 'video' || type === 'audio' || type === 'archive')
    return null
  return entry.size <= MAX_TEXT_PREVIEW ? 'text' : null
}

export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8192).includes(0)
}

const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
}

export function imageMime(name: string): string {
  const ext = extension(name)
  return IMAGE_MIME[ext] ?? `image/${ext}`
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''
  // Chunked: String.fromCharCode cannot take megabytes of arguments.
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${mime};base64,${btoa(binary)}`
}
