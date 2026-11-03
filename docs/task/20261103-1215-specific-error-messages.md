# 20261103-1215-specific-error-messages Show specific error reasons in a global toast

- **status**: completed
- **priority**: P1
- **owner**: lexuue
- **createdAt**: 2026-11-03 12:15

## Description

Failed operations show `HTTP 403` (or nothing) instead of the reason. Example: MFA enrollment answers 403 for a wrong code, an expired enrollment, a replayed code and disabled self-service alike, with no body. Every failed operation must show the specific reason in a global toast. Acceptance: the API returns a reason for each refusal; the web client extracts it from every body shape the API uses; every failed mutation shows it in a global toast (inline-only errors where the dialog stays open, such as step-up prompts, are not duplicated); tests cover the extraction, the toast and the OTP reasons.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Findings:
- `web/src/shared/lib/api/http.ts` `extractMessage` reads only `{ message }`. The API mostly sends a JSON string (`Json<String>` variants) or plain text (`GatedError::into_response`, middleware such as "Credential management is disabled"), so those reasons are dropped and the UI shows `HTTP <status>`.
- About 40 handler returns in `gated-admin` are bodiless `Forbidden` / `BadRequest` / `Unauthorized` (17 in `http_service/api/credentials.rs`, the rest in accounts, users, targets, tickets, api_tokens, roles, target_groups, sessions, system); `require_admin` answers a bare 403. 54 bodiless `NotFound` returns exist.
- No toast system: components render errors inline, some not at all. 33 `useMutation` sites.

Proposed plan:
1. API: give bodiless `Forbidden` / `BadRequest` / `Unauthorized` returns a `Json<String>` reason (status codes unchanged). OTP enrollment distinguishes "no enrollment in progress or it expired, start again", "invalid code" and "code already used"; `require_admin` says the administrator role is required. `NotFound` stays bodiless and gets a client-side generic message.
2. Client: `extractMessage` accepts a JSON string, plain text, `{ message }` and `{ error }`; without a body, a localized message per status (403 permission denied, 404 not found, 409 conflict, 429 too many attempts, 5xx server error) with the status code.
3. Global toast: shadcn `sonner` (`shared/ui/sonner.tsx`) mounted in `Providers`; a `MutationCache.onError` shows every mutation failure. Mutations whose error is handled in a prompt that stays open opt out with `meta: { inlineError: true }`; existing inline banners for the same error are removed. Query failures toast only when a query has no data yet (no repeats for background refetches). 401 keeps the existing re-login redirect.
4. Tests: Rust handler tests for the OTP reasons; web tests for `extractMessage`, the mutation toast and opt-out; docs (api error format), changelog.

Decisions during implementation:
- Inline errors stay only in prompts that authenticate and stay open for another try: sign-in, unlock, encryption bootstrap, setup, step-up, master-password rekey and the password change drawer (they show `describeError`). MFA enrollment errors use the toast.
- Queries whose page has its own error screen (lock status boot gate, setup status, SFTP listing) opt out of the toast.
- Raw API calls outside React Query (update panel, file manager actions and uploads) call `toastError` directly.
