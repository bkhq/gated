/** `mm:ss`, or `h:mm:ss` from an hour on. */
export function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const pad = (value: number) => String(value).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const rest = `${pad(Math.floor(total % 3600 / 60))}:${pad(total % 60)}`
  return hours > 0 ? `${hours}:${rest}` : rest
}
