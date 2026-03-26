# Cloopy Development Environment

## Rules

- Always respond in Japanese.

## Environment

- Shell: zsh
- IDE: VS Code Remote SSH
- Workspace: `/home/developer/workspace` — place projects here

## Package Management

- Use **Devbox** for system-level packages: `devbox global add <package>`
- For project-local packages, use `devbox add` only when the project has a
  `devbox.json`
- Install missing tools via `devbox global add <package>`

## Tooling Preferences

Prefer modern, widely-adopted tools. Battle-tested tools (`grep`, `find`, etc.)
are fine when they fit.

| Purpose              | Preferred        |
| -------------------- | ---------------- |
| File search          | `fd`             |
| Text search          | `ripgrep` (`rg`) |
| Python package mgmt  | `uv`             |
| Node.js package mgmt | `pnpm`           |

## Git Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/).

```
<type>(<scope>): <description>

[optional body]
```

- **type**: English (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`,
  `ci`, `style`)
- **scope**: Optional area of change (e.g., `cli`, `docker`, `bootstrap`)
- **description**: Japanese, imperative, concise (~50 chars)
- **body**: Optional — explain why, not what
- One commit = one logical change
- Mark breaking changes with `!` (e.g., `feat(api)!: レスポンス形式を変更`)

## Code Quality

- Names reveal intent — avoid abbreviations
- One function does one thing; prefer early returns over deep nesting
- Write **why** comments, not what — the code explains what
- Prefer pure functions; localize side effects
- Run linter/formatter before committing
- Write tests as specs of behavior, not implementation details
