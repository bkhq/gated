import type { LogEntry } from '@/shared/lib/api/logs'
import type { AuditEntry } from '@/shared/types/domain'

function ageDaysSince(iso: string): number {
  const t = Date.parse(iso)
  if (Number.isNaN(t))
    return 0
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000))
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * An audit row: the event's own user, else its session's; target, protocol
 * and client address from the session, else from the event fields.
 */
export function adaptLog(entry: LogEntry): AuditEntry {
  const values = (entry.values && typeof entry.values === 'object' && !Array.isArray(entry.values))
    ? entry.values as Record<string, unknown>
    : {}
  const session = entry.session ?? null
  return {
    id: entry.id,
    at: entry.timestamp,
    actor: entry.username ?? session?.username ?? 'system',
    action: entry.text,
    values,
    sessionId: entry.session_id,
    target: session?.target ?? text(values.target),
    protocol: session?.protocol ?? text(values.protocol),
    clientAddress: session?.client_address ?? text(values.client_ip),
    sessionStarted: session?.started ?? null,
    sessionEnded: session?.ended ?? null,
    ageDays: ageDaysSince(entry.timestamp),
  }
}

/** One JSONL export line with every field the table shows and the event fields. */
export function auditExportLine(entry: AuditEntry): string {
  return JSON.stringify({
    id: entry.id,
    at: entry.at,
    actor: entry.actor,
    action: entry.action,
    sessionId: entry.sessionId,
    target: entry.target,
    protocol: entry.protocol,
    clientAddress: entry.clientAddress,
    sessionStarted: entry.sessionStarted,
    sessionEnded: entry.sessionEnded,
    fields: entry.values,
  })
}
