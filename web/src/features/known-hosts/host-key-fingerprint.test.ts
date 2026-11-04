import { expect, it } from 'vitest'
import { sha256Fingerprint } from './host-key-fingerprint'

it('prints the SHA256 fingerprint the way ssh-keygen -lf does', async () => {
  // GitHub's published ed25519 host key and fingerprint.
  expect(await sha256Fingerprint('AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'))
    .toBe('SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU')
})

it('returns null for a key that is not base64', async () => {
  expect(await sha256Fingerprint('not base64!')).toBeNull()
})
