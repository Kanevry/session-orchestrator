---
name: portfolio
description: Aggregate cross-repo issue/MR/CI health across vault-registered projects into a single Markdown dashboard
user-invocable: true
argument-hint: "[--dry-run] [--repo <name>]"
model: inherit
---
# Portfolio

## Invocation

The user invoked `/portfolio` with arguments: **$ARGUMENTS**. This skill carries the argument validation (`--dry-run`, `--repo <name>`), the config/mode/vault gates, the dispatch into `scripts/lib/gitlab-portfolio/cli.mjs`, and the exit-code table — all below; `skills/gitlab-portfolio/SKILL.md` owns the dashboard schema.

Aggregates open issues, MRs, and staleness signals across all vault-registered repositories and writes a structured dashboard to `<vault-dir>/01-projects/_PORTFOLIO.md`.

## Argument Validation

Parse `$ARGUMENTS` before doing anything else.

Recognized flags:

- `--dry-run` — run discovery + aggregation, print the diff to stdout, do NOT write the dashboard. Sets `dry_run = true`.
- `--repo <name>` — limit the run to a single vault slug (e.g. `session-orchestrator`). Implies `--dry-run` unless explicitly combined with a write flag. Useful for testing repo discovery without refreshing the full portfolio.

If `$ARGUMENTS` contains an unrecognized flag (starts with `--` but is not one of the above), inform the user:

```
Unknown flag '<flag>'. Recognized flags: --dry-run, --repo <name>.
```

Then continue with the remaining valid arguments.

## Behavior

1. **Config gate** — The CLI reads the `gitlab-portfolio:` block from Session Config. Only `enabled: true` activates it: an absent block parses to the default `enabled: false` (`scripts/lib/config/gitlab-portfolio.mjs`), and in both cases the CLI prints `gitlab-portfolio: disabled (set gitlab-portfolio.enabled: true in Session Config)` and exits 0.

2. **Mode gate** — If `mode: off`, the command is a no-op: the CLI checks it before vault resolution and any repo scan, prints `gitlab-portfolio: mode: off — skipped (set gitlab-portfolio.mode: warn|strict to run)` and exits 0 (#1619). Dispatch as usual; under `strict`, repo fetch failures exit 2.

3. **Vault resolution** — The CLI takes `--vault-dir`, else `vault-integration.vault-dir` from Session Config (resolved host-locally). If neither yields a path it prints `gitlab-portfolio: vault-integration.vault-dir not configured in Session Config` and exits 2. `vault-integration.enabled` is not checked: a configured `vault-dir` is used even when vault integration is disabled.

4. **Dispatch** — Invoke `scripts/lib/gitlab-portfolio/cli.mjs` with the resolved arguments:

   ```bash
   node scripts/lib/gitlab-portfolio/cli.mjs \
     --vault-dir <vault-dir> \
     [--dry-run] \
     [--repo <name>]
   ```

5. **Report** — Print the action result emitted by the CLI (`action: written | skipped-noop | skipped-handwritten | dry-run`) and exit with the CLI's exit code.

## Config Required

Minimum Session Config to enable the command:

```yaml
vault-integration:
  enabled: true
  vault-dir: ~/Projects/vault
gitlab-portfolio:
  enabled: true
```

Full config reference (all fields with defaults):

```yaml
gitlab-portfolio:
  enabled: true
  mode: warn          # warn | strict | off
  stale-days: 30
  critical-labels: ["priority::critical", "priority::high"]
```

## Output Format

See `skills/gitlab-portfolio/SKILL.md` § Output format for the full dashboard schema (frontmatter keys, summary table, per-repo sections, idempotency guard).

## Error Modes

Behaviour is governed by the `mode` config field:

- `warn` (default): per-repo CLI failures are logged to stderr; the portfolio is rendered with the remaining repos. Exit 0.
- `strict`: any repo fetch failure causes a non-zero exit before writing. The dashboard is NOT written.
- `off`: command is a silent no-op. Logs a single line and exits 0.

`--vault-dir` not found and write errors always exit 2 regardless of `mode`.

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success (or `mode: off` / `enabled: false` no-op) |
| `1` | User error (bad arguments, `--repo` names no discovered repo) |
| `2` | System error (Session Config unreadable, no `vault-dir` configured, `vault-dir` outside the home directory, repo discovery or fetch crashed, write failed, repo fetch failures in `strict` mode) |

Exit codes follow `.claude/rules/cli-design.md` conventions.

## Related

- `skills/gitlab-portfolio/SKILL.md` — skill spec, aggregation phases, output schema, error handling (GH #41)
- `skills/vault-mirror/SKILL.md` — vault registration conventions (`_overview.md` frontmatter, `.vault.yaml`)
- Session-start Phase 2.7 — optional banner that surfaces portfolio staleness at session-start in dry-run mode
