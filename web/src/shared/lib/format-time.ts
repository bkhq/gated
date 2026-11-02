const ISO_PATTERN = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/
const RELATIVE_LIMIT_SECONDS = 7 * 86_400

// Date.parse only guarantees millisecond precision; trim longer fractions (e.g. nanoseconds).
function parseIso(iso: string): Date | null {
  const match = ISO_PATTERN.exec(iso.trim())
  if (!match) {
    return null
  }
  const [, base, fraction, zone] = match
  const ms = fraction ? `.${fraction.slice(0, 3).padEnd(3, '0')}` : ''
  const date = new Date(`${base!.replace(' ', 'T')}${ms}${zone ?? ''}`)
  return Number.isNaN(date.getTime()) ? null : date
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
  return parts.find(p => p.type === type)?.value ?? ''
}

export function formatDateTime(iso: string, locale: string, now: number = Date.now()): string {
  const date = parseIso(iso)
  if (!date) {
    return iso
  }
  const withYear = date.getFullYear() !== new Date(now).getFullYear()
  if (locale.startsWith('zh')) {
    const parts = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
    const day = `${part(parts, 'month')}-${part(parts, 'day')}`
    const time = `${part(parts, 'hour')}:${part(parts, 'minute')}:${part(parts, 'second')}`
    return `${withYear ? `${part(parts, 'year')}-` : ''}${day} ${time}`
  }
  return new Intl.DateTimeFormat(locale, {
    year: withYear ? 'numeric' : undefined,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date)
}

export function formatFullDateTime(iso: string, locale: string): string {
  const date = parseIso(iso)
  if (!date) {
    return iso
  }
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).format(date)
}

export function formatRelativeTime(iso: string, locale: string, now: number = Date.now()): string {
  const date = parseIso(iso)
  if (!date) {
    return iso
  }
  const seconds = Math.round((date.getTime() - now) / 1000)
  const abs = Math.abs(seconds)
  if (abs >= RELATIVE_LIMIT_SECONDS) {
    return formatDateTime(iso, locale, now)
  }
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (abs < 60) {
    return rtf.format(seconds, 'second')
  }
  if (abs < 3_600) {
    return rtf.format(Math.round(seconds / 60), 'minute')
  }
  if (abs < 86_400) {
    return rtf.format(Math.round(seconds / 3_600), 'hour')
  }
  return rtf.format(Math.round(seconds / 86_400), 'day')
}
