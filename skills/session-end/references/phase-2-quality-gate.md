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

