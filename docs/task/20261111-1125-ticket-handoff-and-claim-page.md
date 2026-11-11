# 20261111-1125-ticket-handoff-and-claim-page Hand a ticket to its recipient without a login

- **status**: completed
- **priority**: P1
- **owner**: lexuue
- **createdAt**: 2026-11-11 11:25

## Description

A ticket recipient has no account, yet the only thing handed over is a web link that lands on the normal UI; the administrator who mints a ticket never sees its secret; nobody is told how to reach an SSH host with a ticket. Acceptance: whoever mints a ticket (user or admin) gets the secret once with ready-to-use connection instructions; the recipient opens the link without logging in, sees what the ticket is for and connects from there.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Findings (verified against a local instance):
- The share link is `/?gated-ticket=<secret>`. `ticket_middleware` authorises the browser session and consumes one use on that first GET, then redirects to `/ui/`. The API side works for a ticket session (`/api/info` returns the username, `/api/targets` shows the one target). But any GET consumes a use: a link preview fetched by a chat app burns a single-use ticket before the recipient clicks, and the recipient then lands on the login page with no account to log in with. An already consumed or expired link behaves the same.
- The admin tickets page (`admin-tickets-page.tsx`) renders `TicketFormDialog` without `onSaved`, so the one-time secret returned by `POST /admin/api/tickets` is discarded. Only the self-service page shows a share dialog, and it shows the web link alone.
- SSH with a ticket is `ssh -p <ssh port> ticket-<secret>@<host>` with any password (covered by `tests/ssh/auth-ticket.test.ts`); MySQL and PostgreSQL use `ticket-<secret>` as the user. The UI states none of this.
- A ticket session gets the full sidebar; tickets, credentials and API token pages answer 403 for it.

Proposal:
1. Share dialog shared by both pages (`features/tickets/components/ticket-share-dialog.tsx`): the claim link plus, by target kind, the SSH command (`external_host`, `ports.ssh` from `/api/info`), or the database user and port; copy buttons. The admin page wires `onSaved`.
2. Claim page `/ui/claim#<secret>`, usable without a login: the secret travels in the URL fragment, so it never reaches the server, the logs or a link previewer. The page calls `POST /api/tickets/inspect { secret }`, which returns the target name and kind, expiry and uses left without consuming anything (404 for unknown, expired or used up), and shows the connection instructions. "Open in browser" calls `POST /api/tickets/claim { secret }`, which authorises the session (one use) and opens the target's terminal or database page. The login redirect in `layout.tsx` exempts the page.
3. Ticket sessions in the SPA hide the pages a ticket cannot use (`authorized_via_ticket`), and the overview opens on the ticket's target.
4. `?gated-ticket=` and `Authorization: Gated` stay as they are for API clients; only the share link changes.
5. Tests first: bun integration tests for inspect and claim (no use consumed by inspect; one by claim; expired or revoked gives 404; both rate limited like login), vitest for the share dialog and claim page; `docs/api.md`, operations docs, changelog.

Smaller alternative: items 1, 3 and 4 only. The link then still consumes a use when opened and still fails silently for a previewed or expired link.

## Outcome

Decision (user, 2026-11-11): full version, but the link signs the recipient in directly, with no claim step. Implemented: `POST /api/tickets/claim` (`api/tickets.rs`, login rate limiter keyed by address) consumes one use and authorises the session; `/ui/ticket#<secret>` (`features/tickets/claim-page.tsx`) posts the secret from the fragment, drops it from the address bar and opens the target's terminal (HTTP targets: the target list), or explains a dead link. `TicketShareDialog` (link, command line by target kind, secret, copy buttons) replaces the user page's link-only dialog and is wired into the admin page, which discarded the secret. Ticket sessions see only Overview, Targets and Sessions and no profile entry. The admin row menu's "copy claim link" (`/claim/<id>`, never worked) is removed; the profile tab's inert "copy link" item is left as is. Covered by `tests/http/ticket-claim.test.ts`, vitest for the dialog, claim page and admin page; `docs/api.md`, operations docs and changelog updated. Not viewed in a real browser.
