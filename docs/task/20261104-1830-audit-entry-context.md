# 20261104-1830-audit-entry-context Give every audit log entry its session context

- **status**: completed
- **priority**: P1
- **owner**: lexuue
- **createdAt**: 2026-11-04 18:30

## Description

Audit log entries (and their JSONL export) lack the fields needed to read them: most show `actor: "system"` and only an action text and a session id, with no user, target, protocol or client address. Acceptance: every session-plane entry shows and exports the session's user, target, protocol and client address next to its own fields; the export carries every field the UI shows; host key events name the host, port and fingerprint.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Findings:
- `log_entries` rows are tracing events (`gated-core/src/logging/database.rs`): `text`, `values` (the event's fields), `session_id`, `username` (`session_username` / `username` field, if the event set one). Events before sign-in ("Host key is unknown") and system events ("Recording started") carry no username, so the UI falls back to `system`.
- Some events do carry context in `values` ("Target connected": `target`, `protocol`, `client_ip`, `username`), but the JSONL export (`admin-audit-page.tsx`) writes only `id`, `at`, `actor`, `action`, `sessionId`, so `values` never reach the file; the table shows them only in the expanded row.
- The `sessions` table has the context for every entry: `username`, `target_snapshot` (name), `protocol`, `remote_address`, `started`, `ended`.
- "Host key is unknown" (`gated-protocol-ssh/src/client/handler.rs`) logs only the session.

Proposed plan:
1. API: `POST /admin/api/logs` adds `session: { username, target, protocol, client_ip, started, ended } | null` to each entry, loaded in one query for the page's session ids. The entry `username` is unchanged.
2. UI table: columns time, user (entry username, else the session user, else `system`), target, protocol, client address, action; expanded row keeps the event fields; the search box also matches target, address and field values.
3. Export: each JSONL line has `id`, `at`, `actor`, `action`, `sessionId`, `user`, `target`, `protocol`, `clientIp`, `sessionStarted`, `sessionEnded` and `fields` (all event values).
4. Events: host key events log `host`, `port`, `key_type` and `fingerprint` (unknown, mismatch, accepted, rejected).
5. Tests: API test for the session context, web tests for the columns and export line, docs, changelog.

Outcome:
- `POST /admin/api/logs` returns `AuditLogEntry` with `session` (`username`, `target`, `protocol`, `client_address`, `started`, `ended`), loaded with one query for the page's session ids; the management audit returns `session: null`.
- Audit table columns: time, user, target, protocol, client address, action; every row expands to the session id, session start/end and the event fields; search covers all of them.
- JSONL export lines (`features/audit/audit-entry.ts` `auditExportLine`): `id`, `at`, `actor`, `action`, `sessionId`, `target`, `protocol`, `clientAddress`, `sessionStarted`, `sessionEnded`, `fields`.
- Host key events log `host`, `port`, `key_type`, `fingerprint` (and `known_key_type` on mismatch); the mismatch event text is now "Host key does not match the trusted key", and accepted/rejected events are new.
