import { expect, it } from 'vitest'
import { formatTargetAddress } from './target-address'

it('formats ssh-like targets as user@host:port', () => {
  expect(formatTargetAddress({ kind: 'ssh', user: 'root', host: '10.0.0.1', port: 22 })).toBe('root@10.0.0.1:22')
})

it('shows only the URL for http targets', () => {
  expect(formatTargetAddress({ kind: 'http', user: '', host: 'http://h:8080', port: 0 })).toBe('http://h:8080')
})
