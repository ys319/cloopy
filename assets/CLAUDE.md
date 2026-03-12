# Cloopy Development Environment

## Rules

- Always respond in Japanese.

## Environment

- Shell: zsh
- IDE: VSCode Remote
- Workspace: `/home/developer/workspace` — place projects here

## Package Management

- Use **Devbox** for system-level packages: `devbox global add <package>`
- Use **Volta** for Node.js toolchain (already installed via devbox global)
- For project-local packages, use `devbox add` only when the project has a
  `devbox.json`

## Tooling Preferences

Prefer modern, widely-adopted tools unless there's a reason not to. That said,
battle-tested tools (`grep`, `find`, etc.) are perfectly fine — don't force a
newer tool if it means getting stuck on an unstable API.

| Purpose              | Preferred        |
| -------------------- | ---------------- |
| File search          | `fd`             |
| Text search          | `ripgrep` (`rg`) |
| Python package mgmt  | `uv`             |
| Node.js package mgmt | `pnpm`           |
| TypeScript backend   | Deno or Bun      |

Install missing tools via `devbox global add <package>`.

## Formatting

- Format Markdown with `deno fmt`

## Git Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/).

### Format

```
<type>(<scope>): <description>

[optional body]
```

- **type**: English, from the table below
- **scope**: Optional. Area of change (e.g., `cli`, `docker`, `bootstrap`)
- **description**: Japanese, imperative, concise
- **body**: Optional. Explain why, not what

### Types

| Type       | When to use                                |
| ---------- | ------------------------------------------ |
| `feat`     | New feature                                |
| `fix`      | Bug fix                                    |
| `docs`     | Documentation only                         |
| `refactor` | Code restructuring without behavior change |
| `test`     | Adding or updating tests                   |
| `chore`    | Build, deps, config, and other maintenance |
| `perf`     | Performance improvement                    |
| `ci`       | CI/CD configuration                        |
| `style`    | Formatting only (no logic change)          |

### Examples

```
feat(cli): セットアップウィザードを追加

fix(docker): ヘルスチェックのタイムアウトを修正

docs: README の Quick Start を更新

refactor(bootstrap): Node.js インストールを削除

不要な毎起動処理を除去し、起動時間を短縮。
```

### Rules

- One commit = one logical change
- Keep description under ~50 characters
- Separate body from description with a blank line
- Mark breaking changes with `!` after type/scope (e.g.,
  `feat(api)!: レスポンス形式を変更`)

## Code Quality

Good code is written to be read, not just to run.

### Naming & Readability

- Names should reveal intent — avoid abbreviations and cryptic shortcuts
- One function does one thing
- Avoid deep nesting; prefer early returns and guard clauses
- Replace magic numbers with named constants

### Comments

- Write **why**, not what — the code explains what
- Don't comment the obvious; do comment non-obvious decisions and intentional
  workarounds

### Design

- Minimize working memory load on the reader — reduce the number of things to
  track at once
- Prefer pure functions; localize side effects
- Make contracts explicit via types, interfaces, and schemas
- Abstract over stable concepts, not incidental duplication (avoid premature
  abstraction)

### Quality Assurance

- Run linter/formatter before committing
- Write tests as specs of behavior, not implementation details
- Cover edge cases: empty, null, boundary values, error paths
- Follow the language's idiomatic style and best practices
