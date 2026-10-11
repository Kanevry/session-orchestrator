# Phase 3.7e: Vault Orphans (#1563)

> Sub-file of the session-end skill (#1157 - agentskills.io: SKILL.md core < 500 lines, procedure in `references/`). `SKILL.md` and `references/phase-3-documentation-updates.md` keep a short stub naming this phase and its gate condition.

## Why

A session that writes into the Meta-Vault (an audit, a report, a review, a handover) leaves an untracked file in ANOTHER repo. Its own close commits only in its own repo, and vault-mirror auto-commits only its own generator-marked files in `40-learnings/` and `50-sessions/` (`scripts/lib/vault-mirror/auto-commit.mjs`). Nothing else ever looks. Measured 2026-10-11: 268 untracked files had piled up in one vault checkout over five days. The writing session is the only one that knows it wrote them, so this phase makes it look before it closes.

## Gate

- Skip silently unless `vault-integration.enabled: true` in Session Config.
- Skip silently when `<state-dir>/STATE.md` does not exist or has no `started_at` in its frontmatter (`persistence: false`): there is no session window to measure against and no place to record the result.

## Ordering

Runs AFTER Phase 3.7d (Session-Eval) and BEFORE Phase 3.4 (`status: completed`), so the Open Question below is written while STATE.md is still `status: active`. See the Phase 3.4 Runtime Ordering Note.

## Procedure

1. Read `started_at` from the STATE.md frontmatter (the same value Phase 3.7 writes into `sessions.jsonl`).
2. Run the read-only probe from the repo root, so the host-local vault-dir resolution (`SO_VAULT_DIR` > owner.yaml > committed `vault-integration.vault-dir`) sees this repo's Session Config:

   ```bash
   node "$PLUGIN_ROOT/scripts/vault-orphans.mjs" --since "<STATE.md started_at>" --json
   ```

   Exit `0` = measured (the JSON may hold zero candidates), `1` = bad arguments (fix the call), `2` = could not measure. The JSON is the result of `findVaultOrphans()` in `scripts/lib/session-end/vault-orphans.mjs`:

   - `{ status: 'ok', candidates: [{ path, mtimeMs }], total, truncated, untracked }` - `path` is vault-relative; `candidates` holds at most 200 entries sorted by path, `total` counts all of them, `untracked` is everything git listed before the filters.
   - `{ status: 'unavailable', reason, detail?, candidates: [] }` - no vault dir, not a git repo, or git failed.

   A candidate is an untracked, not gitignored vault file whose mtime is at or after `started_at` and whose first 4 KB carry no `_generator: session-orchestrator-` frontmatter line (those files belong to vault-mirror, the narrative mirror, the active-sessions board or the portfolio writer).

3. Disposition:

   - **`total > 0`** - NAME the candidates in the Final Report (see `session-summary-template.md`, line `Vault orphans`), then record ONE Open Question in STATE.md, listing up to 10 paths and the count:

     ```javascript
     import { appendOpenQuestionOnDisk } from '${PLUGIN_ROOT}/scripts/lib/state-md.mjs';

     const shown = result.candidates.slice(0, 10).map((c) => c.path);
     const more = result.total - shown.length;
     await appendOpenQuestionOnDisk(process.cwd(), {
       question:
         `Vault: ${result.total} untracked file(s) modified during this session: ` +
         `${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}. ` +
         'Commit, move or delete them in the vault - mtime is a hint, not proof this session wrote them.',
       source: 'session-end/3.7e',
       priority: 'medium',
     });
     ```

     The question survives the next session-start Idle Reset and is surfaced there as a forced read (`skills/_shared/state-ownership.md` Open Questions), so the next session or the vault owner sorts the files in.
   - **`total === 0`** - report `none since session start` in the Final Report. No Open Question.
   - **`status: unavailable`** (exit 2) - report `could not measure (<reason>)`. NEVER report it as "no orphans": a missing measurement is not a zero. No Open Question.

## What this phase never does

It does NOT commit into the vault, does NOT delete, does NOT move anything (PSA-003). The mtime window does not prove that this session wrote a file - a concurrent session of another repo may have written the same file in the same window - and the vault is another repo with its own rules. The phase reports; the vault owner disposes.

**Non-blocking:** a probe failure, a non-zero exit or a failed STATE.md write MUST NOT block the close. Log one `WARNING: vault orphans - <reason>; continuing close` line and proceed.

No Session Config key and no event type belong to this phase; it is a report.
