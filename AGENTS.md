# Gated Agent Instructions

## Project Development

This project uses the **PMA (Project Management Assistant)** workflow for development task management.

### Workflow: Investigate -> Proposal -> Implement

1. **Investigate**: Trace call chains, search related code/config/tests, read `docs/changelog.md` for context
2. **Proposal**: Output current state, proposal, risks, scope, alternatives; wait for approval
3. **Implement**: Execute approved changes, verify, update task/plan status and changelog

### Documentation Structure

```
docs/
├── architecture.md        # System architecture
├── changelog.md           # Development changelog
├── task/
│   ├── index.md           # Task tracking index
│   └── PREFIX-NNN.md      # Task detail files
└── plan/
    ├── index.md           # Plan tracking index
    └── PLAN-NNN.md        # Plan detail files
```

### Task Prefixes

- `FEAT` - New features
- `BUG` - Bug fixes
- `REFACTOR` - Code refactoring
- `PERF` - Performance improvements
- `AUTH` - Authentication related
- `UI` - Frontend/UI changes
- `API` - API changes
- `INFRA` - Infrastructure/CI/CD

### Git Conventions

- Use English for commit messages, PR titles, and PR descriptions.
- Follow conventional commits format: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci).
- Do not mention AI assistants or agent names in any remote-visible content.
