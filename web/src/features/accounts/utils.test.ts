import { expect, it } from 'vitest'
import { missingCredentialFields } from './utils'

it('lets an SSH key account leave the username to the target', () => {
  expect(missingCredentialFields({ kind: 'ssh-key', username: '', private_key_pem: 'PEM' }, false)).toEqual([])
  expect(missingCredentialFields({ kind: 'ssh-password', username: '', password: 'pw' }, false)).toEqual(['accounts.form.cred.username'])
})
