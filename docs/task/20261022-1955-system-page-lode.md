# 20261022-1955-system-page-lode Group settings into tabs with lode-backed update, security and about

- **status**: completed
- **priority**: P2
- **owner**: worker/gated-system-1022
- **createdAt**: 2026-10-22 19:55

## Description

Settings tabs (General, Sessions, SSH authentication, Update, Security, About), lode-backed update check/update/restart, About page for every user, user menu cleanup, session tab dot shows connection state. Plan: `docs/plan/20261022-1955-system-page-lode.md`.

## ActiveForm

Grouping settings and adding lode update

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

- complete: settings tabs, Update/Security/About, `/about` for every user, `/admin/api/system/*` with step-up and audit, tab dot by connection state. Rust, web (379) and tests/api/system pass. Browser-verified under lode 0.1.0 with a local signed feed: check (up to date / found), update 0.23.1 → 0.23.2 with password confirmation, restart (new instance), unsaved settings kept across tabs.
