import { expect, it } from 'vitest'
import { parseHostKeyLine } from './host-key-line'

it('reads a public key from OpenSSH, known_hosts and ssh-keyscan lines', () => {
  const key = { key_type: 'ssh-ed25519', key_base64: 'AAAAC3Nz' }
  expect(parseHostKeyLine('ssh-ed25519 AAAAC3Nz')).toEqual(key)
  expect(parseHostKeyLine('ssh-ed25519 AAAAC3Nz root@host')).toEqual(key)
  expect(parseHostKeyLine('10.0.0.1 ssh-ed25519 AAAAC3Nz')).toEqual(key)
  expect(parseHostKeyLine('[10.0.0.1]:2222 ecdsa-sha2-nistp256 AAAAE2Vj')).toEqual({ key_type: 'ecdsa-sha2-nistp256', key_base64: 'AAAAE2Vj' })
  expect(parseHostKeyLine('  ssh-rsa AAAAB3Nz\n')).toEqual({ key_type: 'ssh-rsa', key_base64: 'AAAAB3Nz' })
})

it('rejects text without a key', () => {
  expect(parseHostKeyLine('')).toBeNull()
  expect(parseHostKeyLine('ssh-ed25519')).toBeNull()
  expect(parseHostKeyLine('hello world')).toBeNull()
})
