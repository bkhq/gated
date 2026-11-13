import { describe, expect, it } from 'vitest'
import { describePasswordPolicy, passwordPolicyViolations } from './password-policy'

function t(key: string, options?: Record<string, unknown>) {
  return options ? `${key}:${JSON.stringify(options)}` : key
}

const policy = {
  min_length: 10,
  require_uppercase: true,
  require_lowercase: true,
  require_digits: true,
  require_special: true,
}

describe('passwordPolicyViolations', () => {
  it('names every rule a password breaks', () => {
    expect(passwordPolicyViolations('abc', policy)).toEqual(['minLength', 'uppercase', 'digit', 'special'])
    expect(passwordPolicyViolations('ABCDEFGHIJ1!', policy)).toEqual(['lowercase'])
    expect(passwordPolicyViolations('Abcdefghi1!', policy)).toEqual([])
  })

  it('counts characters, not UTF-16 units, and accepts anything without a policy', () => {
    expect(passwordPolicyViolations('😀😀😀', { ...policy, min_length: 4, require_uppercase: false, require_lowercase: false, require_digits: false, require_special: false })).toEqual(['minLength'])
    expect(passwordPolicyViolations('', undefined)).toEqual([])
  })
})

describe('describePasswordPolicy', () => {
  it('lists the rules in force', () => {
    expect(describePasswordPolicy(t, { ...policy, require_special: false, require_lowercase: false }))
      .toBe('passwordPolicy.summary:{"rules":"passwordPolicy.rules.minLength:{\\"count\\":10}, passwordPolicy.rules.uppercase, passwordPolicy.rules.digit"}')
  })

  it('says so when there is no rule', () => {
    expect(describePasswordPolicy(t, { ...policy, min_length: 0, require_uppercase: false, require_lowercase: false, require_digits: false, require_special: false }))
      .toBe('passwordPolicy.none')
    expect(describePasswordPolicy(t, undefined)).toBe('passwordPolicy.none')
  })
})
