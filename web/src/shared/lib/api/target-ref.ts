/**
 * A target by name, plus the account the user picked for it when their roles
 * offer several (`GET /api/targets/{name}/accounts`).
 */
export type TargetRef = string | { name: string, account?: string }

export function refName(ref: TargetRef): string {
  return typeof ref === 'string' ? ref : ref.name
}

/** `path` with the picked account appended as the `account` query parameter. */
export function withAccount(path: string, ref: TargetRef): string {
  const account = typeof ref === 'string' ? undefined : ref.account
  if (!account)
    return path
  return `${path}${path.includes('?') ? '&' : '?'}account=${encodeURIComponent(account)}`
}
