// Hand-maintained types + client for the pending command-review endpoints.
// Mirrors crates/gated-admin/src/api/command_review.rs.

import { adminApi } from './http'

/** One pending command review awaiting an approve/reject decision. */
export interface CommandReviewItem {
  id: string
  session_id: string | null
  user_id: string | null
  username: string | null
  target_id: string | null
  target_name: string
  /** Always `"exec"` today (the guaranteed-flow path). */
  origin: string
  command: string
  acl_rule_id: number | null
  acl_rule_name: string | null
  requested_at: string
}

export async function listCommandReviews(signal?: AbortSignal): Promise<CommandReviewItem[]> {
  return adminApi.get<CommandReviewItem[]>('/command-reviews', signal)
}

export async function approveCommandReview(id: string, signal?: AbortSignal): Promise<void> {
  await adminApi.post<void>(`/command-review/${encodeURIComponent(id)}/approve`, undefined, signal)
}

export async function rejectCommandReview(id: string, signal?: AbortSignal): Promise<void> {
  await adminApi.post<void>(`/command-review/${encodeURIComponent(id)}/reject`, undefined, signal)
}
