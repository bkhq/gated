import { describe, expect, it } from 'vitest'
import { formatMode, formatSize, joinPath, parentPath, pathSegments } from './paths'

describe('paths', () => {
  it('joins and walks up paths', () => {
    expect(joinPath('/', 'etc')).toBe('/etc')
    expect(joinPath('/etc', 'hosts')).toBe('/etc/hosts')
    expect(parentPath('/etc/ssh/')).toBe('/etc')
    expect(parentPath('/etc')).toBe('/')
    expect(parentPath('/')).toBe('/')
  })

  it('splits a path into clickable segments', () => {
    expect(pathSegments('/var/log')).toEqual([
      { name: '/', path: '/' },
      { name: 'var', path: '/var' },
      { name: 'log', path: '/var/log' },
    ])
  })

  it('formats sizes and modes', () => {
    expect(formatSize(undefined)).toBe('—')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(3_000_000)).toBe('2.9 MB')
    expect(formatMode(0o40755, 'dir')).toBe('drwxr-xr-x')
    expect(formatMode(0o100644, 'file')).toBe('-rw-r--r--')
    expect(formatMode(null, 'file')).toBe('—')
  })
})
