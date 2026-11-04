import { expect, it } from 'vitest'
import { refName, withAccount } from './target-ref'

it('appends the picked account to a path', () => {
  expect(withAccount('/sftp/web/list', 'web')).toBe('/sftp/web/list')
  expect(withAccount('/sftp/web/list', { name: 'web' })).toBe('/sftp/web/list')
  expect(withAccount('/sftp/web/list', { name: 'web', account: 'deploy' })).toBe('/sftp/web/list?account=deploy')
  expect(withAccount('/sftp/web/list?path=%2F', { name: 'web', account: 'a b' })).toBe('/sftp/web/list?path=%2F&account=a%20b')
  expect(refName({ name: 'web', account: 'deploy' })).toBe('web')
})
