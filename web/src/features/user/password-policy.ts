import type { components } from '@/shared/lib/api/user.types'
import { useQuery } from '@tanstack/react-query'
import { userApi } from '@/shared/lib/api/http'

export type PasswordPolicy = components['schemas']['PasswordPolicy']
export type PasswordRule = 'minLength' | 'uppercase' | 'lowercase' | 'digit' | 'special'

type Translate = (key: string, options?: Record<string, unknown>) => string

function rulesInForce(policy: PasswordPolicy | undefined): PasswordRule[] {
  if (!policy) {
    return []
  }
  const rules: PasswordRule[] = []
  if (policy.min_length > 0) {
    rules.push('minLength')
  }
  if (policy.require_uppercase) {
    rules.push('uppercase')
  }
  if (policy.require_lowercase) {
    rules.push('lowercase')
  }
  if (policy.require_digits) {
    rules.push('digit')
  }
  if (policy.require_special) {
    rules.push('special')
  }
  return rules
}

/** The same checks the gateway applies; it has the last word. */
const SATISFIED: Record<PasswordRule, (password: string, policy: PasswordPolicy) => boolean> = {
  minLength: (password, policy) => [...password].length >= policy.min_length,
  uppercase: password => /\p{Lu}/u.test(password),
  lowercase: password => /\p{Ll}/u.test(password),
  digit: password => /\d/.test(password),
  // Printable ASCII that is neither a letter nor a digit.
  special: password => [...password].some(c => c >= ' ' && c <= '~' && !/[a-z0-9]/i.test(c)),
}

/** Rules of `policy` that `password` breaks. */
export function passwordPolicyViolations(password: string, policy: PasswordPolicy | undefined): PasswordRule[] {
  return policy ? rulesInForce(policy).filter(rule => !SATISFIED[rule](password, policy)) : []
}

function listRules(t: Translate, rules: PasswordRule[], policy: PasswordPolicy | undefined): string {
  return rules
    .map(rule => rule === 'minLength'
      ? t('passwordPolicy.rules.minLength', { count: policy?.min_length ?? 0 })
      : t(`passwordPolicy.rules.${rule}`))
    .join(', ')
}

/** One sentence telling the user what a new password needs. */
export function describePasswordPolicy(t: Translate, policy: PasswordPolicy | undefined): string {
  const rules = rulesInForce(policy)
  return rules.length === 0
    ? t('passwordPolicy.none')
    : t('passwordPolicy.summary', { rules: listRules(t, rules, policy) })
}

/** The error to show for a password that breaks `policy`, if it does. */
export function passwordPolicyError(t: Translate, password: string, policy: PasswordPolicy | undefined): string | undefined {
  const broken = passwordPolicyViolations(password, policy)
  return broken.length === 0 ? undefined : t('passwordPolicy.violation', { rules: listRules(t, broken, policy) })
}

/** The policy for the signed-in user's own password. */
export function usePasswordPolicy(): PasswordPolicy | undefined {
  return useQuery({
    queryKey: ['password-policy'],
    queryFn: async ({ signal }) =>
      (await userApi.get<components['schemas']['CredentialsState']>('/profile/credentials', signal)).password_policy,
  }).data
}
