import { expect, it } from 'vitest'
import { adaptLog, auditExportLine } from './audit-entry'

const base = { id: 'e1', text: 'Host key is unknown', timestamp: '2026-11-04T08:58:29Z', session_id: 's1' }

it('takes the user, target, protocol and address from the session when the event has none', () => {
  const entry = adaptLog({
    ...base,
    username: null,
    values: { fingerprint: 'SHA256:x' },
    session: { username: 'admin', target: 'prod-api', protocol: 'SSH', client_address: '10.0.0.9:51234', started: '2026-11-04T08:58:20Z', ended: null },
  })
  expect(entry).toMatchObject({ actor: 'admin', target: 'prod-api', protocol: 'SSH', clientAddress: '10.0.0.9:51234', sessionStarted: '2026-11-04T08:58:20Z' })
})

it('falls back to the event fields, then to system', () => {
  expect(adaptLog({ ...base, username: null, values: { target: 'db', protocol: 'MySQL', client_ip: '10.0.0.1' }, session: null }))
    .toMatchObject({ actor: 'system', target: 'db', protocol: 'MySQL', clientAddress: '10.0.0.1' })
})

it('exports every field the table shows plus the event fields', () => {
  const entry = adaptLog({
    ...base,
    username: 'admin',
    values: { fingerprint: 'SHA256:x' },
    session: { username: 'admin', target: 'prod-api', protocol: 'SSH', client_address: '10.0.0.9:51234', started: '2026-11-04T08:58:20Z', ended: '2026-11-04T09:00:00Z' },
  })
  expect(JSON.parse(auditExportLine(entry))).toEqual({
    id: 'e1',
    at: '2026-11-04T08:58:29Z',
    actor: 'admin',
    action: 'Host key is unknown',
    sessionId: 's1',
    target: 'prod-api',
    protocol: 'SSH',
    clientAddress: '10.0.0.9:51234',
    sessionStarted: '2026-11-04T08:58:20Z',
    sessionEnded: '2026-11-04T09:00:00Z',
    fields: { fingerprint: 'SHA256:x' },
  })
})
