import { describe, expect, it } from 'vitest'
import { claimDestination, claimLink, connectionCommand, secretFromHash } from './handoff'

const endpoint = { host: 'gw.example.com', ports: { ssh: 2222, mysql: 3306, postgres: null } }

describe('claimLink', () => {
  it('keeps the secret in the fragment', () => {
    expect(claimLink('https://gw.example.com', 'a b/c')).toBe('https://gw.example.com/ui/ticket#a%20b%2Fc')
    expect(secretFromHash('#a%20b%2Fc')).toBe('a b/c')
    expect(secretFromHash('')).toBe('')
    expect(secretFromHash('#%E0%A4%A')).toBe('')
  })
})

describe('connectionCommand', () => {
  it('signs in as ticket-<secret> on the gateway port of the kind', () => {
    expect(connectionCommand('ssh', endpoint, 's3cret')).toBe('ssh -p 2222 ticket-s3cret@gw.example.com')
    expect(connectionCommand('mysql', endpoint, 's3cret')).toBe('mysql -h gw.example.com -P 3306 -u ticket-s3cret -p')
    expect(connectionCommand('postgres', endpoint, 's3cret')).toBeNull()
    expect(connectionCommand('http', endpoint, 's3cret')).toBeNull()
    expect(connectionCommand('ssh', { ...endpoint, host: null }, 's3cret')).toBeNull()
  })
})

describe('claimDestination', () => {
  it('opens the terminal of the target, or the target list for HTTP', () => {
    expect(claimDestination('Ssh', 'web 01')).toBe('/ui/terminal/ssh/web%2001')
    expect(claimDestination('MySql', 'db')).toBe('/ui/db/db')
    expect(claimDestination('Postgres', 'db')).toBe('/ui/db/db')
    expect(claimDestination('Http', 'site')).toBe('/ui/targets')
  })
})
