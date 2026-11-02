// Hand-maintained types + client for the command-ACL rule CRUD endpoints.
// Mirrors crates/gated-admin/src/api/command_acl.rs. These routes are not part
// of the generated OpenAPI surface yet, so the shapes are kept in sync by hand.

import { adminApi } from './http'

export type CommandAclProtocol = 'ssh' | 'mysql' | 'postgres' | 'any'
export type CommandAclMatchType = 'regex' | 'keyword'
export type CommandAclAction = 'allow' | 'deny' | 'review'

/** Persisted rule as returned by the API (the `CommandAclRule` model). */
export interface CommandAclRule {
  id: number
  name: string
  enabled: boolean
  /** Lower value is evaluated first. */
  priority: number
  protocol: CommandAclProtocol
  match_type: CommandAclMatchType
  pattern: string
  action: CommandAclAction
  /** Null = all targets. */
  target_id: string | null
  /** Null = all roles. */
  role_id: string | null
  description: string | null
  created_at: string
  updated_at: string
}

/** Create/update request body. `enabled` defaults to true server-side. */
export interface CommandAclRuleRequest {
  name: string
  enabled?: boolean
  priority: number
  protocol: CommandAclProtocol
  match_type: CommandAclMatchType
  pattern: string
  action: CommandAclAction
  target_id?: string | null
  role_id?: string | null
  description?: string | null
}

export async function listCommandAclRules(signal?: AbortSignal): Promise<CommandAclRule[]> {
  return adminApi.get<CommandAclRule[]>('/command-acl-rules', signal)
}

export async function createCommandAclRule(body: CommandAclRuleRequest, signal?: AbortSignal): Promise<CommandAclRule> {
  return adminApi.post<CommandAclRule>('/command-acl-rules', body, signal)
}

export async function updateCommandAclRule(id: number, body: CommandAclRuleRequest, signal?: AbortSignal): Promise<CommandAclRule> {
  return adminApi.put<CommandAclRule>(`/command-acl-rule/${encodeURIComponent(id)}`, body, signal)
}

export async function deleteCommandAclRule(id: number, signal?: AbortSignal): Promise<void> {
  return adminApi.delete<void>(`/command-acl-rule/${encodeURIComponent(id)}`, signal)
}
