---
description: Aggregate cross-repo issue/MR/CI health across vault-registered projects into a single Markdown dashboard
argument-hint: "[--dry-run] [--repo <name>]"
---

# Portfolio

Aggregates open issues, MRs, and staleness signals across all vault-registered repositories and writes a structured dashboard to `<vault-dir>/01-projects/_PORTFOLIO.md`. Invoke the `gitlab-portfolio` skill with arguments: **$ARGUMENTS**

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

1. **Config gate** — Read the `gitlab-portfolio:` block from Session Config. If `enabled: false` (or the block is absent), log `Portfolio: disabled (gitlab-portfolio.enabled is false) — set enabled: true to activate.` and return exit code 0.

2. **Mode gate** — If `mode: off`, the command is a silent no-op; log a single line and exit 0.

3. **Vault resolution** — Read `vault-integration.vault-dir` from Session Config. If `vault-integration.enabled: false` or `vault-dir` is absent, exit 1 with: `Portfolio: vault-integration must be enabled with vault-dir set.`

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
  critical-labels: ["priority:critical", "priority:high"]
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
| `1` | User/config error (bad args, missing vault config) |
| `2` | System error (vault-dir not found, write failed) |
| `3` | Repo fetch failures in `strict` mode |

Exit codes follow `.claude/rules/cli-design.md` conventions.

## Related

- `skills/gitlab-portfolio/SKILL.md` — skill spec, aggregation phases, output schema, error handling (GH #41)
- `skills/vault-mirror/SKILL.md` — vault registration conventions (`_overview.md` frontmatter, `.vault.yaml`)
- Session-start Phase 2.7 — optional banner that surfaces portfolio staleness at session-start in dry-run mode
