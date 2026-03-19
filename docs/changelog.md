# Gated Changelog

## 2026-03-19 11:00 [progress]

Project repository reset and documentation audit.

Changes:
- Reset git history to clean initial commit
- Created NOTICE file with upstream Warpgate attribution and branding disclaimer
- Updated README.md: corrected build commands (npm -> bun), added Kubernetes/LDAP/RBAC to features
- Updated CLAUDE.md: corrected build commands (npm -> bun)
- Fixed FUNDING.yml: removed upstream eugeny/tabby references, updated to bkhq
- Updated architecture.md: corrected CI/CD section (8 workflows -> 3 actual workflows)
- Completed full security and code quality audit (49 findings: 8 critical, 10 high, 14 medium, 17 low)
- Reset PMA task/plan indexes to clean state

## 2026-03-19 09:00 [progress]

Frontend modernization (gated-web).

Changes:
- Switched package manager from pnpm to bun
- Restructured src/ to feature-based organization (features/admin, features/gateway, shared/)
- Renamed all files to kebab-case convention
- Set up shadcn/ui with Button and DropdownMenu components
- Added i18n with react-i18next (zh-CN + en, lazy-loaded)
- Migrated theme from Zustand store to Context-based ThemeProvider (light/dark/system)
- Extracted providers.tsx, query-client.ts, router.tsx to app/ directory
- Updated Vite config, ESLint config
