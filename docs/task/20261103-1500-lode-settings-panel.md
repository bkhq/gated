# 20261103-1500-lode-settings-panel Show the supervising lode in System Settings

- **status**: completed
- **priority**: P2
- **owner**: lexuue
- **createdAt**: 2026-11-03 15:00

## Description

System Settings should show the lode supervisor gated runs under (version, commit, features, state) next to the existing gateway update controls, and let an administrator request updates from there. Acceptance: the admin API returns lode's own details from `state.json`; the settings panel shows them with the last good version.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Findings:
- gated already talks to lode through `$LODE_DIR/state.json` (`crates/gated-core/src/lode.rs`). `GET /system/update` and the update panel (`web/src/features/admin/config/update-panel.tsx`) show gated's `current`, `available`, `status`, `last_check` and `last_error` and support check, update to a version and restart with step-up.
- lode 0.3.0+ writes a `lode` object into `state.json`: `{ version, commit, features[] }`. gated ignores it today. `last_good`, `hold`, `config_generation` and `resources` are also written but not shown.
- lode 0.4.0 has no app-side request to update lode itself. Only `lode-cli self-update` replaces the lode binary, and lode must then be restarted by the operator. gated replacing lode's binary itself would cross the supervisor's trust boundary (gated may not even have write access to it).

Proposed plan:
1. API: `UpdateStatus` gains `lode: { version, commit, features }` (null when lode is older than 0.3.0) and `last_good`. Lifecycle actions are gated by lode's features (`check`, `target`, `restart`) and the panel hides an action lode does not support.
2. UI: the update panel becomes a "lode supervisor" section with the lode version, commit and features, and a "Gateway" section with the existing version/check/update/restart controls plus `last_good`.
3. lode updates: show the lode version and, as text, how to update it (`lode-cli self-update`, then restart lode). A one-click lode update needs a new lode feature (for example a `lode_target` request in `state.json`); that is a change to the lode project and is out of scope here.
4. Tests: Rust tests for reading the `lode` object, web tests for the panel, docs, changelog.

Decision (approved scope): information only. No lode self-update from gated and no update instructions; actions are not gated by lode features. Implemented: `LodeState.lode` / `LodeInfo` in `gated-core`, `UpdateStatus.lode`, panel rows for the last good version, lode version (with commit) and features.
