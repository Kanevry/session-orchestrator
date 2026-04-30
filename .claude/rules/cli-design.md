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

## Shared Shell Library (common.sh / common.mjs)
- Top-level install/quality-gate scripts have been ported to `.mjs` equivalents (`scripts/codex-install.mjs`, `scripts/cursor-install.mjs`, `scripts/run-quality-gate.mjs`, etc.). New scripts should be written as `.mjs` and import from `scripts/lib/common.mjs`.
- `scripts/lib/common.sh` is retained for the nested `.sh` scripts under `scripts/lib/gates/` and `scripts/lib/validate/` that still require a bash source context. Do not delete it.
- Shell scripts that still need `common.sh` MUST source it via: `SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"` then `source "${SCRIPT_DIR}/lib/common.sh"`.
- Use `parse_flags "$@"` for `--verbose`, `--json`, `--dry-run`, `--help`, `--version` flags.
- Use `print_help "$HELP_TEXT"` and `show_version "name" "$VERSION"` for standard flag handling.
- Use `require_commands cmd1 cmd2` to validate dependencies at startup (exits 2 if missing).
- Use `require_env VAR1 VAR2` to validate environment variables (exits 1 if missing).
- Use `log_info`/`log_success`/`log_warn`/`log_error` for TTY-aware colored output.
- Use `json_output "$json"` for formatted JSON output (auto-pipes through `jq` if available).
- Use `api_call METHOD url [auth]` for HTTP requests with timeout and error handling.
- Use `assert_git_repo [path]` and `assert_clean_worktree [path]` for git precondition checks.
- Use `get_git_remote_url [path]` to extract the git remote origin URL.
- Use `iterate_repos callback_fn` to loop over all repos in `~/Projects/` with a callback function.
- Use `setup_cleanup VAR_NAME` to register a trap that removes the directory in `$VAR_NAME` on EXIT.

## See Also
development.md · security.md · security-web.md · security-compliance.md · testing.md · test-quality.md · frontend.md · backend.md · backend-data.md · infrastructure.md · swift.md · mvp-scope.md · parallel-sessions.md · ai-agent.md
