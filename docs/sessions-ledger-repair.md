# Session ledger diagnosis and repair

The session ledger is `.orchestrator/metrics/sessions.jsonl`. Diagnose schema
failures separately from records that vault-mirror cannot render. Repairing a
ledger is a write operation; a guard allowance does not authorize repairing a
consumer's history. Obtain a separate task before applying repairs to a real
consumer or vault ledger.

## Missing metrics are unknown

`validateSession` accepts an absent or `null` `effectiveness`. All three mirror
renderers accept that same shape and display unknown metrics as `n/a` (or the
existing table placeholder). A measured zero remains zero. Optional missing
subfields likewise remain unknown; neither rendering nor repair invents issue
counts or completion rates. A malformed non-object `effectiveness`, including
an array, still fails rendering.

Legacy V2 and V3 records can render while failing the canonical writer schema.
V2 lacks canonical aggregate fields; V3 uses scalar `waves` instead of the
required array. Those are separate schema defects, not evidence that missing
`effectiveness` needs a migration. An already schema-valid historical line is
preserved byte-for-byte by the repair helper, with one exception (#1705): a
valid record whose `completed_at` copies a valid, monotonic `ended_at` but is
still listed in `_backfill_incomplete_fields` is healed (status `repaired`,
counted `healed_valid`, defect `completed_at_flag_stale`; the prior list is kept
once in `_backfill_incomplete_fields_raw`).

## Read-only diagnosis

Use the installed plugin's actual absolute script path and the actual project
root. These examples use generic paths:

```sh
node /opt/plugin/scripts/check-sessions-integrity.mjs --repo-root /work/repo --json
node /opt/plugin/scripts/repair-invalid-sessions.mjs --dry-run --repo-root /work/repo --json
```

The integrity command and session-start banner evaluate validation and the real
mirror render path independently. The banner reports `schemaInvalid` and
`mirrorSkipped`; a render-only failure is not proof of a schema failure or of
how a record was written. A schema-invalid record that still renders produces
a warning; a mirror skip produces an alert. Abandoned session filtering applies
to this banner population.

Repair dry-run reports schema defects, projected repairs, and the lines that
would remain unrepairable. It is a repairability preview, not an integrity
verdict: exit 0 alone does not prove that every record currently validates and
renders. Compare named lines and defect classes, accounting for banner filters
and renderer-only failures rather than expecting all totals to be identical.
Dry-run writes nothing and is the CLI default. The CLI can diagnose a metrics
directory outside a Git repository; the new guard allowance for apply cannot.

## Apply and recovery

The repair CLI retains its existing contract: before replacing the file it
creates a mandatory `<file>.bak-<stamp>` backup, writes replacement content to
a temporary file, and atomically renames it over the target. It verifies the
result against validation and, for the canonical ledger path, integrity. Failed
post-verification restores the backup byte-for-byte. Repairable rows retain
their position; valid rows (except the stale-flag heal above) and unrepairable
rows retain their original bytes.
Duplicate IDs are observed, never deduplicated. Repeating a successful repair
preserves ledger bytes; `--apply` still creates a backup and atomically replaces
the file.

The CLI restricts targets to `<repo-root>/.orchestrator/metrics/`, resolving
parent symlinks for containment. Its broader CLI flags do not broaden the
guard's apply allowance.

| Exit | Meaning |
| --- | --- |
| 0 | Completed; no unrepairable remainder reported (dry-run may propose repairs) |
| 1 | Argument or target error |
| 2 | System or I/O error |
| 3 | Post-verification failed; backup restored, no repairs kept |
| 4 | Repairable lines handled; unrepairable lines remain unchanged |

Exit 3 takes precedence over exit 4. Inspect the summary and retained backup
before deciding on further work; never bypass the ledger guard to force a repair.

## Guarded apply commands

The existing exact relative form remains supported:

```sh
node scripts/repair-invalid-sessions.mjs --apply
```

The additional allowance accepts only the installed plugin's canonical absolute
repair script, with `--apply` followed by mandatory `--repo-root` and the
absolute current Git top-level:

```sh
node /opt/plugin/scripts/repair-invalid-sessions.mjs --apply --repo-root /work/repo
node '/opt/plugin with spaces/scripts/repair-invalid-sessions.mjs' --apply --repo-root '/work/repo with spaces'
```

Use literal path values, with simple single quotes for spaces. Do not place
`$PWD`, environment expansions, command substitutions, escaping, redirections,
pipes, chained commands, or shell wrappers in the tool command. Additional
flags (including `--file`, `--json`, or `--dry-run`), reordered arguments,
alternative Node spellings, and foreign script paths do not qualify.

The script and all path components must exist at canonical absolute paths
without symlinks. The measured Git top-level for the hook process and payload
working directory must agree. The measured root must also contain both physical
working directories; a local `core.worktree` setting that reports a root
elsewhere grants no apply allowance. The hook's project resolver, including
launcher-provided context, must resolve to that same root. The explicit root
must exactly equal the measured realpath: no trailing slash, `..`, subdirectory
or another checkout. Omitting `--repo-root` is denied: a child CLI without the
hook's launcher variables could otherwise select a nested `CLAUDE.md` root.
Git discovery/configuration overrides,
a symlinked `.git` marker, context disagreement, or a failed Git measurement
deny the additional allowance. A sandbox Git error is a denial, not evidence
that the native target context works.

For synthetic mirror or repair probes, set `SO_VAULT_DIR` to a fresh temporary
directory before running the probe and let child processes inherit it. Apply
tests belong only on disposable ledgers with isolated configuration. Native
path and process behavior requires a suitable native runner; sandbox results
do not establish macOS acceptance.

The absolute repair allowance denies `--repo-root` equal to or inside the
realpath-resolved vault directory. The existing resolver gives precedence to
`SO_VAULT_DIR`, owner configuration (`vault-dirs`, then `paths.vault-dir`), then
the committed `vault-dir`. A measurable configured vault takes precedence over
the fallback. If resolution has no value, fails, or cannot be canonicalized,
only the realpath-resolved `<canonical HOME>/Projects/vault` and its descendants
are denied. Prefix neighbors such as `vault-x` and other `vault` segments under
`Projects` are not fallback targets. If the fallback also cannot be measured,
it adds no denial; the other absolute-allowance checks still apply.

This check applies only to the absolute repair allowance. The exact relative
repair exception is unchanged; the check is not a general vault-write boundary.
Vault ledgers remain forbidden repair targets under this runbook, regardless
of whether a command receives a guard allowance.
