# Cloopy Development Environment

## Rules

- Always respond in Japanese.

## Environment

- Shell: zsh
- IDE: VS Code Remote SSH
- Workspace: `/home/developer/workspace` — place projects here

## Network Egress

This container runs behind a default-deny egress firewall (iptables + ipset).
Only a curated allowlist of domains (Anthropic, GitHub, npm/PyPI/crates/Go,
Nix/Devbox, Ubuntu apt) is reachable. The following are **always blocked**,
even when the firewall is set to `off`:

- Cloud metadata services (`169.254.169.254`, Alibaba `100.100.100.200`)
- RFC1918 private ranges (`10/8`, `172.16/12`, `192.168/16`)
- CGNAT / Tailscale (`100.64.0.0/10`)
- All IPv6 outbound

If a network operation fails (timeout, connection refused, DNS unresolved for
an IP), **assume the firewall blocked it**. This is by design — it limits
exfiltration and metadata-service abuse from compromised packages or runaway
agents.

**Do not attempt to bypass the firewall.** Specifically, do not:

- Edit iptables / ip6tables / ipset rules (even though `NET_ADMIN` is granted)
- Disable services under `/etc/s6-overlay/s6-rc.d/init-firewall` or
  `svc-firewall-refresh`
- Route traffic through alternative resolvers, DoH endpoints, or proxies to
  reach blocked hosts
- Suggest workarounds like `curl --resolve`, `/etc/hosts` injection, or
  tunneling

**To legitimately allow a new domain**, tell the user. They will add it to
`CLOOPY_EXTRA_DOMAINS` in `.env` on the host and restart the container.
This intentionally requires a host-side action — runtime mutation by the
agent is not supported.

If a task genuinely requires a blocked destination, stop and report it.
Do not improvise around it.

## Package Management

- Use **Devbox** for system-level packages: `devbox global add <package>`
- For project-local packages, use `devbox add` only when the project has a
  `devbox.json`
- If a tool is missing, try installing it via Devbox before considering
  alternatives. Any package available in Nixpkgs should be managed through
  Devbox.

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
