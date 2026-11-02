import { afterEach, describe, expect, it, vi } from 'vitest'
import { listManagementSessions, revokeManagementSession } from './management-sessions'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('management sessions', () => {
  it('lists browser sessions from the admin API', async () => {
    const sessions = [{ id: 's1', username: 'alice', created: '2026-09-29T00:00:00Z', last_active: '2026-09-29T00:01:00Z', current: true }]
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(sessions), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    expect(await listManagementSessions()).toEqual(sessions)
    expect(fetch).toHaveBeenCalledWith('/admin/api/management-sessions', expect.objectContaining({ method: 'GET' }))
  })

  it('revokes one browser session by id', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    await revokeManagementSession('s/1')
    expect(fetch).toHaveBeenCalledWith('/admin/api/management-sessions/s%2F1', expect.objectContaining({ method: 'DELETE' }))
  })
})
