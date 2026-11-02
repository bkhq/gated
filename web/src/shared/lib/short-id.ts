const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function shortId(id: string): string {
  if (UUID_PATTERN.test(id)) {
    return id.slice(0, 8)
  }
  return id.length <= 12 ? id : `${id.slice(0, 8)}…`
}
