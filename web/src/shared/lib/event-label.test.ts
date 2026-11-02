import { describe, expect, it } from 'vitest'
import enCommon from '../../../public/locales/en/common.json'
import zhCommon from '../../../public/locales/zh-CN/common.json'
import { eventLabel, eventLabelKey, KNOWN_EVENT_MESSAGES } from './event-label'

describe('eventLabelKey', () => {
  it.each([
    ['Target connected', 'events.targetConnected'],
    ['Recording started', 'events.recordingStarted'],
    ['Denied', 'events.accessDenied'],
    ['Host key is unknown', 'events.hostKeyUnknown'],
    ['auth_login_succeeded', 'events.loginSucceeded'],
    ['auth_logout', 'events.logout'],
    ['auth_otp_invalid', 'events.otpInvalid'],
    ['web_file_operation', 'events.fileOperation'],
    ['sftp_file_operation', 'events.fileOperation'],
    ['Target db1 not authorized for user alice', 'events.targetNotAuthorized'],
    ['SSO login as alice@example.com', 'events.ssoLogin'],
    ['  Recording started  ', 'events.recordingStarted'],
  ])('maps %s', (raw, key) => {
    expect(eventLabelKey(raw)).toBe(key)
  })
  it('falls back to events.other', () => {
    expect(eventLabelKey('something new')).toBe('events.other')
    expect(eventLabelKey('')).toBe('events.other')
  })
  it('has copy in both locales for every key', () => {
    const keys = new Set([...KNOWN_EVENT_MESSAGES.map(eventLabelKey), 'events.other'])
    for (const key of keys) {
      const name = key.slice('events.'.length)
      expect((enCommon.events as Record<string, string>)[name], key).toBeTruthy()
      expect((zhCommon.events as Record<string, string>)[name], key).toBeTruthy()
    }
  })
})

describe('eventLabel', () => {
  it('translates through the provided t function', () => {
    const t = (key: string) => `T(${key})`
    expect(eventLabel(t, 'Denied')).toBe('T(events.accessDenied)')
    expect(eventLabel(t, 'raw secret detail')).toBe('T(events.other)')
  })
})
