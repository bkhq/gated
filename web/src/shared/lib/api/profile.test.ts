import { afterEach, describe, expect, it, vi } from 'vitest'
import { setOnUnauthorized } from './http'
import { profileApi } from './profile'

afterEach(() => {
  vi.unstubAllGlobals()
  setOnUnauthorized(null)
})

describe('self-service credentials', () => {
  it('changes the password using both old and new credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    await profileApi.changePassword({ old_password: 'old', password: 'new' })
    expect(fetch).toHaveBeenCalledWith('/api/profile/credentials/password', expect.objectContaining({ method: 'POST', body: JSON.stringify({ old_password: 'old', password: 'new' }) }))
  })
  it('keeps the session when the current password is incorrect', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
    const unauthorized = vi.fn()
    setOnUnauthorized(unauthorized)
    await expect(profileApi.changePassword({ old_password: 'wrong', password: 'new' })).rejects.toThrow()
    expect(unauthorized).not.toHaveBeenCalled()
  })
  it('begins enrollment on the server and confirms only the proof code', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ provisioning_uri: 'otpauth://totp/Gated?secret=ABC' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'otp-id' }), { status: 201 }))
    vi.stubGlobal('fetch', fetch)
    expect(await profileApi.otpDevices.begin()).toEqual({ provisioning_uri: 'otpauth://totp/Gated?secret=ABC' })
    await profileApi.otpDevices.add({ otp: '123456' })
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/profile/credentials/otp/begin', expect.objectContaining({ method: 'POST' }))
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/profile/credentials/otp', expect.objectContaining({ body: JSON.stringify({ otp: '123456' }) }))
  })
})
