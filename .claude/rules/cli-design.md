---
paths:
  - scripts/**
  - bin/**
  - cli/**
  - src/cli/**
  - src/commands/**
  - packages/*/bin/**
  - tools/**
  - "*.sh"
---

# CLI Design Rules

## JSON-First Output
- Every CLI MUST support a `--json` flag for structured output.
- Default output should be human-readable; `--json` produces machine-parseable JSON.
- Data goes to stdout, errors/diagnostics to stderr. Never mix.

## Exit Codes
- `0` — Success
- `1` — User/input error (bad args, invalid file)
- `2` — System error (network, permissions, missing dependency)
- Document non-standard exit codes in `--help`.

## Composability
- Support stdin piping where it makes sense (`cat input.json | cli process`).
- No interactive prompts in automation mode. Use `--yes` / `--no-interactive` flags.
- Prefer subcommands over flags for distinct operations: `cli export png` over `cli --export --format png`.

## Discoverability
- `--help` must be comprehensive: describe what the command does, list all options, show examples.
- `--version` returns semver.
- If the CLI wraps a service, ship a `SKILL.md` alongside it (see `templates/shared/SKILL.md.template`).

## Dual CLI + MCP Pattern
- Build CLI first. Optionally expose the same capabilities as MCP server later.
- Same function should power both interfaces — don't duplicate logic.
- Reference: steipete/Peekaboo (Swift), HKUDS/CLI-Anything (Python).

## Testing Layers
| Layer | What | When |
|-------|------|------|
| Unit | Core logic functions | Every commit |
| Integration | CLI argument parsing, flag handling | Every commit |
| Snapshot | Output format stability (JSON schema) | Every commit |
| E2E | Full command execution, exit codes, piping | CI pipeline |

## Dependencies & Distribution
- Node.js CLIs: use `commander` or native `parseArgs`. Ship via `npx` or bin entry in package.json.
- Shell scripts: use `getopts` for flag parsing. ShellCheck must pass.
- Configure ShellCheck via `.shellcheckrc` at project root (severity, disabled rules). See baseline `.shellcheckrc` for reference.
- Never require global installs — npx or project-local bin.

## Shared Module Library (common.mjs)

The plugin uses a single shared module library — `scripts/lib/common.mjs` — for ESM utilities. The legacy `scripts/lib/common.sh` and `scripts/lib/platform.sh` shell sources have been removed (issues #218 + #317; commit history). All scripts under `scripts/lib/` are now `.mjs` and import from this module.

- Top-level orchestrators (`scripts/run-quality-gate.mjs`, `scripts/validate-plugin.mjs`, `scripts/codex-install.mjs`, `scripts/cursor-install.mjs`, etc.) spawn `.mjs` sub-scripts via `node`, never `bash`.
- Nested helpers under `scripts/lib/gates/` and `scripts/lib/validate/` are `.mjs` modules. The gates layer additionally exposes a domain-local `scripts/lib/gates/gate-helpers.mjs` for gate-specific helpers (run check, extract counts, debug-artifact collection, change-set resolution).
- New scripts MUST be `.mjs`. Use named exports from `scripts/lib/common.mjs` for: `die`, `warn`, `requireJq`, `findProjectRoot`, `resolvePluginRoot`, `makeTmpPath`, `utcTimestamp`, and other shared helpers.
- For platform-specific behavior, use `scripts/lib/platform.mjs`.
- For test patterns + change-set helpers + per-gate parsing, use `scripts/lib/gates/gate-helpers.mjs`.
- For atomic file IO + JSON helpers, use `scripts/lib/io.mjs`.

There is no longer a Bash sourcing convention to follow. Cross-cutting CLI flag parsing (`--verbose`, `--json`, `--dry-run`, `--help`, `--version`) is the responsibility of each `.mjs` orchestrator using either `parseArgs` from `node:util` or a small helper in `common.mjs`.

## See Also
development.md · security.md · security-web.md · security-compliance.md · testing.md · test-quality.md · frontend.md · backend.md · backend-data.md · infrastructure.md · swift.md · mvp-scope.md · parallel-sessions.md · ai-agent.md
