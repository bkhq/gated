# 20261112-1411-port-upstream-security-measures Port the security fixes and controls upstream added since the fork

- **status**: completed
- **priority**: P1
- **owner**: lexuue
- **createdAt**: 2026-11-12 14:11

## Description

Upstream Warpgate made about 220 security-relevant commits between the fork point (v0.21) and `5aca27f8` (2026-11-11). Each was compared with the Gated code. Port the ones that apply: the fixes for defects Gated still has, and the access controls Gated lacks.

Acceptance: see plan `20261112-1411-port-upstream-security-measures`.

## ActiveForm

Porting upstream security measures

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Plan: `docs/plan/20261112-1411-port-upstream-security-measures.md`. Related: 20261112-1254-known-host-key-type-switch (first item found by the same comparison, done).

2026-11-12: plan approved (stage A, then B1 to B6; SSO users are not exempt from enforced MFA). Stage A (A1 to A6) done, see the changelog entry of 2026-11-12 19:00. Stage B not started.

2026-11-12: B1 (login protection) done, see the changelog entries of 2026-11-12 20:30. Remaining: B5, B2, B4, B3, B6.

2026-11-12: B5 (token lifetime limit, endpoint allow-list) done, see the changelog entries of 2026-11-12 21:00. Remaining: B2, B4, B3, B6.

2026-11-12: B2 (password policy) done, see the changelog entries of 2026-11-12 21:40. Remaining: B4, B3, B6.

2026-11-12: B4 (allowed address ranges) done, see the changelog entries of 2026-11-12 22:30. Remaining: B3, B6.

2026-11-12: B3 (required MFA) done, see the changelog entries of 2026-11-12 22:40. Remaining: B6.

2026-11-12: B6 (role assignment expiry) done, see the changelog entries of 2026-11-12 22:50. Stage B complete.

- complete: Stage A and stage B (B1-B6) done; see changelog 2026-11-12
