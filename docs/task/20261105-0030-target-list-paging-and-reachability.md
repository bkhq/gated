# 20261105-0030-target-list-paging-and-reachability Page the target lists, show counts and track target reachability

- **status**: completed
- **priority**: P2
- **owner**: lexuue
- **createdAt**: 2026-11-05 00:30

## Description

The admin target list renders every target on one page with no count, and there is no way to see which hosts are up. Acceptance: the admin list and My targets are paginated and show "x–y of n" (filtered of total); an admin can select targets (or all filtered ones) and check reachability; the last result (up/down, latency, error, time) is stored and shown in the UI, and every target is checked automatically on a configurable interval (daily by default).

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Findings:
- `GET /admin/api/targets` and `GET /api/targets` return the whole list; filtering (search, protocol, group) is client-side in `admin-targets-page.tsx` and `user/targets-page.tsx`.
- The admin list has no count and no pagination; My targets shows "filtered / total" but no pagination.
- The users page already has client-side pagination (`PAGE_SIZE = 10`, a local `Pagination` component, "x–y of n", page selection checkboxes) in `admin-users-page.tsx`.
- No target reachability check exists anywhere; the web terminal only reports "target host unreachable" after a failed connect.

Proposed plan:
1. Pagination stays client-side (lists are small and already fully loaded): move the users page's `Pagination` into `shared/components`, page both target lists in grid and table view (page size selectable 20/50/100, kept in the URL search), reset to page 1 when filters change, show "x–y of n" and the total.
2. Reachability check: the gateway opens a TCP connection to each target's host:port (HTTP targets: the URL's host and port), 3 s timeout, at most 16 at once. TCP rather than ICMP: the gateway has no raw-socket privilege, and an open service port is what a connection needs. No credentials are used and no session or recording is created.
3. Stored status: migration adds `targets.status_checked_at`, `status_reachable`, `status_latency_ms`, `status_error` (all nullable). Every check writes them; `Target` / `TargetSnapshot` return them as `status: { reachable, latency_ms, error, checked_at } | null`.
4. Manual check: `POST /admin/api/targets/check` with `{ target_ids: uuid[] }` (max 200) runs the checks, stores and returns the results; one management audit entry per request (count only).
5. Scheduled check: there is no job scheduler today (only the fixed log-cleanup loop in `run.rs`). Add a background loop next to it that wakes every minute and checks the targets whose `status_checked_at` is older than the configured interval (or never checked). Due-based, so a restart neither skips nor repeats a run, and new targets are checked within a minute. Interval in parameters (`target_check_interval`: off / 1 h / 6 h / 24 h, default 24 h), set on the settings page. Skipped while the gateway is locked.
6. UI: admin list gets a selection checkbox per row/card, "select all filtered", a "Check reachability" action (also per target in its row menu), a status dot (green up with latency, red down with the error in a tooltip, grey never checked, plus the check time) and "n up / m down" in the toolbar; status filter (all / up / down / unknown). My targets shows the same status dot read-only.
7. Tests: backend unit tests for address resolution per kind, timeout, the limit and the due selection; an integration test against the SSH test container (up) and a closed port (down) including the stored status; web tests for pagination, the check flow and the status dot. Docs (api.md / zh-CN, operations) and changelog.

Decisions so far (user, 2026-11-05): persist the result and show host status in the UI; check periodically, once a day by default.

Regular users see the status read-only on My targets; checking is admin-only (user, 2026-11-05). Proposal approved 2026-11-05.

Outcome:
- Migration `m00018_target_status`: a separate `target_status` table (one row per target, replaced on each check) instead of columns on `targets`, so target create/update code is untouched; deleting a target deletes its row. `parameters.target_check_interval_hours` (default 24, 0 = off, API range 0–168).
- `gated-core::target_status`: address per kind, TCP probe (3 s, 16 at once), storing, due selection and `run_scheduler` (started next to the ACME renewal loop; ticks every minute, idle while locked).
- Admin API `GET /targets/status`, `POST /targets/check` (1–200 ids; audited by the management audit middleware like every POST). `GET /api/targets` returns `status` read-only.
- UI: status column/indicator in both lists, admin status filter, totals summary, row/card selection with bulk check, "Check all / Check n shown", per-target check in the row menu, client-side paging (50 per page) on both lists, check interval on the settings page. The page size is fixed at 50 and kept in component state rather than the URL.
- Tests: core unit tests (address, probe, storing, due selection, interval setting), web tests (indicator, admin page status/selection/check/paging, hook batching and mapping), integration `tests/api/targets/status.test.ts`.
