import type { KnownHost } from '@/shared/types/domain'
import { describe, expect, it } from 'vitest'
import { buildCsv, csvEscape } from './admin-known-hosts-page'

describe('csvEscape', () => {
  it('neutralizes formula-trigger cells with a leading single quote', () => {
    expect(csvEscape('=cmd|\'/C calc\'!A1')).toBe('\'=cmd|\'/C calc\'!A1')
    expect(csvEscape('+1+2')).toBe('\'+1+2')
    expect(csvEscape('-2+3')).toBe('\'-2+3')
    expect(csvEscape('@SUM(A1)')).toBe('\'@SUM(A1)')
    // tab triggers neutralization but not RFC-4180 quoting
    expect(csvEscape('\tfoo')).toBe('\'\tfoo')
    // CR triggers both neutralization and RFC-4180 quoting
    expect(csvEscape('\rfoo')).toBe('"\'\rfoo"')
  })

  it('leaves normal cells untouched', () => {
    expect(csvEscape('ssh-ed25519')).toBe('ssh-ed25519')
    expect(csvEscape('example.com')).toBe('example.com')
  })

  it('still applies RFC-4180 quoting', () => {
    expect(csvEscape('a,b')).toBe('"a,b"')
    expect(csvEscape('a"b')).toBe('"a""b"')
  })
})

describe('buildCsv', () => {
  it('neutralizes a malicious algo cell', () => {
    const hosts: KnownHost[] = [
      {
        id: '1',
        host: 'evil.example.com',
        algo: '=cmd|\'/C calc\'!A1',
        fingerprint: 'SHA256:abc',
      },
    ]
    const csv = buildCsv(hosts)
    expect(csv).toContain('\'=cmd|\'/C calc\'!A1')
    expect(csv).not.toContain(',=cmd')
  })
})
