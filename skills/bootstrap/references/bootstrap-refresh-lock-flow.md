# Bootstrap — Refresh-Lock Flow (`--refresh-lock`)

> Reference of the `bootstrap` skill, split out of `SKILL.md` (#1246). Body moved **byte-identical**; only this header is new.
> **Sibling-file paths inside this body are relative to the parent directory, not to `references/`**: `SKILL.md` → `../SKILL.md`. They were deliberately NOT rewritten, so the moved bytes stay verifiable against the pre-split file.

## Refresh-Lock Flow (`--refresh-lock`)

Entered when `$ARGUMENTS` contains `--refresh-lock`. No scaffolding questions are asked, and — unlike the Retroactive Flow above — this is NOT a no-op once the lock already has valid `version`/`tier` fields: refreshing is the load-bearing action.

**Purpose (#57):** Acknowledge the current plugin version and reset the freshness clock on an existing, already-valid `bootstrap.lock` without disturbing its original bootstrap provenance. This closes the gap left by the Retroactive Flow: once a lock already has `version` + `tier`, re-running `/bootstrap --retroactive` reports "bootstrap.lock already present ... Nothing to do." and changes nothing — exactly the no-op the bootstrap-lock-freshness probe (#186/#290) was recommending as its remediation. `--refresh-lock` is the actual remediation for a present-but-stale or version-drifted lock.

**Steps:**

1. **Precondition check.** Read `.orchestrator/bootstrap.lock`. If missing, or present but missing a non-empty `version` or `tier` field, abort with: `Error: No valid bootstrap.lock found. Run /bootstrap or /bootstrap --retroactive first.` Do not fabricate a lock — this flow only refreshes an existing one.

2. **Resolve the current plugin version.** Read `plugin-version` from `$PLUGIN_ROOT/package.json` (same source Phase 4 uses).

3. **Call the refresh writer.**

   ```js
   import { refreshBootstrapLock } from '$PLUGIN_ROOT/scripts/lib/bootstrap-lock-refresh.mjs';
   const result = refreshBootstrapLock({
     repoRoot: REPO_ROOT,
     currentPluginVersion: PLUGIN_VERSION,
   });
   ```

   `refreshBootstrapLock` writes (or replaces, if already present) exactly two lines — `refreshed-at: <ISO 8601 UTC>` and `refreshed-plugin-version: <current plugin version>` — via the same atomic tmp-file + rename pattern used by the Retroactive Flow's lock write: write to a sibling tmp file, then rename over the target so the lock is never observed half-written. **Every other line of the lock — `bootstrapped-at`, `timestamp`, `plugin-version`, `tier`, `archetype`, `source`, … — is left byte-identical.** This is the provenance-honesty guarantee: a refresh is an acknowledgement, not a re-bootstrap. On failure (`result.ok === false`), surface `result.message` and stop — do not retry with a fabricated lock.

4. **No auto-commit.** Unlike the Retroactive Flow, `--refresh-lock` does not stage or commit. The refreshed lock is a small, reviewable diff (two changed/added lines); the user commits it alongside their own work at their own cadence.

5. **Report.** Print: `Lock refreshed (refreshed-at: <now>, plugin-version: <current>). Original bootstrap provenance unchanged.`

**Idempotency.** Running `/bootstrap --refresh-lock` twice in a row replaces the same two lines in place — it never duplicates them.

---

