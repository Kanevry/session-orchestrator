# Phase 1.7: Vault Live-Status Board (#674)

> Sub-file of the session-start skill (#1157 — agentskills.io: SKILL.md core < 500 lines, procedure in `references/`). Extracted VERBATIM from `skills/session-start/SKILL.md`; `SKILL.md` keeps a one-line stub naming this phase and its gate condition.

## Phase 1.7: Vault Live-Status Board (#674)

> Skip this phase silently when `vault-integration.enabled` is not `true` in Session Config. Use the same `jq -r` idiom Phase 2.7 uses (`echo "$CONFIG" | jq -r '."vault-integration".enabled // false'`). When the value is anything other than `true`, do nothing and proceed to Phase 2 — no banner, no warning.

When active, this phase marks THIS repo as live on the cross-repo vault board (`<vault-dir>/01-projects/_active-sessions.md`) so an operator scanning the vault can see, at a glance, which repos have a session in flight. Epic #673 / PRD §FA-1.

### Config check

```bash
VAULT_ENABLED=$(echo "$CONFIG" | jq -r '."vault-integration".enabled // false')
if [ "$VAULT_ENABLED" != "true" ]; then
  exit 0  # silent no-op — vault integration disabled
fi
```

### Dispatch

Call `sweepBoard` from `scripts/lib/vault-status/board-writer.mjs` — the host-wide sweep (issue #716):

```js
import { sweepBoard } from 'scripts/lib/vault-status/board-writer.mjs';

await sweepBoard({
  repoRoot: process.cwd(),
});
```

`sweepBoard` enumerates candidate repos host-wide (`enumerateCandidates` — confinement root `~/Projects` plus any `cross-repo.projects` config-declared repos, issue #676), re-derives the board status for every BUSY repo it finds (`in-progress` or `force-closed`, never `frei`), unions in THIS repo so its own row is always re-derived, and writes the board in one idempotent merge. **A crashed session in ANY repo now renders `force-closed` on the board from THIS repo's session-start** — not only from that repo's own next session-start/-end.

> **Call-site contract:** `sweepBoard` is now the primary call. `explicitStatus` is **inert for `'in-progress'`** — `collectRows` only honors an explicit per-repo `status: 'closed'` override; THIS repo's `in-progress` row is always rendered from its own **live `session.lock` lease** (already written/heartbeated by Phase 1.2's `acquire()`), never from a passed-in status string. If constructing `repos` manually for a narrower sweep, `collectRows` requires `{ repoRoot }` object descriptors and silently skips bare path strings (`board-writer.mjs` `collectRows` guard) — `sweepBoard`/`buildSweepRepos` already produce the correct shape, so this only matters for a hand-rolled `mirrorBoard({ repos })` call.

This single call does three things:

1. **Sets THIS repo's board row to `in-progress`** with the current semantic-session-id **attribution label** (never a lock/registry ownership key), branch, mode, and heartbeat (read off this repo's `session.lock` v2 lease + the host-wide registry — both already written by Phase 1.2's `acquire()`).
2. **Re-derives THIS repo's status from its live lease**, so a stale lease left by a prior crashed session in this same repo renders as `force-closed` (heartbeat older than the v2 ttl, default 4h — `DEFAULT_TTL_HOURS` in `scripts/lib/session-lock.mjs`, evaluated via `isLockLive`) and is **never silently dropped** — its fields are read straight off the dead lock.
3. **Re-derives every OTHER busy repo's status host-wide** via `enumerateCandidates` — a dead lease in repo B renders `force-closed` on the board the next time ANY repo's session-start runs `sweepBoard`, closing the #676→#716 gap. `frei` (lock-less) repos are excluded from re-derivation to avoid board noise; their prior rows, and the prior rows of any repo `enumerateCandidates` did not surface, are preserved unchanged via the idempotent merge — never dropped.

`sweepBoard` internally calls `mirrorBoard`, which re-reads Session Config, resolves the host-local vault-dir, and **silently no-ops** (returning `{ action: 'skipped-vault-disabled' }`) when `vault-integration.enabled` is not `true`, the vault-dir is absent, the vault resolves outside `$HOME`, or the config is unreadable. The Bash gate above is the fast-path skip; this internal guard is the defense-in-depth backstop — both agree on the same condition.

### Safety invariants

- **Generator-marked + idempotent.** The board carries the `_generator: session-orchestrator-active-sessions@1` frontmatter sentinel; repeated writes that produce identical content are no-ops, so re-running this phase never churns the file.
- **Host-local + git-ignorable.** The board lives under the operator's vault tree (under `$HOME`), never inside any repo — it is never committed.
- **NEVER touches the human-authored `_overview.md`.** The writer hard-refuses any path whose basename is `_overview.md` (returns `{ action: 'skipped-handwritten' }`), and only ever overwrites files it owns (frontmatter `_generator` matches the marker). The handwritten overview is structurally safe.

### Non-blocking behavior

This is **best-effort**, exactly like the Phase 4 banners: a board-write failure (I/O error, thrown exception, malformed lease, or a failed host-wide enumeration) MUST NOT halt session-start. `sweepBoard` already degrades internally — if `enumerateCandidates` throws for any reason, it falls back to the pre-#716 single-repo write (`mirrorBoard({ repoRoot, explicitStatus: 'in-progress' })`) so the board write still happens. On top of that internal fallback, the coordinator MUST STILL wrap the `sweepBoard` call so any remaining error is swallowed and logged as a single WARN line, then continue to Phase 2. Session-start is never blocked by a vault-board failure.

