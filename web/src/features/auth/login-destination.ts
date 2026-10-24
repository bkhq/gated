export function loginDestination(search: string): string {
  const next = new URLSearchParams(search).get('next')
  if (!next || !next.startsWith('/') || next.startsWith('//') || /[\\\r\n\t]/.test(next) || /%(?:2f|5c|0[ad9])/i.test(next))
    return '/ui/'
  return next
}
