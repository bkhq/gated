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
  it('keeps the full public key and its fingerprint', async () => {
    const created = { id: 'k1', label: 'laptop', openssh_public_key: 'ssh-ed25519 AAAAFULL', fingerprint: 'SHA256:abc', date_added: null, last_used: null }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(created), { status: 201 })))
    const key = await profileApi.publicKeys.register({ name: 'laptop', material: 'ssh-ed25519 AAAAFULL' })
    expect(key).toMatchObject({ publicKey: 'ssh-ed25519 AAAAFULL', fingerprint: 'SHA256:abc' })
  })
  it('confirms a new public key with the OTP when one is enrolled, else the password', async () => {
    const state = (otp: unknown[], password: string) => new Response(JSON.stringify({ otp, password, public_keys: [], certificates: [], sso: [] }), { status: 200 })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(state([{ id: 'o1' }], 'Set'))
      .mockResolvedValueOnce(state([], 'Set'))
      .mockResolvedValueOnce(state([], 'Unset')))
    expect(await profileApi.publicKeys.confirmationFactor()).toBe('otp')
    expect(await profileApi.publicKeys.confirmationFactor()).toBe('password')
    expect(await profileApi.publicKeys.confirmationFactor()).toBeNull()
  })
  it('sends the confirmation with the key and leaves a rejected one to the prompt', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify('confirmation rejected'), { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    const unauthorized = vi.fn()
    setOnUnauthorized(unauthorized)
    await expect(profileApi.publicKeys.register({ name: 'laptop', material: 'ssh-ed25519 AAAA', confirmation: { otp: '123456' } })).rejects.toThrow()
    expect(fetch).toHaveBeenCalledWith('/api/profile/credentials/public-keys', expect.objectContaining({ body: JSON.stringify({ label: 'laptop', openssh_public_key: 'ssh-ed25519 AAAA', otp: '123456' }) }))
    expect(unauthorized).not.toHaveBeenCalled()
  })
})
