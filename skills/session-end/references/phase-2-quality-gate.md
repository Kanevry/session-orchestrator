# Phase 2: Quality Gate

> Sub-file of the session-end skill (#1157 — agentskills.io: SKILL.md core < 500 lines, procedure in `references/`). Extracted VERBATIM from `skills/session-end/SKILL.md`; `SKILL.md` keeps a one-line stub naming this phase and its gate condition.

## Phase 2: Quality Gate

> **Verification Reference:** See `verification-checklist.md` in this skill directory for the full quality gate checklist.

Run ALL checks listed in the verification checklist. If any check fails: fix if quick (<2 min), otherwise create a `priority::high` issue. Do NOT commit broken code.

### Phase 2.0a: Echo-Stub Detection (GH #42)

`gate-full.mjs` emits a top-level `stubbed: {}` map in its JSON result, keyed by check name (`typecheck`, `test`, `lint`); value is `{ kind: 'echo'|'noop' }`. When any check was short-circuited as a stub, `runCheck()` already returned `status: 'pass'` — so the overall gate verdict is green, but the result is meaningless.

**Detection:** immediately after parsing the `gate-full` JSON result, evaluate:

```js
const stubbedEntries = Object.entries(result.stubbed ?? {});
```

**If `stubbedEntries.length > 0`**, surface a HIGH WARN block in the close summary:

```
⚠ QUALITY GATE STUBBED — <N> command(s) are echo/noop stubs, not real checks:
  - <check-name>: <kind> stub  (configured: "<command string>")
Re-configure with a real test command in CLAUDE.md Session Config before /close,
OR document this exception in /close --reason.
```

**Behavior by `enforcement` mode:**

- `enforcement: strict` — **block /close**. Treat as a Phase 2 failure. Present the WARN block and exit without committing.
- `enforcement: warn` (default) — continue, but write `quality-gate-stubbed: true` to STATE.md Deviations so the metrics writer captures it.
- `enforcement: off` — silent. Emit a single-line `stderr` log only (`echo-stub detected: <check-name>`).

**Recipe:** for container-based test runners (e.g. EspoCRM PHPUnit) where an echo-stub was the historical workaround, see [`docs/recipes/quality-gate-container-pattern.md`](../../../docs/recipes/quality-gate-container-pattern.md).

**Source issue:** GH #42 (root cause: a consumer-project #251 V0.15.7-close incident — silent false-positive close-verdicts from echo-stub test commands).

### 2.1 Vault Validation (if configured)

Read `skills/session-end/vault-operations.md` for validator bash contract and reporting matrix.

### 2.2 CLAUDE.md (or AGENTS.md) Drift Check (if configured)

Read `skills/session-end/drift-operations.md` for checker bash contract and reporting matrix. Complements 2.1: vault-sync validates frontmatter inside the vault tree; drift-check validates narrative claims (paths, counts, issue refs, session-file refs) in top-level repo docs.

### 2.3 Vault Staleness Check (if configured)

> Skip this subsection if `vault-staleness.enabled` is not `true` (default: `false`).

#### Step 1 — Resolve mode

Read `vault-staleness.mode` from `$CONFIG` (default: `warn`). Valid values: `off | warn | strict`.

If `mode === 'off'`, skip Phase 2.3 entirely.

#### Step 2 — Invoke staleness probes

Both probes already ship in the plugin's `skills/discovery/probes/`. Invoke each via Node import (no shell-out). Import from the **plugin** root `${PLUGIN_ROOT}` (resolution chain: `skills/_shared/config-reading.md`), never from the project root — in a consumer repo the project has no `skills/` directory. `projectRoot` stays the project root the probes scan:

```js
import { runProbe as runStaleness } from '${PLUGIN_ROOT}/skills/discovery/probes/vault-staleness.mjs';
import { runProbe as runNarrative }  from '${PLUGIN_ROOT}/skills/discovery/probes/vault-narrative-staleness.mjs';

const projectStaleness = await runStaleness(projectRoot, config);
const narrativeStaleness = await runNarrative(projectRoot, config);
```

Each probe returns `{ findings: Array, metrics: Object, duration_ms: Number }` and auto-appends a JSONL summary record to its respective metrics file.

#### Step 3 — Aggregate and route by mode

```
totalFindings = projectStaleness.findings.length + narrativeStaleness.findings.length
```

- `mode === 'warn'` (default): report findings to closing report Docs Health line. Never block close.
- `mode === 'strict'`:
  - If `totalFindings === 0`: continue, log `Vault staleness: clean (mode=strict)`.
  - If `totalFindings > 0`: do NOT block the close. Present the findings list and surface an AskUserQuestion whose Recommended default is **warn + carryover + continue**:
    - On Claude Code: AskUserQuestion with options:
      1. "Warn + carryover and close (Recommended)" — file a carryover issue (labels `carryover`, `priority::high`) titled `[Carryover] Vault staleness (strict) — <count> findings` documenting the stale projects/narratives for a follow-up session, log a Deviation entry in STATE.md `## Deviations`, then continue the close:
         `- [<ISO timestamp>] Phase 2.3: Vault staleness strict-mode findings carried over. Findings: <count> (projects: <N>, narratives: <M>) → issue #<IID>.`
      2. "Override and close" — proceed without a carryover issue, log a Deviation entry in STATE.md `## Deviations`:
         `- [<ISO timestamp>] Phase 2.3: Vault staleness strict-mode findings overridden by user. Findings: <count> (projects: <N>, narratives: <M>).`
         In addition to the Deviation entry, emit an override-ratio event so the override feeds the `override_ratio` metric (#730/H5): `node scripts/emit-event.mjs --type orchestrator.finding.overridden --payload '{"phase":"2.3","kind":"vault-staleness-strict","count":N}'`.
    - On Codex CLI / Cursor IDE: same options as numbered Markdown list.

#### Step 4 — Surface to closing report

Pass the aggregated counts and mode forward to Phase 6 Final Report (Docs Health line — see Phase 6 below).

### 2.4 Security-Delta (#1769)

> Opt-in. Read `security-delta.mode` from `$CONFIG` (parser `scripts/lib/config/security-delta.mjs`, default `off`). If the block is absent or `mode === 'off'`, skip Phase 2.4 silently.

Checks only what THIS session changed: lockfile deltas against OSV (private scopes are never sent), Node security floors, floating image tags, a gitleaks finding count, and the package-manager age-gate setting. Also never sent: packages behind a non-npmjs bare `registry=` (root or lockfile-adjacent `.npmrc`), requirements files with a non-PyPI `--index-url` / `--extra-index-url` / `-f` / `--find-links`, and non-registry pnpm/uv sources (file, link, git, directory); unparsed or unpinned entries make the lockfile check `degraded` with `unchecked`. Ceiling: `-r` includes, `PIP_INDEX_URL` and `pip.conf` are not read (follow-up). Budget 3000 ms total, 2000 ms network; a check that cannot finish fails open as `degraded`. Full contract: `docs/session-config-reference.md` § Security-Delta.

#### Step 1 — Resolve the range

Use the canonical accessor in [`plan-verification.md`](../plan-verification.md) § SESSION_START_REF accessor and pass `"$SESSION_RANGE"` as ONE complete range — never compose `<ref>..HEAD` by hand. The accessor's unpinned fallback `<base>...HEAD` is accepted: the CLI resolves it to `<git merge-base base HEAD>..HEAD` (a failing merge-base exits `1`). If the accessor leaves `$SESSION_RANGE` empty (it prints `SESSION_RANGE skipped: <reason>` on stderr), skip Phase 2.4 and record `Security-Delta: skipped (<reason>)` for the Session Summary.

#### Step 2 — Run the CLI

```bash
SD_JSON=$(node "${PLUGIN_ROOT}/scripts/security-delta.mjs" --range "$SESSION_RANGE" --json)
SD_EXIT=$?
```

The CLI reads `security-delta.mode` itself. Exit `0` = pass, warn, degraded or skipped; `3` = strict block; `1` = usage error. stdout is ONE JSON line `{ schema, mode, range, status, verdict, checks[], totals, ms }` with `status ∈ clean|findings|degraded|skipped` and `verdict ∈ pass|warn|block`.

#### Step 3 — Route on the JSON

- **Missing or unparseable stdout, or exit `1`:** treat as `degraded` and report `Security-Delta: degraded (no readable result, exit <SD_EXIT>)`. Never report it as clean.
- **`status: degraded`:** report it with its denominator — how many checks stayed unchecked out of how many were planned (from `totals`). A degraded run is never folded into a pass line.
- **`verdict: pass`:** one line in the Session Summary — `Security-Delta: <status> (mode=<mode>, <counts from totals>, <ms> ms)`.
- **Verdict basis:** only findings the range introduced (`introduced: true`) move the verdict. Pre-existing findings stay in `checks[].findings` and `totals` but alone give `pass`. A version range in `engines.node` (`>=24.0.0`, `^22.1.0`, …) is not a pin and is never compared to the floor; the two image checks (runtime floor, floating tags) skip files under `fixtures/`, `__fixtures__/`, `testdata/` or `test-fixtures/`. A lockfile whose age gate was already missing at the range base is listed as `age-gate-missing` with `introduced: false` and passes; only a gate removed in the range, or a new lockfile without one, is introduced.
- **`verdict: warn`:** list every finding in the Session Summary — fingerprint, class, severity, package or file, `fixedIn` — and offer each as a carryover candidate (Phase 1.65 candidate record format). Never block the close.
- **`verdict: block` (exit `3`, `mode: strict` only):** `strict` blocks only on an introduced malicious package or an introduced critical vulnerability that has a known fix. Present the blocking findings and ask:
  - On Claude Code: AskUserQuestion (header `Sicherheit`) with options:
    1. "Fix and retry (Recommended)" — the session itself introduced a malicious package or a fixable critical vulnerability; costs one more fix cycle; the close exits now without writing, and Phase 2.4 runs again on the next `/close`.
    2. "Warn + carryover and close" — for when the fix needs work outside this session; costs a `priority::high` issue while the finding ships; files a carryover issue (labels `carryover`, `priority::high`) titled `[Carryover] Security-Delta (strict) — <count> blocking findings` with the fingerprints, logs a Deviation entry in STATE.md `## Deviations`, then continues the close.
    3. "Override and close" — only for a confirmed false positive; costs the protection for this close and is counted as an override; proceeds and logs a Deviation entry in STATE.md `## Deviations`:
       `- [<ISO timestamp>] Phase 2.4: Security-Delta strict block overridden by user. Findings: <count> (<fingerprints>).`
       In addition to the Deviation entry, emit an override-ratio event so the override feeds the `override_ratio` metric (#730/H5): `node scripts/emit-event.mjs --type orchestrator.finding.overridden --payload '{"phase":"2.4","kind":"security-delta-strict","count":N}'`.
    4. "Abort close" — for when the session should not end on this state; costs nothing but leaves the work uncommitted; exits the close without writing anything.
  - On Codex CLI / Cursor IDE: same options as a numbered Markdown list.
  - Headless `claude -p`, embedded/autopilot and Lead-led runs cannot ask (`AskUserQuestion` is unavailable per `.claude/rules/ask-via-tool.md` AUQ-004 — same detection as the Phase 1.65 fail-open skip in `plan-verification.md`). Unlike that gate, a security block does NOT fail open: report the blocking findings and stop the close without writing.

#### Step 4 — Surface to closing report

Pass `(mode, status, verdict, totals, findings)` forward to the Phase 6 Session Summary. The CLI emits `orchestrator.security.delta` itself, carrying counts only — never package names, paths or secrets.

