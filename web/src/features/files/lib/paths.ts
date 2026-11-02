export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index <= 0 ? '/' : trimmed.slice(0, index)
}

/** Clickable segments of an absolute path, root first. */
export function pathSegments(path: string): { name: string, path: string }[] {
  const segments = [{ name: '/', path: '/' }]
  let current = ''
  for (const part of path.split('/').filter(Boolean)) {
    current = `${current}/${part}`
    segments.push({ name: part, path: current })
  }
  return segments
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null)
    return '—'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`
}

const TYPE_CHAR: Record<string, string> = { dir: 'd', symlink: 'l', file: '-' }

/** `ls -l` style mode string, e.g. `drwxr-xr-x`. */
export function formatMode(permissions: number | null | undefined, kind: string): string {
  if (permissions == null)
    return '—'
  const bits = 'rwxrwxrwx'
  let out = TYPE_CHAR[kind] ?? '?'
  for (let i = 0; i < 9; i++)
    out += permissions & (1 << (8 - i)) ? bits[i] : '-'
  return out
}
