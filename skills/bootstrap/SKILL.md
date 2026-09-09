---
name: bootstrap
user-invocable: true
tags: [bootstrap, setup, scaffold, init]
model: sonnet
model-preference: sonnet
model-preference-codex: gpt-5.4-mini
model-preference-cursor: claude-sonnet-4-6
description: >
  Use this skill when scaffolding the minimum repository structure required by session-orchestrator.
  Invoked automatically by the Bootstrap Gate when CLAUDE.md, Session Config,
  or bootstrap.lock is missing. Also available as /bootstrap for manual invocation.
  Three intensity tiers: fast (demos/spikes), standard (MVPs), deep (production/team).
---

# Bootstrap Skill

## Overview

This skill runs when the Bootstrap Gate is closed (missing CLAUDE.md, Session Config, or `.orchestrator/bootstrap.lock`) or when the user invokes `/bootstrap` directly. It scaffolds the minimum structure required by all session-orchestrator skills, commits it, and writes the lock file that opens the gate for all future invocations.

**Anti-bureaucracy contract:** On a first-time full bootstrap (no tier flags, no `--no-interview`), expect **7–9** `AskUserQuestion` prompts in three fixed blocks — not an open-ended wizard. (1) **Tier/stack** (Phase 2): one tier-confirmation question, plus an optional second archetype question when `PATH_TYPE = public` and archetype confidence is low (Standard/Deep only). (2) **Owner persona** (Phase 3.5): five questions from `scripts/lib/owner-interview.mjs` (first-run only). (3) **Dispatcher autonomy** (Phase 3.5.1): one question from `scripts/lib/config/dispatcher-autonomy-capture.mjs`. Flagged flows (`--upgrade`, `--retroactive`, `--sync-rules`, `--ecosystem-health`) and `--no-interview` skip some or all of these blocks.

## Invocation Context

Before starting, determine how this skill was invoked:

- **Transitive (gate-closed):** Invoked from another skill's Phase 0. The user's original intent (their first prompt) is available in context. After bootstrap completes, execution must return to the original skill's Phase 1.
- **Direct (`/bootstrap`):** User invoked manually. Parse `$ARGUMENTS` for flags: `--fast`, `--standard`, `--deep`, `--upgrade <tier>`, `--retroactive`. See `commands/bootstrap.md` for flag semantics.

Store `INVOCATION_MODE = transitive | direct`.

**Mode dispatch (direct invocation only):**
- If `--upgrade <tier>` is present in `$ARGUMENTS`: jump to **Upgrade Flow** section. Do not proceed to Phase 1.
- If `--retroactive` is present in `$ARGUMENTS`: jump to **Retroactive Flow** section. Do not proceed to Phase 1.
- If `--refresh-lock` is present in `$ARGUMENTS`: jump to **Refresh-Lock Flow** section. Do not proceed to Phase 1.
- If `--sync-rules` is present in `$ARGUMENTS`: jump to **Sync-Rules Flow** section. Do not proceed to Phase 1.
- If `--ecosystem-health` is present in `$ARGUMENTS`: jump to **Ecosystem-Health Flow** section. Do not proceed to Phase 1.
- Otherwise: continue to Phase 1 below.

## Phase 0.5: Determine Private vs. Public Path

**Before dispatching to any tier template**, read `skills/bootstrap/public-fallback.md` and execute Step 1 (PATH_TYPE detection). Store the result as `PATH_TYPE = private | public`. This detection is silent — no user interaction.

- `private`: the existing host-local config resolution found a baseline directory and its reduced contract validated. Use `private-contract.md` for selection, templates, commands, CI and rules.
- `public`: the resolved baseline is absent, empty, or points to a missing directory. Use plugin-bundled templates.
- Existing but invalid configured baseline: abort before dispatch; report the reader's sanitized error reason.

Pass `PATH_TYPE` into Phase 1 and all subsequent phases. All tier templates (`fast-template.md`, `standard-template.md`, `deep-template.md`) must consult `public-fallback.md` for CLAUDE.md generation and archetype file sourcing when `PATH_TYPE = public`.

## Phase 1: Detect Tier + Archetype

Read `skills/bootstrap/intensity-heuristic.md` and execute the tier + archetype recommendation algorithm.

Inputs to the heuristic:
1. **User's first prompt** — the message that triggered this skill (most important signal)
2. **Repo name** — `basename $(git rev-parse --show-toplevel)` (secondary signal)
3. **Existing files** — `ls -la` of repo root (presence of `package.json`, `pyproject.toml`, etc. shifts archetype)
4. **$ARGUMENTS flags** — if `--fast`, `--standard`, or `--deep` is present, skip heuristic and use the specified tier directly

Output from Phase 1:
- `RECOMMENDED_TIER` = `fast` | `standard` | `deep`
- `RECOMMENDED_ARCHETYPE` = validated private contract ID, public ID, or `null`
- `HEURISTIC_REASON` = one-sentence explanation of why this tier was chosen (shown to user)
- `PATH_TYPE` = `private` (plan-baseline-path configured and path exists) | `public` (no baseline)

**Detecting PATH_TYPE:** Already determined in Phase 0.5 — use the stored `PATH_TYPE` value. Do not re-run detection.

**Fast tier:** `RECOMMENDED_ARCHETYPE` is always `null`. No stack selection needed.

## Phase 2: Present Tier Confirmation (One Question)

Present exactly one `AskUserQuestion` unless:
- `$ARGUMENTS` includes `--fast`, `--standard`, or `--deep` (tier pre-selected, skip question)
- `--retroactive` flag (no scaffolding at all, skip to Phase 4)

```
AskUserQuestion({
  questions: [{
    question: "Leeres Repo erkannt. Basierend auf '<HEURISTIC_REASON>' empfehle ich **<RECOMMENDED_TIER>**. Passt das?",
    header: "Bootstrap",
    options: [
      { label: "fast", description: "Nur CLAUDE.md + .gitignore + README. Für Demos, Spikes, Playgrounds." },
      { label: "standard", description: "Fast + package.json/Manifest + TypeScript + Linting + Tests. Für MVPs und echte Produkte." },
      { label: "deep", description: "Standard + CI + CODEOWNERS + CHANGELOG. Für Production, Team, Langlebige Repos." },
      { label: "Abbrechen", description: "Bootstrap abbrechen. Das ursprüngliche Kommando wird ebenfalls abgebrochen." }
    ],
    multiSelect: false
  }]
})
```

Before rendering: append ` (Empfohlen)` to whichever of the three tier labels equals `<RECOMMENDED_TIER>`, and move that option to position 1. The recommended tier is one of the three — listing it a fourth time as its own option made five options, one more than `AskUserQuestion` accepts, and repeated the same choice twice.

If user selects "Abbrechen": stop. Report "Bootstrap abgebrochen. Kein Kommando wird ausgeführt." Do not continue.

Store confirmed tier as `CONFIRMED_TIER`.

### Optional Second Question (Public Path + Standard/Deep + Ambiguous Archetype Only)

If ALL of the following are true:
1. `PATH_TYPE = public`
2. `CONFIRMED_TIER` is `standard` or `deep`
3. `intensity-heuristic.md` returned `ARCHETYPE_CONFIDENCE = low` (truly ambiguous)

Then ask one more question — and only then:

```
AskUserQuestion({
  questions: [{
    question: "Welchen Tech-Stack soll ich für das Grundgerüst verwenden?",
    header: "Archetype",
    options: [
      { label: "node-minimal", description: "package.json + TypeScript + Vitest. Für CLIs, Tools, Libraries." },
      { label: "nextjs-minimal", description: "Next.js bare setup. Für Web Apps, SaaS, Fullstack." },
      { label: "static-html", description: "HTML/CSS/JS, kein Build-Step. Für Animationen, Landingpages, Visualisierungen." },
      { label: "python-uv", description: "pyproject.toml + uv + pytest. Für Python Scripts, APIs, ML." }
    ],
    multiSelect: false
  }]
})
```

Store as `CONFIRMED_ARCHETYPE`.

For `PATH_TYPE = private` and Standard/Deep, execute `private-contract.md`'s
Select section now. Reuse a valid detected or explicit ID; when evidence is
insufficient, select from the returned catalog before scaffolding. Tier flags
skip tier confirmation, not required private archetype selection. Never pass a
null private ID into the public default. On upgrades, validate the lock's ID
against the currently configured contract before generating any files.

The tier/stack block contributes **1–2** questions; a first-run full bootstrap adds **6 more** from the owner interview (Phase 3.5, five questions) and dispatcher-autonomy capture (Phase 3.5.1, one question) — **7–9 total**.

## Upgrade Flow (`--upgrade <tier>`)

Entered when `$ARGUMENTS` contains `--upgrade <tier>`. No scaffolding questions are asked.

**Steps:**

1. **Read existing lock.** Read `.orchestrator/bootstrap.lock`. If missing, abort with: `Error: No bootstrap.lock found. Run /bootstrap first to bootstrap this repo.`

2. **Parse current and target tier.**
   - `CURRENT_TIER` = value of `tier:` field in the lock file.
   - `TARGET_TIER` = the `<tier>` argument supplied after `--upgrade`.
   - Valid values for both: `fast` | `standard` | `deep`.

3. **Refuse downgrade.** Tier order: `fast < standard < deep`. If `TARGET_TIER` ranks lower than or equal to `CURRENT_TIER`, abort with:
   `Error: Cannot downgrade from <CURRENT_TIER> to <TARGET_TIER>. Upgrade path is one-directional (fast → standard → deep).`
   Exit non-zero.

4. **Resolve source and compute delta.** Run Phase 0.5's read-only source
   detection before dispatching any template. For a private contract, validate
   the lock's archetype with `--archetype`; if the Fast lock has no archetype,
   select from the returned catalog using `private-contract.md`. Use its staged,
   additive scaffold and CI expectations; do not apply the public file matrix.
   For the public path, determine which files the target tier adds:
   - `fast → standard`: all Standard-tier files (`package.json`/`pyproject.toml`, `tsconfig.json`, `eslint.config.mjs`, `.prettierrc`, `.editorconfig`, `tests/`, `src/`)
   - `standard → deep`: all Deep-tier files (CI pipeline, `CODEOWNERS`, `CHANGELOG.md`, issue templates, MR/PR template, branch protection)
   - `fast → deep`: union of both deltas (apply Standard first, then Deep)

5. **Check idempotency.** For each file in the delta, skip if it already exists on disk. Only write files that are absent. This makes the operation safe to run twice.

6. **Apply delta files.** Execute only the relevant template steps for the missing files. Read the appropriate template (`standard-template.md` and/or `deep-template.md`) and execute ONLY the steps that produce the delta files. Do NOT re-run already-completed steps.

7. **Update bootstrap.lock atomically.** Overwrite `.orchestrator/bootstrap.lock` with `tier: <TARGET_TIER>`. Preserve a validated existing `archetype`; when upgrading a null Fast archetype, record the newly confirmed ID and scaffold source. Update `timestamp` to now. Preserve the prior `source` otherwise. Write `plugin-version` from `$PLUGIN_ROOT/package.json` (current plugin version at upgrade time).

8. **Commit.** Stage only the delta files that were just written and commit:
   ```bash
   # DELTA_FILES must be populated with the explicit list of files written in step 6
   for _f in "${DELTA_FILES[@]}"; do
     [[ -e "$_f" ]] && git add -- "$_f"
   done
   git commit -m "chore: bootstrap upgrade to <TARGET_TIER>"
   ```

9. **Report.** Print a one-line summary: `Bootstrap upgraded from <CURRENT_TIER> to <TARGET_TIER>. <N> files added.`

---

## Retroactive Flow (`--retroactive`)

Adopts an existing repo that already has `CLAUDE.md`/`AGENTS.md` + `## Session Config` but no `bootstrap.lock` — infers tier from file inventory and patches missing mandatory Session Config fields with defaults.

See [references/bootstrap-retroactive-flow.md](references/bootstrap-retroactive-flow.md).

**Read WHEN:** `$ARGUMENTS` contains `--retroactive`.

---

## Refresh-Lock Flow (`--refresh-lock`)

Acknowledges the current plugin version and resets the freshness clock on an already-valid `bootstrap.lock` (`refreshed-at` + `refreshed-plugin-version`) without disturbing its original bootstrap provenance or re-running scaffolding.

See [references/bootstrap-refresh-lock-flow.md](references/bootstrap-refresh-lock-flow.md).

**Read WHEN:** `$ARGUMENTS` contains `--refresh-lock`.

---

## Sync-Rules Flow (`--sync-rules`)

Entered when `$ARGUMENTS` contains `--sync-rules`. This standalone flow skips tier
selection, scaffolding and initial commit. Rule selection may read the lock ID.

**Purpose:** Vendor canonical rules from the plugin's `rules/` library (`rules/always-on/*.md`, and in the future `rules/opt-in-stack/*.md` and `rules/opt-in-domain/*.md`) into the consumer repo's `.claude/rules/`. Plugin-sourced files (identified by a `<!-- source: session-orchestrator plugin … -->` header) are overwritten on re-run; files without that header are preserved as local overrides. See `rules/_index.md` for the canonical manifest and `scripts/lib/rules-sync.mjs` for the implementation.

**Steps:**

1. **Resolve plugin root.** The plugin's `rules/_index.md` lives next to `SKILL.md`'s plugin directory. Use the plugin root inferred by the harness (`PLUGIN_ROOT`).

2. **Invoke the bootstrap rule action.** It reloads a configured private contract
   and supplies required plugin basenames to `scripts/lib/rules-sync.mjs`.
   With no baseline, the writer's public/default behavior is unchanged. Map an
   explicit `--archetype ID` to `CONFIRMED_ARCHETYPE`, `--dry-run` to
   `DRY_RUN=true`, and optional category selections to comma-separated
   `RULES_CATEGORIES`; otherwise leave those variables unset. Run from the repo:

   ```bash
   export PLUGIN_ROOT CONFIRMED_ARCHETYPE DRY_RUN RULES_CATEGORIES
   node --input-type=module <<'NODE'
   import { pathToFileURL } from 'node:url';
   const { syncBootstrapRules } = await import(pathToFileURL(`${process.env.PLUGIN_ROOT}/scripts/lib/baseline-archetypes.mjs`));
   const categories = (process.env.RULES_CATEGORIES || '').split(',').map(value => value.trim()).filter(Boolean);
   const result = await syncBootstrapRules({ repoRoot: process.cwd(), archetype: process.env.CONFIRMED_ARCHETYPE || undefined,
     dryRun: process.env.DRY_RUN === 'true', categories: categories.length ? categories : null });
   process.stdout.write(`${JSON.stringify(result)}\n`);
   if (result.status === 'error') process.exitCode = 2;
   NODE
   ```

   The canonical writer reads all selected categories in `rules/_index.md` and
   writes into `.claude/rules/`. Required private targets remain subject to its
   provenance and pre-write checks. Explicit ID takes precedence over lock ID,
   then repository markers. Invalid private contracts abort before writes.
   A valid Fast lock with `archetype: null` and no matching markers retains
   ordinary plugin rule delivery after contract validation.
   Stdout includes `status`, `created[]`, `written[]`, `skipped[]`, `preserved[]`,
   and `errors[]`. Any error exits non-zero.

   Add `--dry-run` to preview without writing.

3. **Interpret the output.** Report a human summary:
   - `written`: files newly created OR plugin-owned files overwritten with fresh canonical content.
   - `skipped`: plugin-owned files already up-to-date (byte-identical).
   - `preserved`: existing `.claude/rules/*.md` files that do NOT carry the plugin source header — left untouched as local overrides.
   - `errors`: per-file failures (missing source, read/write errors, malformed `_index.md`).

4. **Commit (optional).** `--sync-rules` does not auto-commit. If rules changed, prompt the user to review `git status` and stage/commit the updates manually. Rationale: rules are canonical artifacts and should travel with an intentional review, not land silently.

5. **Report.** Print: `rules-sync complete. Written: <N>. Skipped: <N>. Preserved: <N>. Warnings: <N>. Errors: <N>.` `warnings[]` carries WARN-severity validation findings (e.g. zero-match-globs, foreign-glob) surfaced by `validateRuleContent` — these do NOT block the write; they are informational only. If `errors > 0`, non-zero exit.

**Local overrides.** Any `.claude/rules/<name>.md` without the plugin source header is considered local and never overwritten. To replace a local override with the canonical version, delete it before re-running.

**Idempotency.** Running `/bootstrap --sync-rules` twice in a row with no upstream changes emits `written: 0, skipped: <N>`. Safe to wire into CI or scheduled maintenance.

---

## Phase 3: Dispatch to Template

Based on `CONFIRMED_TIER`, read and execute the corresponding template file:

| Tier | Template File |
|------|--------------|
| `fast` | `skills/bootstrap/fast-template.md` |
| `standard` | `skills/bootstrap/standard-template.md` |
| `deep` | `skills/bootstrap/deep-template.md` |

Pass the following context into the template execution:
- `CONFIRMED_TIER`
- `CONFIRMED_ARCHETYPE`
- `PATH_TYPE`
- `REPO_ROOT` = `$(git rev-parse --show-toplevel)`
- `REPO_NAME` = `$(basename "$REPO_ROOT")`
- `PLATFORM` = detected platform from `skills/_shared/platform-tools.md`

Follow the template's instructions precisely. The template is responsible for creating all files and the initial git commit.

**Platform note for CLAUDE.md generation:**
When `PATH_TYPE = public`, read `skills/bootstrap/public-fallback.md` for the full platform-specific CLAUDE.md generation logic (claude init path for Claude Code; `_minimal` template synthesis for Codex/Cursor). When `PATH_TYPE = private`, use the validated, staged flow in `private-contract.md`.

## Phase 3.4: Vault-Registration Prompt (#190)

Standard and Deep tier templates include Step 5.5 (standard) / D6.6 (deep) which runs `scripts/lib/product-repo-detect.mjs` to check for product-repo signals (framework dep, content dir, product env vars). When signals are detected and no `vault:` key exists in Session Config, the template prompts the user to register a vault entry. Idempotency via `hasVaultConfig`. Fast tier skips this step.

## Phase 3.5: Owner Persona Interview (first-run only)

> Closes session-orchestrator issues #175 (D2 owner interview) + #173 (C4 hardware-sharing consent).

**WHEN:** Runs after Phase 3.4 when `~/.config/session-orchestrator/owner.yaml` is absent AND `--no-interview` was NOT passed. Skipped entirely on `--upgrade`, `--retroactive`, `--sync-rules`, and `--ecosystem-health` flows.

**WHAT:** The coordinator dispatches 5 `AskUserQuestion` calls using definitions from `scripts/lib/owner-interview.mjs`:

1. **Language** — `de` | `en` | other (free text)
2. **Tone style** — `direct` (recommended) | `neutral` | `friendly`
3. **Output level** — `lite` (verbose) | `full` (default) | `ultra` (telegraphic)
4. **Preamble** — `minimal` (one-line updates) | `verbose` (explain before action)
5. **Hardware-sharing consent (C4)** — `No` (default) | `Yes` (generates random `hash-salt`) | `Preview`

**HOW (coordinator steps):**

```js
import { runOwnerInterview, getInterviewQuestions, applyInterviewAnswers } from '$PLUGIN_ROOT/scripts/lib/owner-interview.mjs';
const probe = runOwnerInterview({ skipIfExists: true });
if (probe.status === 'pending') {
  // dispatch AskUserQuestion for each of probe.questions, collect answers[]
  const result = applyInterviewAnswers(answers, { path: probe.path });
  // result: { ok, path, errors }
}
```

**WHERE:** Written to `~/.config/session-orchestrator/owner.yaml` (user-global, never committed).

**RE-TRIGGER:** `/bootstrap --owner-reset` sets `force: true` in `runOwnerInterview`, archives the existing yaml to `owner.yaml.bak-<timestamp>`, and re-runs the 5 questions.

## Phase 3.5.1: Dispatcher-Autonomy Capture (one-time, per-repo)

> Closes session-orchestrator issue #681 (Epic #673 P3 — one-time per-repo dispatcher-autonomy capture). Cross-reference `.claude/rules/ask-via-tool.md` (AUQ via tool, not prose).

**WHEN:** Runs after Phase 3.5 (Owner Persona Interview) and after the tier template has scaffolded `CLAUDE.md` (Phase 3 / Phase 3.3). A new project's CLAUDE.md never contains the committed `dispatcher-autonomy:` block, so bootstrap **always asks** — the presence guard below is belt-and-suspenders for re-runs.

**WHY (one-time guard):** The committed `## Dispatcher Autonomy` block is the never-re-ask marker. Detect "block absent" via `isDispatcherAutonomyBlockPresent($CLAUDE_MD_CONTENT)` — a raw `/^dispatcher-autonomy:\s*$/m` presence check on the file content. Do NOT use the resolved autonomy value from `$CONFIG` (it returns `'off'` for BOTH "absent" AND "present-with-off" and cannot distinguish first-run from a deliberate `off`).

> **The guard is gated purely on committed-block PRESENCE, never on the resolved value.** A machine whose effective autonomy differs from the committed default — because `SO_DISPATCHER_AUTONOMY` or `owner.yaml` `dispatcher.autonomy` overrides it — STILL counts as "captured" the moment the committed block exists, and is never re-asked. Conversely a host with `owner.yaml` `dispatcher.autonomy` set but NO committed block is still asked once: a host-local override does NOT satisfy the migration guard; only the committed CLAUDE.md / AGENTS.md block does. Even a header-present-but-body-malformed block counts as PRESENT (a malformed block is the operator's to fix, not a re-prompt trigger).

**WHAT:** The coordinator dispatches ONE `AskUserQuestion` using the definition from `scripts/lib/config/dispatcher-autonomy-capture.mjs`:

- **Dispatcher autonomy** — `off` (Recommended, fail-closed) | `advisory` | `autonomous-gated`

On **any** answer (including `off`) the committed block is written, presented, and never re-asked. The writer persists ONLY the committed default — host-local overrides (`SO_DISPATCHER_AUTONOMY` env, `owner.yaml` `dispatcher.autonomy`) stay host-local and NEVER land in CLAUDE.md.

> **Capture writes the committed default; the runtime value flows through `resolveDispatcherAutonomy`.** This phase only persists the operator's one-time choice as the committed baseline. The EFFECTIVE autonomy at run time is resolved separately by `resolveDispatcherAutonomy()` in `scripts/lib/config/dispatcher-autonomy.mjs` with host-local precedence `SO_DISPATCHER_AUTONOMY` env > `owner.yaml` `dispatcher.autonomy` > committed > `off` (#653 pattern). Capture never reads or writes those override tiers — it writes the committed tier only.

**AUQ (mandatory — use the tool, not prose):** On Claude Code / Cursor IDE, dispatch this via the **`AskUserQuestion` tool** per `.claude/rules/ask-via-tool.md` (AUQ-001) — never an inline markdown "choose 1/2/3" list. Option 1 (`off`) is the recommended, fail-closed default. Only Codex CLI (no `AskUserQuestion`) falls back to a numbered-list prose prompt (AUQ-004 exception 1).

**HOW (coordinator steps):**

```js
import {
  getDispatcherAutonomyQuestion,
  isDispatcherAutonomyBlockPresent,
  writeDispatcherAutonomyBlock,
} from '$PLUGIN_ROOT/scripts/lib/config/dispatcher-autonomy-capture.mjs';
import { readFileSync } from 'node:fs';

const claudeMdPath = `${REPO_ROOT}/CLAUDE.md`;
const content = readFileSync(claudeMdPath, 'utf8');
if (!isDispatcherAutonomyBlockPresent(content)) {
  const q = getDispatcherAutonomyQuestion(); // option 1 = 'off' (Recommended, fail-closed)
  // Claude Code / Cursor: dispatch AskUserQuestion([q]) (the TOOL — AUQ-001); collect the
  //   selected label (the `autonomy` enum). Never an inline numbered-list prose question here.
  // Codex CLI fallback only (no AskUserQuestion — AUQ-004 exception 1): print q.question +
  //   numbered q.options list, read the operator's pick, map it to the option label.
  const autonomy = /* selected option label: 'off' | 'advisory' | 'autonomous-gated' */;
  const result = writeDispatcherAutonomyBlock({ claudeMdPath, autonomy });
  // result: { written: true, path } on first write; { written: false, reason: 'already-present' }
  //   on no-op (block — even a malformed one — already present; defensive double-write guard).
}
```

**WHERE:** Appended as a standalone `## Dispatcher Autonomy` H2 in the repo's committed `CLAUDE.md` (NOT a key inside `## Session Config` — the standalone-H2 placement keeps `claude-md-drift-check` Check-6 parity green).

## Phase 3.6: (Optional) Rules-Fetch Bridge

Pulls canonical `.claude/rules/*.md` from the configured baseline GitLab project on the public path (or applies the private contract's local rule union), writes `.claude/.baseline-fetch.lock`, and falls back to the legacy Clank sync flow on any fetch failure.

See [references/bootstrap-rules-fetch-bridge.md](references/bootstrap-rules-fetch-bridge.md).

**Read WHEN:** Phase 3 (Dispatch to Template) reaches step S99/D99, or when investigating `.claude/.baseline-fetch.lock` contents.

---

## Ecosystem-Health Flow (`--ecosystem-health`)

A **standalone flow** — does not scaffold repo structure or write `bootstrap.lock`. Walks the ecosystem-health wizard and writes `.orchestrator/policy/ecosystem.json`.

See [references/bootstrap-ecosystem-health-flow.md](references/bootstrap-ecosystem-health-flow.md).

**Read WHEN:** `$ARGUMENTS` contains `--ecosystem-health`.

---

## Phase 4: Write bootstrap.lock

After all template files are written and committed, write `.orchestrator/bootstrap.lock` (and, if the rules-fetch bridge ran, also `.claude/.baseline-fetch.lock` — see Phase 3.6):

```yaml
# .orchestrator/bootstrap.lock
version: 1
tier: <CONFIRMED_TIER>
archetype: <CONFIRMED_ARCHETYPE or null>
timestamp: <current ISO 8601 UTC timestamp>
source: <projects-baseline | plugin-template | claude-init>
plugin-version: <current plugin version from package.json>
```

Determine `source`:
- `projects-baseline` if `PATH_TYPE = private` and baseline scripts were used
- `claude-init` if `claude init` was used successfully on Claude Code
- `plugin-template` otherwise

Read `plugin-version` from the session-orchestrator plugin's `package.json` (`$PLUGIN_ROOT/package.json`, field `version`). This enables the freshness probe (#290) to detect plugin upgrades that need re-bootstrap. Example:

```bash
PLUGIN_VERSION="$(node -e "const p=require('$PLUGIN_ROOT/package.json');console.log(p.version);" 2>/dev/null || node --input-type=module -e "import pkg from '$PLUGIN_ROOT/package.json' assert {type:'json'}; console.log(pkg.version);")"
```

The template's initial git commit includes `bootstrap.lock`. If the template already wrote the lock file (as `fast-template.md` does), skip this step — the lock is already committed.

> Deep tier note: if Step D5.5 (GitHub Mirror Remote) added a `github` remote earlier in this run, it is committed alongside `bootstrap.lock` here — no separate commit is needed for the remote itself (remotes are local git config, not tracked files).

## Phase 4.5: Instruction-Budget Baseline

Non-blocking, informational — never gates Phase 5. Runs two probes against the just-scaffolded instruction file and folds both results into the Phase 5 summary:

1. **Directive-count baseline.** Call `checkInstructionBudget({ repoRoot: REPO_ROOT })` from `scripts/lib/instruction-budget-guard.mjs`. It returns a banner string or `null`. On a fresh scaffold there is no `.claude/rules/` directory yet, so this returns `null`/empty — expected, not an error. The probe becomes meaningful only after `--sync-rules` populates `.claude/rules/`.
2. **Raw-file budget lint.** Run the same lint Step 2c of `fast-template.md` already ran once (idempotent to re-run here for tiers that skip Step 2c, e.g. Standard/Deep archetype copies that don't go through the Fast-tier CLAUDE.md path):

   ```bash
   node "$PLUGIN_ROOT/scripts/lib/claude-md-budget-lint.mjs" --repo-root "$REPO_ROOT" --require-provenance --mode warn --json
   ```

Fold both results into one line for the Phase 5 report, e.g. `Instruction budget: n/a (no .claude/rules/ yet). Budget lint: ok.` or `Budget lint: 1 violation (max-lines).` Never block or retry — this phase informs only.

## Phase 5: Resume

Report bootstrap completion with a one-line summary:

```
Bootstrap complete (tier: <tier>, archetype: <archetype or "none">). Resuming <original command>…
```

If invoked transitively: return control to the originating skill. The original skill resumes from its Phase 1.
If invoked directly via `/bootstrap`: report the created files list and stop.

## Critical Rules

- **NEVER create application code during bootstrap** — only structural files (CLAUDE.md, .gitignore, README.md, manifests, CI). The feature that follows brings its own implementation.
- **NEVER skip the lock file write** — `.orchestrator/bootstrap.lock` is the gate's mechanical truth. Bootstrap without a lock file is incomplete.
- **Fixed question budget, no ad-hoc prompts** — tier/stack (1–2), owner interview (5, Phase 3.5), dispatcher-autonomy capture (1, Phase 3.5.1) sum to **7–9** on a first-run full bootstrap; `--no-interview` and flag short-circuits reduce this. Make a best-effort tier recommendation and let the user correct via `/bootstrap --upgrade` later — do not add prompts beyond these blocks.
- **ALWAYS commit** — bootstrap ends with a git commit. The lock file is part of that commit.
- **ALWAYS check for retroactive flag** — if `--retroactive` is in `$ARGUMENTS`, skip all scaffolding and jump directly to writing `bootstrap.lock` (tier inferred from existing file inventory, fallback: `fast`).
- **NEVER abort bootstrap on rules-fetch failure** — rules-fetch is opt-in and best-effort. The legacy Clank sync path is the safety net.
- **Repos that mirror to GitHub SHOULD get the `github` remote added at bootstrap time** — Deep tier's Step D5.5 (`skills/bootstrap/deep-template.md`) wires this in for GitLab-primary repos (or any repo with `mirror: github` in Session Config), so mirror-push at session-end (§4.4) and mirror-drift auditing (repo-audit's `github-mirror-sync` check, `scripts/lib/harness-audit/categories/category6.mjs`, Category 6) both have a remote to work against from day one, rather than discovering the gap later.
