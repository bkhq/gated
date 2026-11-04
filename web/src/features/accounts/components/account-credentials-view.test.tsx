import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { AccountCredentialsView } from './account-credentials-view'

it('says an SSH key account without username uses the target username', () => {
  render(
    <AccountCredentialsView
      credentials={{ kind: 'ssh-key', username: '', private_key_pem: '' }}
      revealed={null}
      onReveal={() => {}}
      onHide={() => {}}
    />,
  )
  expect(screen.getByText('accounts.form.cred.usernameFromTarget')).toBeTruthy()
})
