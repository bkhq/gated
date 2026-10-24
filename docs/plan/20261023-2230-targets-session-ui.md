# 20261023-2230-targets-session-ui Connect from the target list, session details popover, per-protocol security tab, groups on the targets page, consistent lists

- **status**: completed
- **createdAt**: 2026-10-23 22:30
- **approvedAt**: 2026-10-23 22:30
- **relatedTask**: 20261023-2230-targets-session-ui

## Context

- My targets: the card/row Connect button calls the same `openDetail` as the card itself, so it never connects. HTTP targets show "Open", which also lands on the detail page.
- Terminal status bar renders the status frame message inline; a long error crowds the bar. The connected frame carries only `"SSH session established"`, so the UI has no server facts to show.
- Target detail always shows a Security tab with host-key wording, also for HTTP/MySQL/PostgreSQL.
- Target groups have their own admin page with a card grid; groups carry only name, description, color and a target count.
- Entity lists are tables except My targets (card grid by default, unpersisted toggle) and Target groups (cards only). Command reviews stay cards (approve/reject actions per item).

## Proposal

1. My targets: Connect on ssh/mysql/postgres opens a terminal tab and goes to `/sessions` (same as the detail page). HTTP targets show a Details button instead of Open. Default view becomes the table; the grid/table choice persists in localStorage.
2. Session status bar: a compact clickable status (dot + label) opens a popover like the key menu with status, full message, target/protocol/address, connected-at and duration, session id, and server facts. The status frame gains an optional `details` object on `connected` (ssh: server version, host key algorithm + fingerprint; mysql/postgres: server version, TLS in use).
3. Target security tab per protocol: ssh = known host keys; http = upstream certificate chain (subject, issuer, validity, SANs, SHA-256 fingerprint) from a new admin endpoint that connects to the upstream once, plus the TLS verify setting, or "no TLS" for http:// upstreams; mysql/postgres = TLS mode and verify setting only.
4. Groups move into the admin Targets page as a second view (Targets | Groups) rendered as a table with create/edit/delete; clicking a group filters targets. The standalone page, route and nav entry are removed (no redirect; dev phase).
5. Lists: tables by default everywhere; only the target pages keep the grid/table toggle (persisted).

## Steps

1. Items 1 and 5 (web) -> verify: vitest for connect/details/view persistence.
2. Item 4 (web) -> verify: vitest for groups view and filtering; route removed.
3. Item 2 (server + web) -> verify: Rust unit test for the details payload, vitest for the popover, browser check under lode.
4. Item 3 (server + web) -> verify: API integration test against a TLS upstream, vitest for per-kind tabs.

Each step is its own commit; local lode test only, no release.
