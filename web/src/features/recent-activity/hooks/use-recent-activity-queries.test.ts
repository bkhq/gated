import type { LogEntry } from '@/shared/lib/api/logs'
import { describe, expect, it } from 'vitest'
import { aggregateRecentActivity } from './use-recent-activity-queries'

const NIL = '00000000-0000-0000-0000-000000000000'

function log(id: string, sessionId: string, text: string, timestamp: string, values: unknown = {}): LogEntry {
  return { id, session_id: sessionId, text, timestamp, username: 'admin', values }
}

describe('aggregateRecentActivity', () => {
  it('folds the entries of one session into a single row with event counts', () => {
    const rows = aggregateRecentActivity([
      log('5', 's1', 'sftp_file_operation', '2026-10-21T02:49:54.02Z'),
      log('4', 's1', 'web_file_operation', '2026-10-21T02:49:54.01Z'),
      log('3', 's1', 'sftp_file_operation', '2026-10-21T02:49:54.00Z'),
      log('2', 's1', 'Recording started', '2026-10-21T02:49:53.98Z'),
      log('1', 's1', 'Target connected', '2026-10-21T02:49:53.93Z', { target: 'test-ssh' }),
    ])
    expect(rows).toEqual([{
      id: 's1',
      sessionId: 's1',
      user: 'admin',
      target: 'test-ssh',
      latest: '2026-10-21T02:49:54.02Z',
      events: [
        { key: 'events.targetConnected', count: 1 },
        { key: 'events.recordingStarted', count: 1 },
        { key: 'events.fileOperation', count: 3 },
      ],
    }])
  })

  it('orders sessions newest first and caps the result at 8 rows', () => {
    const logs = Array.from({ length: 10 }, (_unused, i) =>
      log(String(i), `s${String(i)}`, 'Target connected', `2026-10-21T02:${String(10 + i)}:00Z`))
    const rows = aggregateRecentActivity(logs)
    expect(rows).toHaveLength(8)
    expect(rows.map(row => row.id)).toEqual(['s9', 's8', 's7', 's6', 's5', 's4', 's3', 's2'])
  })

  it('groups entries without a session id by event', () => {
    const rows = aggregateRecentActivity([
      log('3', NIL, 'auth_login_succeeded', '2026-10-21T03:00:00Z'),
      log('2', '', 'auth_logout', '2026-10-21T02:30:00Z'),
      log('1', NIL, 'auth_login_succeeded', '2026-10-21T02:00:00Z'),
    ])
    expect(rows.map(row => [row.sessionId, row.events])).toEqual([
      ['', [{ key: 'events.loginSucceeded', count: 2 }]],
      ['', [{ key: 'events.logout', count: 1 }]],
    ])
  })
})
