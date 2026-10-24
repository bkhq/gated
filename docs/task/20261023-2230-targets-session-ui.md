# 20261023-2230-targets-session-ui Connect from the target list, session details popover, per-protocol security tab, groups on the targets page, consistent lists

- **status**: completed
- **priority**: P2
- **owner**: worker/gated-targets-1023
- **createdAt**: 2026-10-23 22:30

## Description

Five UI fixes from user testing. Plan: `docs/plan/20261023-2230-targets-session-ui.md`.

## ActiveForm

Reworking the target list, session status bar and target security tab

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

- complete: all five items. Rust (gated-tls inspect, gated-admin details/certificate), web (391), tests/ssh/web-terminal-revocation, tests/api/targets (incl. upstream-certificate) and tests/api/target-groups pass. Browser-checked on a throwaway unencrypted instance: table default and persisted grid, Connect opens the terminal, HTTP shows Details, error bar stays 28px with the message in the popover, connected popover lists address/user/host key/time/duration/session id, Groups view with count filter, Security tab per protocol (the tab was labelled "Host keys"; now "Security").

