# Session Config Reference

> Canonical field reference for Session Config. All skills reference this file instead of maintaining inline copies.
> Users: see `docs/USER-GUIDE.md` Section 4 for examples and usage guidance.

## Config File Location

- **Claude Code**: Add `## Session Config` to your project's `CLAUDE.md`
- **Codex**: Add `## Session Config` to your project's `AGENTS.md`

The format and all fields are identical on both platforms. The section header must be exactly `## Session Config`.

## Schema Validation (#182)

The 7 mandatory fields enforced by `scripts/lib/config-schema.mjs` are:

| Field | Rule |
|-------|------|
| `test-command` | non-empty string |
| `typecheck-command` | non-empty string |
| `lint-command` | non-empty string |
| `agents-per-wave` | integer ≥ 2 (or object with `default` ≥ 2) |
| `waves` | integer ≥ 3 |
| `persistence` | boolean |
| `enforcement` | one of `strict` / `warn` / `off` |

Validation runs automatically via `scripts/parse-config.mjs` → `scripts/validate-config.mjs`. Behavior is driven by the `enforcement` field itself:

- `enforcement: off` → skip validation entirely
- `enforcement: warn` → print errors to stderr, still emit config (exit 0)
- `enforcement: strict` → print errors to stderr, suppress output, exit 1

Bypass via `SO_SKIP_CONFIG_VALIDATION=1`. Missing fields can be patched into an existing config file via `/bootstrap --retroactive`.

## Parser Gotcha: No-Inline-Comment Block Headers

**General contract, applies to every nested (block-shaped) Session Config key, not just the handful annotated below.** A top-level block key like `eval:`, `custom-phases:`, `moc-staleness:`, `context-coverage:`, or `worktree-orphans:` is opened by the shared bold-tolerant matcher `matchBlockHeader(line, key)` (`scripts/lib/config/block-header.mjs`) rather than by a per-key regex. As of the #830 generalisation, **38 files** under `scripts/lib/config/` import it — 37 block-shaped parsers (`auto-dream`, `broken-window`, `cold-start`, `config-protection`, `context-coverage`, `cross-repo`, `custom-phases`, `dialectic`, `discovery-validator`, `dispatcher-autonomy`, `dispatcher-autonomy-capture`, `docs-orchestrator`, `docs-staleness`, `drift-check`, `eval`, `events-rotation`, `evolve`, `frontend-slop-hook`, `gitlab-portfolio`, `handover-gate`, `loop-guard`, `memory`, `moc-staleness`, `persona-gate-wave`, `reconcile`, `skill-evolution`, `slopcheck`, `state-md-lock`, `templates-first`, `test`, `vault-integration`, `vault-mirror-quality`, `vault-staleness`, `vault-sync`, `verification-auto-fix`, `wave-reviewers`, `worktree-orphans`) plus `block-header.mjs` itself — confirmed via `grep -rln "matchBlockHeader" scripts/lib/config/ | wc -l` → `38`.

**The matcher's accept/reject contract** (`matchBlockHeader(line, key)`, equivalent to the regex `^(?:-\s+)?(?:\*\*)?<key>:(?:\*\*)?\s*$`):

| Form | Matches? |
|---|---|
| `key:` | ✅ plain header |
| `- key:` | ✅ dash-bullet header |
| `**key:**` | ✅ bold header |
| `- **key:**` | ✅ dash-bullet + bold header |
| `key: value` | ❌ a header carrying a value is not a block-opener |
| `key:  # comment` | ❌ **the load-bearing gotcha** — a trailing inline comment on the header line itself |
| `  key:` (indented) | ❌ this is a sub-key of some other block, not a top-level header |
| `other-key:` | ❌ different key |

**Why the inline-comment case matters more than it looks.** When a block-header line carries a trailing `# comment`, the matcher returns `false` for that line — the block-open scan never flips into "in-block" mode, so **every field under that key silently falls back to its default**. There is no error, no warning, no stderr output anywhere in the pipeline. The only symptom is a repo's opt-in feature quietly behaving as if it were never configured — exactly the class of bug this gotcha exists to prevent. Sub-key lines (`enabled:`, `mode:`, …) are unaffected — inline comments on THOSE lines parse fine; only the block-opener line itself is fragile.

**The five keys carrying an explicit source-level warning comment today** (a strict subset of the 37 — every other block-shaped key has the identical failure mode, just without an inline reminder):

- `eval:` — see § Eval (#803) below for the full parser-gotcha paragraph (learning confidence 0.9).
- `custom-phases:` — see § Custom Phases (#637) below.
- `moc-staleness:` — see § MOC Staleness (#831/B2) below.
- `context-coverage:` — see § Context Coverage (#831/B4) below.
- `worktree-orphans:` — see § Worktree Orphans (#831/B5) below.

**Stale-citation note:** an older code comment on the `custom-phases:` key in this repo's own `CLAUDE.md` cites a per-key regex (`/^custom-phases:\s*$/`) as the mechanism. That citation predates the #830 generalisation — `custom-phases.mjs` (like all 37 consumers) now delegates to the shared `matchBlockHeader(line, 'custom-phases')`, which is strictly MORE tolerant than the old per-key regex (it additionally accepts the dash-bullet and bold-bullet renderings). The no-inline-comment failure mode is unchanged; only the underlying mechanism moved from a bespoke regex to the shared helper. Treat any remaining per-key regex citation in prose (including in this file, prior to this section's introduction) as documentation of the OLD mechanism — the general contract above is current.

## Policy Files

Some sub-configs live in dedicated policy files under `.orchestrator/policy/`:

| File | Schema | Purpose |
|------|--------|---------|
| `blocked-commands.json` | inline | Destructive-command guard rules (#155). |
| `quality-gates.json` | `quality-gates.schema.json` | Canonical test/typecheck/lint commands (#183). Overrides the `test-command` / `typecheck-command` / `lint-command` Session Config fields when present. |

## Session Structure

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agents-per-wave` | integer or integer with overrides | `6` | Maximum parallel subagents per wave. Supports session-type overrides: `6 (deep: 18)` outputs `{"default": 6, "deep": 18}`. Plain integers remain plain. The override key names a session type but does **not** create one: there is no `session-type:` Session Config key — `parseSessionConfig()` emits none, so writing one into a repo's `## Session Config` block is inert prose. The session type comes from the `/session` argument (default `deep`, see `commands/session.md`) and is persisted to STATE.md frontmatter as `session-type:`, which is the only live read (`scripts/print-applicable-rules.mjs` rule mode-gating). |
| `agent-mapping` | object | null | Optional mapping of role keys to agent names for explicit agent binding. Keys: `impl`, `test`, `db`, `ui`, `security`, `compliance`, `docs`, `perf`. Example: `{ impl: code-editor, test: test-specialist }`. Overrides auto-discovery when present. Values may carry a channel prefix — see § `agent-mapping` values below. |
| `waves` | integer | `5` | Number of execution waves for feature and deep sessions. |
| `recent-commits` | integer | `20` | Number of recent commits to display during session start git analysis. |
| `special` | string | none | Repo-specific instructions. Freeform text that the orchestrator reads and follows during sessions. |

### `agent-mapping` values — channel prefixes (#1150)

A mapping value has three forms, distinguished by the colon:

| Value form | Meaning | Dispatch |
|---|---|---|
| `<project-agent>` (no colon) | An agent file under `<state-dir>/agents/<name>.md` | Agent tool, unchanged |
| `session-orchestrator:<plugin-agent>` | A plugin agent shipped by this repo | Agent tool, unchanged |
| `cursor:<model>` | A **foreign model** over the Cursor channel (`cursor-agent`) | Coordinator-direct via `dispatchForeign()` — **not** the Agent tool |

```
agent-mapping: { impl: cursor:composer-2.5, test: cursor:cursor-grok-4.6-high, security: security-reviewer }
```

**Unknown channels fail loud.** `scripts/lib/config.mjs` parses this key and throws on any prefix outside `cursor` / `session-orchestrator` (`agent-mapping role '<k>' names unknown channel '<c>' …`), and on a prefix with an empty target. Silently accepting a typo would dispatch to an agent that does not exist and surface only as an empty wave, much later. A value without a colon is a plain agent name and is never channel-parsed.

**Where the rest of the contract lives** — deliberately not here, so one place owns it:

- **Model selection** (which model for which role, and why): the operator's model-routing SSOT (ADR-002). Working defaults are `composer-2.5` for foreign impl and `cursor-grok-4.6-high` for review / test-writing / judgment roles.
- **Dispatch contract** (detached worktree, the `never_foreign` role lock, the filesystem-measured verdict, the MANDATORY Claude semantic diff-review before merge-back, wall-clock timeout instead of `maxTurns`, and the `orchestrator.foreign_dispatch.completed` event that replaces the hook-chain telemetry a foreign run cannot emit): `skills/wave-executor/wave-loop.md` § Third branch: foreign-model dispatch.

## VCS & Infrastructure

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `vcs` | string | auto-detect | Version control platform: `github` or `gitlab`. Auto-detected from git remote URL if not set. |
| `gitlab-host` | string | from remote | Custom GitLab hostname. Only needed if the host cannot be inferred from the git remote URL. |
| `mirror` | string | `none` | Mirror target after push. Set to `github` to automatically push to a GitHub remote after every session commit. |
| `cross-repos` | list | none | Related repositories under `~/Projects/`. The orchestrator checks their git state and critical issues during session start. |
| `cross-repo.projects` | list | `[]` | Repos to process when running cross-repo maintenance scripts (`run-migrate-v2-cross-repo.mjs`, `vault-integration-watcher.mjs`, `promote-vault-strict.mjs`). Each entry is a path (absolute, `~`-prefixed, or bare name resolved under `~/Projects/`). When this list is empty or absent, those scripts emit a one-line notice and exit 0 — they never error on an empty list. Example: `[~/Projects/my-app, ~/Projects/another-app]`. |
| `pencil` | string | none | Path to a `.pen` design file (relative to project root). Enables design-code alignment reviews after Impl-Core and Impl-Polish waves. |
| `ecosystem-health` | boolean | `false` | Enable service health checks at session start. Requires `health-endpoints` to be configured. Accepts the SCALAR form (`ecosystem-health: true`) read off the flat key/value map, or a BLOCK form (`ecosystem-health:` with no value, followed by an indented body — the wizard's output) read via `_parseEcosystemHealthBlockEnabled()`; the scalar wins when both are present (#1174). |
| `health-endpoints` | list | none | Service URLs to check health. Each entry is an object with `name` and `url` fields. Parsed by `scripts/lib/config/health-endpoints.mjs`, which accepts THREE forms (#1174) — see below. |

**`health-endpoints` accepted forms.** Before #1174 the parser read this key off the flat KV map,
which bails to `null` the instant a value contains `{` and cannot see a nested YAML block at all;
the wizard's own output (Form B) silently failed to parse. All three forms below are parsed
content-scoped, independent of the flat KV map:

```yaml
# Form A — inline object array
health-endpoints: [{name: "API", url: "https://a/health"}, {name: "W", url: "http://w:8080/z"}]

# Form B — nested block (top-level, or one level under `ecosystem-health:`); the wizard's output.
# Block items may also be inline objects, `- { name: API, url: … }` (the form this file's own
# example above uses).
health-endpoints:
  - name: API
    url: https://api.example.com/health

# Form C — bare bracket list of URLs; each URL becomes its own name ({ name: <url>, url: <url> })
health-endpoints: [https://a/health, https://b/health]
```

The `name=url` shorthand (Form D) is **not** supported — an entry containing `=` is treated
verbatim as a Form-C URL, never split on `=`. A malformed entry (missing `name` or `url`, an
unmatched brace) resolves to `null` for the whole key and prints exactly one
`config: health-endpoints:` WARN to stderr — it never throws, so a broken config key cannot take
down session-start.
| `issue-limit` | integer | `50` | Maximum issues to fetch when querying VCS during session start. |
| `stale-branch-days` | integer | `7` | Days of inactivity before a branch is flagged as stale. |
| `stale-issue-days` | integer | `30` | Days without progress before an issue is flagged for triage. |

## Auto-Skill Dispatch (#337)

Opt-in phrase-match meta-skill (`skills/using-orchestrator/SKILL.md`) that inspects the user's first message for implicit slash-command intent (e.g. "plane neues Projekt", "run discovery on the backlog") and dispatches to the highest-confidence matching entry-point skill via the `Skill` tool — before that skill's own Phase 1 — once the bootstrap gate is open. Off by default; when `false` (or absent) the meta-skill returns immediately with zero reads, zero logging, zero side effects, and every calling skill behaves exactly as if it was never invoked.

This is a top-level SCALAR field — not a nested object — matching `vcs`, unlike most of the other opt-in features in this reference which live under a nested block.

```yaml
auto-skill-dispatch: false               # opt-in; default false preserves existing behavior
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auto-skill-dispatch` | boolean | `false` | Master toggle. When `false`, `skills/using-orchestrator/SKILL.md` is a no-op — no message inspection, no phrase-map scoring, no dispatch. When `true`, every entry-point skill (per `skills/_shared/bootstrap-gate.md`) invokes the meta-skill once before its own Phase 1. |

**Dispatch algorithm summary:** the meta-skill scores the user's first message against a bilingual (EN/DE) phrase map covering `/plan {new,feature,retro}`, `/session {housekeeping,feature,deep}`, `/discovery`, `/evolve`, `/close`, `/bootstrap`. Confidence tiers: exact slash-command match `0.95`, exact natural-language match `0.90`, substring match `0.60`, semantic near-miss `0.40`. Only scores ≥ `0.85` trigger a dispatch. When the top two candidates both score ≥ `0.85` with a delta < `0.15`, the meta-skill disambiguates via `AskUserQuestion` (per `.claude/rules/ask-via-tool.md` AUQ-003) rather than silently picking one. Below `0.85`, or with no candidates, the meta-skill returns silently and the calling skill's own routing logic takes over — the original user message is never rewritten before being passed to the dispatch target.

**Used by:** `skills/using-orchestrator/SKILL.md` (the dispatch algorithm, full phrase map, and confidence-scoring table), `skills/_shared/bootstrap-gate.md` (the opt-in call site — invoked once per entry-point skill when the gate is open). Note: unlike most Session Config booleans documented in this file, `auto-skill-dispatch` has no dedicated parser module under `scripts/lib/config/` — it is read directly from the raw Session Config text by the calling skill's own Phase logic, the same pattern used for prose-level opt-in flags that never reach `scripts/parse-config.mjs`'s structured JSON output.

## Templates-First Hook (#519)

Opt-out configuration for the PreToolUse `Bash` hook that blocks `gh|glab pr|mr|issue create` calls unless the matching repo template (`.github/PULL_REQUEST_TEMPLATE*`, `.github/ISSUE_TEMPLATE*`, `.gitlab/merge_request_templates/*`, `.gitlab/issue_templates/*`) was Read in the current session. Per-session acknowledgement is tracked in `.orchestrator/runtime/templates-acknowledged.json` — once a template is Read (or `/templates-ack` is invoked), the hook stops blocking for the remainder of the session. Mechanical replacement for gitlab-ops template advice. PRD gsd Pattern 3 / issue #519.

All fields live under a top-level `templates-first` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
templates-first:
  enabled: true                        # default true; mechanical replacement for gitlab-ops template advice
  hosts: [github, gitlab]              # array of "github" | "gitlab" — host allow-list
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `templates-first.enabled` | boolean | `true` | Master toggle for the hook. When `false`, the hook is bypassed entirely — `gh`/`glab` create calls are never blocked on template-read state. |
| `templates-first.hosts` | list of `"github"` \| `"gitlab"` | `[github, gitlab]` | Host allow-list the hook enforces against. A malformed or empty list falls back to the default; unrecognised entries are filtered out silently. |

**Used by:** `hooks/pre-bash-templates-first.mjs`, `.orchestrator/policy/templates-policy.json`, `/templates-ack` (session-scoped bypass).

## Quality

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `test-command` | string | `npm test` | Custom test command. Used by quality gates for all test invocations. Overridden by `.orchestrator/policy/quality-gates.json` when present (#183). |
| `typecheck-command` | string | `npm run typecheck` | Custom TypeScript check command. Set to `skip` for non-TS projects. Overridden by policy file when present. |
| `lint-command` | string | `npm run lint` | Custom lint command. Used by the Full Gate quality check at session end. Overridden by policy file when present. |
| `ssot-files` | list | none | Single Source of Truth files to track for freshness (e.g., `STATUS.md`, `STATE.md`). Flagged if older than `ssot-freshness-days`. |
| `ssot-freshness-days` | integer | `5` | Days before an SSOT file is flagged as stale during session start. |
| `plugin-freshness-days` | integer | `30` | Days before the plugin itself is flagged as potentially outdated. |

## Verification Auto-Fix Loop (#521)

Opt-in retry loop that dispatches a `code-implementer` fixer-agent after an inter-wave Quality-Gate failure, supplying the failed gate's output, `corrective_context`, and the changed file paths since the last green SHA. Bounded by `max-retries` — after the loop is exhausted, a diagnostics bundle is written to `.orchestrator/metrics/verification-failures/<ISO-timestamp>.json` and the wave hard-aborts. When disabled (default), the wave-executor aborts on the first gate failure — today's behaviour is unchanged. PRD gsd Pattern 4 / issue #521.

All fields live under a top-level `verification-auto-fix` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
verification-auto-fix:
  enabled: false                       # opt-in; default false preserves current abort-on-fail behaviour
  max-retries: 2                       # integer ≥ 0 — bounded fixer-agent retries before hard abort
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `verification-auto-fix.enabled` | boolean | `false` | Master toggle. When `false`, the inter-wave Quality-Gate aborts the wave on the first failure — no fixer-agent is dispatched. |
| `verification-auto-fix.max-retries` | integer | `2` | Maximum number of fixer-agent dispatch attempts before the loop gives up and hard-aborts the wave. Bounds: integer ≥ 0. |

**Used by:** `scripts/lib/quality-gate.mjs` (`runQualityGateWithRetry`), `skills/wave-executor/SKILL.md` inter-wave checkpoint, `.claude/rules/quality-gates-autofix.md`.

## Discovery

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `discovery-on-close` | boolean | `true` for every session type | Run discovery probes automatically during `/close`. An explicit value always wins. Was session-type aware until 2026-07-29 (`false` for `housekeeping`, #264); measurement showed the probes are the system's main project-hygiene surface, so defaulting them off for the cleanup session type left it as the only one closing without hygiene diagnostics. Set `false` explicitly for a faster close. |
| `discovery-probes` | list | `[all]` | Probe categories to run: `all`, `code`, `infra`, `ui`, `arch`, `session`, `audit`, `vault`, `feature`. |
| `discovery-exclude-paths` | list | `[]` | Glob patterns to exclude from discovery scanning (e.g., `vendor/**`, `dist/**`). |
| `discovery-severity-threshold` | string | `low` | Minimum severity for reported findings: `critical`, `high`, `medium`, `low`. |
| `discovery-confidence-threshold` | integer | `60` | Minimum confidence score (0-100) for discovery findings to be reported. Findings below this threshold are auto-deferred. |
| `discovery-parallelism` | integer | `5` | Maximum probe agents dispatched in parallel per category during Phase 3. Bounds: `1..16`; out-of-range values silently fall back to the default. Raise for large stacks to reduce wall-clock, lower to relieve a busy host. |

## Issue Budget (per-session creation cap)

Bounds how many issues ONE session may create. This is a **quantity** gate and is deliberately separate from `discovery-severity-threshold` / `discovery-confidence-threshold` above, which are per-finding **quality** filters: those two cannot bound volume (their `low` / `60` defaults filter almost nothing), they are only consulted in skill prose, and the largest producers — session-end carryover filing, `/plan` issue creation, `scripts/lib/spiral-carryover.mjs` — never read them at all.

```yaml
issue-budget:
  max-per-session: 12          # integer >= 0; 0 blocks every non-exempt creation
  mode: strict                 # strict | warn | off
  overflow: collect-issue      # collect-issue | vault-note
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `issue-budget.max-per-session` | integer | `12` | Non-exempt issues one session may create before the cap bites. `0` is valid (blocks everything non-exempt). Malformed or negative values fall back to `12`. |
| `issue-budget.mode` | string | `strict` | `strict` blocks over-cap creations (exit 2 from the hook) and parks them as overflow; `warn` allows them with a stderr notice; `off` disables the gate entirely (no counter is written). |
| `issue-budget.overflow` | string | `collect-issue` | Where session-end drains parked creations. `collect-issue` files exactly ONE `[Backlog-Sammel] <session-id>, N zurückgestellte Punkte` issue (`type::backlog`, `priority::low`) whose body is a checklist of the parked items; `vault-note` writes a single Markdown file under `vault/00-inbox/` instead. |

**Exemptions (load-bearing).** `priority::critical`, the carryover class (`[Carryover]`, `[SPIRAL]`/`[FAILED]`, `type::carryover`, a bare `carryover` label) and `broken-window` closure issues bypass the cap unconditionally. Without those exemptions the cap would break the standing session-end promises in `skills/session-end/SKILL.md` (Phase 1.8 "non-deselectable" SPIRAL/FAILED carryover, and the Critical Rule "ALWAYS create issues for unfinished PLANNED work"). Exempt creations are counted in the state file's `exempt` field for observability but never blocked.

**Counter file:** `.orchestrator/runtime/issue-budget/<sha256(sessionId)[0..16]>.json` — `{ sessionId, count, exempt, overflow: [...] }`, ONE file per session (#1141: the former single `issue-budget.json` slot was reset by whichever session wrote last, so two sessions in one working copy silently disabled each other's cap). Identity-less callers still use the legacy flat path; `budgetStatePath(repoRoot, sessionId)` in `scripts/lib/issue-budget.mjs` is the resolver.

**Used by:** `hooks/pre-bash-issue-budget.mjs` (shell path, PreToolUse/Bash), `scripts/lib/spiral-carryover.mjs` `runCli()` (programmatic path), `scripts/lib/issue-budget.mjs` (shared decision core), `skills/session-end/SKILL.md` Phase 5 Step 3b (overflow drain). Parser: `scripts/lib/config/issue-budget.mjs`.

## Slopcheck (Package Legitimacy Gate) (#520)

Opt-in defense against LLM-hallucinated package names ("slopsquatting"). When enabled, `classifyPackages(pkgs)` consults the registry and classifies each package as `LEGITIMATE` (exists, download count above threshold), `ASSUMED` (exists but very new / low downloads — warning, not block), `SUS` (audit warning hit — operator confirmation required), or `SLOP` (package not found in the registry — a possible LLM hallucination; hard block in plan-flow). Hooked into `/plan` PRD generation (Phase 3.5 Package-Audit) and `/discovery` supply-chain probes. Complementary to the always-on SEC-020 supply-chain baseline (`ignore-scripts=true`, `block-exotic-subdeps=true`, `minimum-release-age=1440`): SEC-020 prevents post-install execution of malicious packages; Slopcheck prevents adopting non-existent (typosquat-target) packages in the first place. PRD gsd Pattern 2 / issue #520.

All fields live under a top-level `slopcheck` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
slopcheck:
  enabled: false                       # opt-in; defaults to off so existing sessions are unaffected
  sources: [plan, discovery]           # array of "plan" | "discovery" — where classifyPackages is invoked
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `slopcheck.enabled` | boolean | `false` | Master toggle for the package-legitimacy gate. When `false`, `classifyPackages()` is never invoked from `/plan` or `/discovery`. |
| `slopcheck.sources` | list of `"plan"` \| `"discovery"` | `[plan, discovery]` | Which call-sites invoke `classifyPackages()`. A malformed or empty list falls back to the default; unrecognised entries are filtered out silently. |

**Used by:** `scripts/lib/slopcheck.mjs` (`classifyPackages`), `skills/plan/SKILL.md` Phase 3.5, `skills/discovery/probes/supply-chain-slopcheck.mjs`.

## Persistence & Safety

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `persistence` | boolean | `true` | Enable session resumption via STATE.md and session memory files. |
| `memory-cleanup-threshold` | integer | `5` | Recommend `/memory-cleanup` after N accumulated session memory files. |
| `memory-cleanup-soft-limit` | integer | `180` | Hard ceiling on accumulated memory files before the cleanup nudge escalates from a soft suggestion to a strong recommendation. PRD F2.2 / issue #502. Used by `scripts/lib/auto-dream.mjs`. |
| `learning-expiry-days` | integer | `30` | Legacy/default expiry window used by review/extend flows. New analyzer learnings preserve a candidate-supplied `expires_at` or derive expiry from `LEARNING_TTL_DAYS[type]` (for example, `autonomy-verdict` is 90 days). |
| `learnings-surface-top-n` | integer | `15` | Cap on how many learnings the session-start Phase 5.6 and session-plan Step 0.5 sections surface, ranked by confidence descending. `0` = do not surface any learnings. Applies to Project Intelligence output. |
| `learning-decay-rate` | float (0.0 ≤ x < 1.0) | `0.05` | Confidence decay applied to every untouched learning at session-end (after touched-set update, before prune). `0.0` = disable decay. A learning starting at `0.5` confidence survives ~10 untouched sessions with default decay. |
| `enforcement` | string | `warn` | Hook enforcement level for scope and command restrictions: `strict`, `warn`, or `off`. |
| `enforcement-gates` | object | null | Per-gate toggles for enforcement hooks. Keys: `path-guard`, `command-guard`, `post-edit-validate`, `bash-write-guard`, `bash-write-verify`. Values are booleans. **Missing keys default to enabled — with one deliberate exception: `bash-write-guard` defaults to DISABLED** (see below). Example: `{ path-guard: true, command-guard: true, post-edit-validate: false }`. Combined with `enforcement` (which controls strict/warn/off globally). |
| `allow-destructive-ops` | boolean | `false` | When `true`, disables the main-session destructive-command guard (`hooks/pre-bash-destructive-guard.mjs`). Set to `true` for intentional maintenance sessions that need `git reset --hard`, `rm -rf`, etc. Defaults to `false` (safe). See issue #155 and `.claude/rules/parallel-sessions.md` (PSA-003). Example: `allow-destructive-ops: true` |
| `reasoning-output` | boolean | `false` | Enable STATE:/PLAN: structured reasoning markers in agent prompts. When true, agents emit short transparency lines before tool calls. Opt-in — adds prompt overhead. |
| `grounding-check` | boolean | `true` | Enable file-level grounding verification in session-end Phase 1.1a (planned vs touched files). When true, session-end compares each agent's declared file scope against `git diff --name-only $SESSION_START_REF..HEAD` and reports scope creep + incomplete coverage. Informational — does not block session close. |
| `grounding-injection-max-files` | integer | `3` | Max files with recent `edit-format-friction` stagnation history to inject as line-numbered GROUNDING blocks into each agent's prompt before dispatch (wave-executor pre-dispatch step). Per-agent scope; selects top N by recency. `0` disables the feature. Gated on `persistence: true`. (#85) |
| `isolation` | string | `auto` | Agent isolation mode: `worktree`, `none`, or `auto`. `auto` resolves per-wave via the graduated default (#194): ≤2 agents → `none`, 3–4 agents on feature/deep → `worktree`, ≥5 agents → `worktree`, housekeeping 3–4 → `none`. Explicit `worktree` or `none` overrides the graduation. See [isolation graduation](#isolation-graduation) below. |
| `max-turns` | integer or string | `auto` | Maximum agent turns before PARTIAL. Auto: housekeeping=8, feature=15, deep=25. |
| `auto-commit-per-wave` | boolean | `false` | Automatically commit each wave's work after the Quality-Lite gate passes. Checkpoint commits per wave reduce the risk of data loss from `git stash` collisions in parallel sessions (V3.3 RESCUE incident — see GitLab #214). When `false`, all work is committed at session-end via `/close`. Requires `persistence: true`; the flag is silently ignored when `persistence: false`. Trade-off: each wave produces an additional commit; git log shows N+1 commits instead of 1. Use `/simplify` or `git rebase -i --autosquash` before final close to squash if a clean history is desired. **Implementation note:** the procedural commit sequence (`scripts/lib/auto-commit.mjs`) is deferred to V3.6. Until then, setting this flag to `true` triggers a session-start warning that auto-commits are not yet active — the flag is a no-op but is validated so projects can opt in early. <!-- path-check: historical --> |

### enforcement-gates: the five gate keys (#800/#915)

`enforcement-gates` is surfaced to the hook layer as `gates` inside the wave's
`wave-scope.json`. Five keys are read today:

| Gate key | Hook | Event | Default when the key is ABSENT | Effect |
|----------|------|-------|-------------------------------|--------|
| `path-guard` | `hooks/enforce-scope.mjs` | PreToolUse `Edit\|Write\|MultiEdit` | **enabled** | Denies (strict) / warns (warn) on a file path outside `allowedPaths`. |
| `command-guard` | `hooks/enforce-commands.mjs` | PreToolUse `Bash` | **enabled** | Denies (strict) / warns (warn) on a blocked command pattern. |
| `post-edit-validate` | `hooks/post-edit-validate.mjs` | PostToolUse `Edit\|Write` | **enabled** | Per-file validation after a successful edit. |
| `bash-write-guard` | `hooks/enforce-commands.mjs` | PreToolUse `Bash` | **DISABLED — inverted default** | Warn-only; parses likely shell write targets out of the command and warns for each one outside `allowedPaths`. |
| `bash-write-verify` | `hooks/post-bash-write-verify.mjs` | PostToolUse `Bash` | **enabled** | Warn-only; observes the actual working-tree delta after a Bash call and reports files changed outside `allowedPaths`. |

**`bash-write-guard` is the one gate whose missing key means OFF.** Every other
key follows "absent → enabled", so a reader who has internalised that convention
will assume a repo without an explicit entry is covered. It is not. The hook
requires `gates['bash-write-guard'] === true` **literally** —
`enforce-commands.mjs` tests for the boolean `true`, not for "not false".

That silent assumption is why this row exists at all (#915): the gate shipped in
#800, was documented nowhere for two releases, and consequently ran in zero
sessions while the enforcement layer was believed to cover Bash writes. It does
not by default — and `enforce-scope.mjs` gates only `Edit`/`Write`/`MultiEdit`,
so a plain `echo x > out-of-scope.mjs` passes every PreToolUse path check.

The inverted default is deliberate, not an oversight: parsing write targets out
of an arbitrary shell command is heuristic (quoting, `>$VAR`, process
substitution, heredocs), so a false positive is cheap to produce. Measured over
2 528 real Bash calls from 41 archived sessions of this repo, the parser flagged
56 calls (2.22 %) — of which the majority were parse artefacts (`EOF`, `{`,
`0.3`) that never touched the filesystem. Keeping it opt-in until that rate is
driven down is correct; leaving it undocumented was not.

`bash-write-verify` (#915) is the complementary, non-heuristic half: it reports
what the filesystem actually shows rather than what the command appeared to say,
which is why it can default to enabled. It is warn-only and cannot block — a
PostToolUse hook fires after the command already ran. Its purpose is to produce
the evidence needed to flip `bash-write-guard` to `true` with confidence. See
§ Bash-Write Verify below.

## Bash-Write Verify (PostToolUse Bash diff, #915)

`hooks/post-bash-write-verify.mjs` closes the observability half of the Bash
bypass class. After every `Bash` tool call it runs
`git --no-optional-locks status --porcelain -z`, subtracts a baseline snapshot
taken on the previous invocation, and reports paths that appeared or changed
**outside** the wave's `allowedPaths`.

Properties that matter:

- **Warn-only, always.** stderr line plus a PostToolUse `additionalContext`
  string. Never a deny; PostToolUse cannot block a command that already ran.
- **Delta, not absolute.** Reporting the whole dirty tree on every call would
  fire on every Bash call for the rest of the session once a single file is
  edited. Only paths that are new *relative to the previous Bash call* are
  reported, and each path is reported **once**.
- **Silent re-baseline.** First call of a session, and any call after the wave's
  `allowedPaths` change, records the current dirty set without warning — that
  dirt was not caused by the call being observed.
- **Snapshot lives outside the repo** (`$TMPDIR/so-bash-write-verify/<hash>.json`),
  so the guard can never report its own bookkeeping.
- **Ignore list is part of the contract**, not an implementation detail — see
  the table in the hook's header comment. It covers sibling-hook writes under
  `.orchestrator/`, coordinator status files under `.claude/`/`.codex/`/`.cursor/`/`.pi/`,
  package-manager artefacts (`node_modules/`, lockfiles), build/coverage output,
  and `tmp+rename` residue (`*.tmp*`). These are mostly `.gitignore`d in this
  repo, but the guard must not depend on a consumer repo's `.gitignore` being
  complete.

**Measured cost and noise.** All figures below were measured on 2026-07-30
against this repo at 1 507 tracked files (`git ls-files | wc -l`); the corpus is
this repo's 51 archived Claude Code transcripts (the per-project `*.jsonl`
files under the host-local Claude Code projects directory), of which 41 contain
at least one `Bash` tool call.

| Metric | Value |
|--------|-------|
| Hook end-to-end, per Bash call | **94.8 ms** (10 runs, wall clock) |
| …of which node cold start (paid by every hook process anyway) | ~67 ms — an existing PreToolUse Bash hook, `enforce-commands.mjs`, measures 66.9 ms on the same loop |
| …marginal cost of the `git status` this hook adds | **~28 ms** |
| `git … status --porcelain -z --untracked-files=all` | 25.0 ms/call (`--untracked-files=normal` measured 28.7 ms — `all` is not the slower option here, because the expensive subtrees are `.gitignore`d) |
| Bash calls in the corpus | 2 528 |
| Calls containing any write construct at all | 732 (29.0 %) |
| Calls writing a real in-repo, non-ignored path | **23 (0.91 %)** |
| Distinct such paths per session | **median 1, max 5** |

So a typical session sees ~1 warning and a worst-case session sees 5. Two
design choices produce that number rather than the naive one: the ignore list,
and — more importantly — report-once. Without report-once the guard emits a
line on *every* Bash call from the first out-of-scope write to the end of the
session, because `git status` reports the cumulative dirty tree, not a delta.

Live cross-check on the session that added this hook: with a 29-entry
`allowedPaths` union, the snapshot recorded **0** out-of-scope paths — i.e. zero
warnings across the session's Bash calls.

**Turning it off:** `enforcement-gates: { bash-write-verify: false }`, or
`enforcement: off`, or the standard `SO_DISABLED_HOOKS=post-bash-write-verify`
profile-gate env var.

**Making it bite.** This hook can never become blocking — the escalation path is
to flip `bash-write-guard` (PreToolUse, *can* deny) to `true` once its
false-positive rate has been measured down. Prerequisite before that flip: a
session's worth of `bash-write-verify` warnings compared against the same
session's `bash-write-guard` warnings, showing the parser produces no warning
that the filesystem diff does not confirm.

## STATE.md Lock (#518)

Mechanical write-lock around STATE.md that prevents race conditions between parallel worker sessions (or parallel wave-executor checkpoints within one session) writing the same file. When enabled, `withStateMdLock(repoRoot, fn)` acquires `.orchestrator/state.lock` via atomic tmp-file + rename before invoking `fn`, and releases on completion or throw. A stale lock (holder PID no longer alive, or heartbeat expired) is overridden atomically with a WARN on stderr; genuine contention past `timeout-ms` returns `{ ok: false, reason: 'timeout' }` to the caller. This mechanically enforces PSA-003/PSA-004 (Destructive Action Safeguards / Commit Discipline) for STATE.md specifically — the race condition becomes structurally impossible rather than merely discouraged. PRD gsd Pattern 1 / issue #518.

All fields live under a top-level `state-md-lock` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
state-md-lock:
  enabled: true                        # default true; mechanical guard against PSA-003/PSA-004 violations
  timeout-ms: 10000                    # integer ≥ 0 — acquire timeout in milliseconds
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `state-md-lock.enabled` | boolean | `true` | Master toggle for the mechanical write-lock. When `false`, STATE.md writers proceed without acquiring `.orchestrator/state.lock` — behaviour reverts to the pre-#518 unlocked write path. |
| `state-md-lock.timeout-ms` | integer | `10000` | Milliseconds a caller waits to acquire the lock before giving up. Bounds: integer ≥ 0. |

**Used by:** `scripts/lib/session-lock.mjs` (`acquireStateLock`/`releaseStateLock`/`withStateMdLock`), every STATE.md writer under `scripts/lib/state-md/`, session-start Phase 1.5/1b, wave-executor inter-wave checkpoints, session-end Phase 3.7. See `.claude/rules/parallel-sessions.md` § PSA-005.

## Discovery-Validator (PSA-006 Enforcement, #567)

Non-blocking `SubagentStop` hook that mechanically enforces PSA-006: distributional claims ("N of M", "100% of", "all N", "no remaining", "every X", "none of") appearing in a subagent's transcript tail must carry an adjacent fenced grep/rg/find transcript. When a claim lacks one, the hook records a `discovery_validator_violation` event in `.orchestrator/metrics/events.jsonl` and emits a stderr WARN. v1 is log + warn only — exit 0 always, never blocks the agent; a blocking hard-gate is reserved for a future iteration. Default OFF (opt-in) — the #690 flip to ON was reverted 2026-09-02 (#1191) after fleet measurement showed 6,946 violation events accumulating in 18 repos that never declared the block.

All fields live under a top-level `discovery-validator` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
discovery-validator:
  enabled: true                        # off by default; opt in per repo — log+warn-only, exit-0-always
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `discovery-validator.enabled` | boolean | `false` | Master toggle. When `false` (or when the block is absent), the `SubagentStop` hook is bypassed entirely — no transcript scanning, no `discovery_validator_violation` events. Note: when the `discovery-validator:` block is present but omits the `enabled:` line, the parser conservatively resolves to `false` — only a literal `true` enables the hook. Always set `enabled` explicitly when adding this block. |

**Used by:** `hooks/post-subagent-discovery-validator.mjs`, `scripts/lib/config/discovery-validator.mjs` (`_parseDiscoveryValidator`). See `.claude/rules/parallel-sessions.md` § PSA-006.

## Worker-Pool Dispatch (#415)

Opt-in bounded-concurrency cursor-based agent dispatch. When `enabled: true`, wave-executor uses `runWavePool()` (from `scripts/lib/wave-executor/pool.mjs`), so at most `max-parallel` agents are active at any moment. Projects that omit this block use the default small-batch Agent() dispatch (3–4 calls per message, cumulative up to `agents-per-wave`; large single-message fan-outs are forbidden — see `skills/wave-executor/wave-loop.md § Dispatch Agents`).

All fields live under a top-level `worker-pool` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
worker-pool:
  enabled: false           # opt-in; default false preserves existing behavior
  max-parallel: 4          # cap concurrent workers; defaults to agents-per-wave
  drain-timeout-ms: 10000  # ms to wait for in-flight workers after abort signal
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `worker-pool.enabled` | boolean | `false` | When `false`, the default small-batch Agent() dispatch is used (3–4 calls per message; large single-message fan-outs forbidden). When `true`, dispatches via `runWavePool()` with a bounded cursor. |
| `worker-pool.max-parallel` | integer | value of `agents-per-wave` | Maximum concurrent workers active simultaneously. Falls back to `agents-per-wave` when unset. |
| `worker-pool.drain-timeout-ms` | integer | `10000` | Milliseconds the pool waits for in-flight workers to settle after an abort signal fires before returning partial results. |

## Agent Output Schema Validation (#451)

Opt-in validation of each agent's machine-readable output block against its declared JSON Schema (`output-schema:` frontmatter). When enabled, wave-executor calls `validateAgentOutput()` (from `scripts/lib/agent-output-schema.mjs`) on every agent result and annotates the record with a `schema_status` field. Agents without an `output-schema:` declaration are silently skipped (backward-compatible). Agents with a schema that emit invalid output are flagged according to `enforce`.

All fields live under a top-level `output-schema-validation` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
output-schema-validation:
  enabled: false           # opt-in; default off preserves existing behavior
  enforce: warn            # warn | strict | off
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `output-schema-validation.enabled` | boolean | `false` | Master toggle. When `false`, no schema validation is performed and agent records carry no `schema_status` field. When `true`, validation runs after every agent completes. |
| `output-schema-validation.enforce` | string | `warn` | Violation handling: `warn` logs the violation in `subagents.jsonl` and continues the wave; `strict` surfaces the violation as a wave-blocking finding; `off` disables violation recording entirely (useful when `enabled: true` is needed only for `schema_status` tagging on valid outputs). |

## Environment Awareness (v3.1.0)

Introduced by Epic #157 / issue #166. Lets session-start sense the host (RAM, CPU, SSH, peer sessions) and adapt wave planning accordingly. All fields are opt-in defaults — a project without this block behaves identically to v3.0.0.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `resource-awareness` | boolean | `true` | Master toggle for the env-aware runtime. When `false`, skips Phase 4.5 adaptive wave sizing and the host banner. |
| `enable-host-banner` | boolean | `true` | Whether `hooks/on-session-start.mjs` emits the host + resource banner at the top of every session. Set `false` to silence. |
| `resource-thresholds` | object | see below | Numeric thresholds that drive Phase 4.5 adaptive rules. Unset sub-keys fall back to the single canonical default set (`DEFAULT_RESOURCE_THRESHOLDS` in `scripts/lib/resource-probe/evaluate.mjs`). Sub-keys: `ram-free-min-gb`, `ram-free-critical-gb`, `cpu-load-max-pct`, `concurrent-sessions-warn`, `ssh-no-docker`, `zombie-threshold-min`. |

### resource-thresholds

Sub-key defaults:

```yaml
resource-thresholds:
  ram-free-min-gb: 4            # soft memory signal (see precedence below)
  ram-free-critical-gb: 2       # hard memory signal → coordinator-direct
  cpu-load-max-pct: 90          # soft CPU signal, judged on min(1m, 5m)
  concurrent-sessions-warn: 5   # soft signal at this many live peer SESSIONS
  ssh-no-docker: true           # when session is over SSH, steer the plan away from Docker-based tests
  zombie-threshold-min: 30      # age (minutes) above which an idle Claude/Node process is a zombie candidate
```

**No single threshold caps a wave (#1089).** A cap requires either one *hard*
signal (→ `critical`, coordinator-direct) or **two independent soft signals**
agreeing (→ `warn`, cap 2). One soft signal alone is reported and acted on by
nobody. Rationale and the measured firing rates are in
[`.claude/rules/host-resources.md`](../.claude/rules/host-resources.md); the full
rule table is in `skills/session-start/phase-4-5-resource-health.md`.

**What the memory thresholds are compared against** is chosen by precedence, not
by configuration: `memory_pressure_pct_free` (macOS, hard `<15%` / soft `<30%`)
outranks `ram_available_gb`, which outranks `ram_free_gb`. The two GB-denominated
keys above therefore apply to *available* RAM on macOS and to `os.freemem()` on
Linux/Windows, where it is accurate. They are never compared against Darwin's
`Pages free`, whose median across 1477 measured session starts was **0.4 GB** on
hosts with 24-128 GB installed — gating on it fired `ram-free-critical-gb` on
84.0% of all starts.

**`concurrent-sessions-warn` counts SESSIONS, not processes.** The live count
comes from the session registry (`detectPeers()` — self excluded,
heartbeat-fresh). Until #1089 it was compared against `claude_processes_count`, a
measured 6x unit error (median processes:sessions = 6.0) that fired the threshold
on 93.6% of starts instead of 4.2%. When the registry is unreadable the probe
falls back to the process count rescaled by that same factor.

**`zombie-threshold-min`** (default: `30`): When set, the resource probe runs a secondary `ps` pass that counts Claude and Node processes older than this many minutes **and** with CPU% ≤ 1%. These are "zombie candidates" — stale sessions or orphaned workers that still hold RAM. The probe exposes them via `zombie_processes_count` in the snapshot. Since #1089 this is a *soft* signal: it is reported when `zombie_processes_count >= 1` **and** there is a live peer/process context, but on its own it caps nothing — sweeping stale sessions is housekeeping advice, not a reason to shrink a wave. The reason string surfaces the threshold and count so the session-start banner gives actionable context. Set to `0` to disable zombie detection entirely (the field is omitted from the default snapshot when absent from config).

Rationale: originated from the 2026-04-19 incident where 8 parallel Claude sessions on one Mac caused a hard freeze. That hazard is real and the rules still escalate for it — what #1089 changed is that they now recognise it, instead of reporting it on 99.0% of session starts where it was not happening. See Epic #157, Sub-Epic #158, and `.claude/rules/host-resources.md`.

### isolation graduation

The graduated default implements `scripts/lib/wave-sizing.mjs::resolveIsolation`. Per-wave truth table:

| agentCount | sessionType | isolation |
|---|---|---|
| ≤ 2 | any | `none` |
| 3–4 | housekeeping | `none` |
| 3–4 | feature / deep | `worktree` |
| ≥ 5 | any | `worktree` |

**Plan-level override:** session-plan may emit `collision-risk: low | medium | high` alongside each wave spec. `high` forces `worktree` even at ≤2 agents — use it when agents will edit the same files.

**Config-level override:** setting `isolation: worktree` or `isolation: none` in Session Config disables the graduation entirely for every wave.

**File-disjoint invariant (cross-repo confirmed, conf 1.0):** the ≥5-agent
`worktree` graduation is a collision-avoidance default, not a hard rule — when
a wave's file scopes are explicitly disjoint (per session-plan's file-ownership
mapping), `isolation: none` remains the proven default even above 5 agents
(confirmed externally at 5 waves × 6 agents, 0 merge conflicts — matching this
repo's own `waves: 5` / `agents-per-wave: 6` defaults).

**Enforcement auto-promote (#194):** when isolation resolves to `none`, `enforcement: warn` auto-promotes to `strict` for that wave — the scope hook becomes the only barrier once worktrees are absent, so it must be hard. Explicit `enforcement: off` is respected (user opt-out).

Rationale: the verified learning `coordinator-over-worktree-on-shared-files` (confidence 0.75) showed that small waves on partitioned scopes merge cleaner in-place than under worktree isolation. Two consecutive deep sessions (2026-04-20 07:30, 09:00) hit worktree base-ref staleness on ≤2-agent waves — the graduated default eliminates that hot path.

### base-ref freshness (#195)

Independent of isolation choice, wave-executor now persists a per-worktree meta file (`.orchestrator/tmp/worktree-meta/<suffix>.json`) when dispatching with `isolation: worktree`. Before each merge-back, it calls `checkWorktreeBaseRefFresh` (from `scripts/lib/worktree-freshness.mjs`) which returns one of four decisions:

- **pass** — worktree base matches current `main` HEAD; merge-back proceeds.
- **warn** — `main` advanced since worktree creation but drift does not overlap the agent's scope; log and proceed.
- **block** — `main` advanced AND drift files overlap the agent's scope; merge-back is refused. The coordinator reconciles manually or rebases the agent's branch.
- **no-meta** — meta file missing or corrupted; fall back to manual diff review.

This guard converts the manual post-copy `git diff` check (used to rescue the 07:30 and 09:00 regressions) into a coded pre-copy gate. The check is non-blocking on `pass` / `warn` / `no-meta`; only `block` interrupts the wave.

### Heavy-Repo Preflight (HR-003/HR-004, baseline #60)

`templates/shared/.claude/rules/heavy-repo.md` documents two Session Config fields for repos large enough that default parallelism risks resource pressure (HR-001 indicators: checkout > 50 MB, DB surface > 100 tables, prior parallel agent count > 15, build time > 90s, generated artifacts > 200 MB). Both fields are now wired end-to-end (previously documented but silently dropped by the parser):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `heavy-repo` | boolean | `false` | Marks the repo as heavy per HR-001. When `true`, `scripts/lib/resource-probe/evaluate.mjs` and `scripts/lib/wave-resource-gate.mjs` apply a STATIC preflight ceiling: `recommended_agents_per_wave_cap` / dispatched `agents` are clamped to at most `agents-per-wave`, REGARDLESS of the live resource-probe verdict. When `agents-per-wave` uses the parenthetical override syntax (e.g. `4 (deep: 18)`), the parsed value is an object `{default, <mode>: N}`, not a plain number — both modules resolve that shape to `.default` (no session-mode input is in scope at the gate), so the cap is never silently skipped for overridden repos. More-restrictive-wins: a resource-driven `reduce`/`coordinator-direct` that already computed a tighter number is never loosened by this cap — it only ever lowers, never raises, the dispatched agent count. `validateSessionConfig()` (`scripts/lib/config-schema.mjs`) also emits a warn-level cross-field finding when `heavy-repo: true` and `isolation` is `auto` or `none` — heavy repos should pin `isolation: worktree` (HR-003 anti-pattern). |
| `worktree-cleanup` | string | `default` | One of `default` \| `aggressive`. HR-003 recommends `aggressive` for heavy repos (clean up worktrees immediately after each wave, no cross-wave retention). **Honesty note:** `aggressive` currently behaves identically to `default` at runtime — the parser accepts and returns the value, but the per-wave aggressive sweep into `worktree-cleanup.mjs`/`worktree-sweep.mjs` is a tracked follow-up, not yet implemented. Setting this field today documents intent; it does not yet change wave-executor's cleanup cadence. |

Session-start Phase 4.5 (`skills/session-start/phase-4-5-resource-health.md`) passes `heavy-repo` and `agents-per-wave` through to `evaluate()` and renders `⚠ Heavy-repo mode active — agents-per-wave capped to N (Session Config heavy-repo: true)` when the ceiling actually reduces the recommendation, per HR-004.

The heavy-repo cap applies only on the resource-aware path: it runs inside `applyDecisionRules()`/`evaluate()`, both gated behind `resource-awareness` being enabled (the default). Setting `resource-awareness: false` is a FULL opt-out — it skips the live probe AND bypasses the HR-004 static cap, even when `heavy-repo: true` is also set.

## Planning

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseline-ref` | string (git ref) or null | null | Git ref (branch, tag, or SHA) on the baseline GitLab project from which to fetch canonical `.claude/rules/*.md` and `.claude/agents/*.md` during `/bootstrap`. When null, rules arrive via Clank's weekly baseline sync MRs (legacy path). See [baseline-ref](#baseline-ref) below. |
| `baseline-project-id` | string or number | `"52"` | GitLab project ID of the baseline repository. Defaults to `"52"` (`infrastructure/projects-baseline`). Has no effect when `baseline-ref` is unset. See [baseline-project-id](#baseline-project-id) below. |
| `plan-baseline-path` | string | none | Path to projects-baseline directory (e.g., `~/Projects/projects-baseline`). Optional. When absent, `/bootstrap` falls back to plugin-bundled minimal templates. Previously required for `/plan new` repo scaffolding; now only required if you want to scaffold from your own baseline. Host-locally resolved through an extended precedence chain — a host can additionally declare per-context `baselines:` entries in `owner.yaml`, matched by directory prefix against the current repo's path (#819); see the Vault Integration § host-local override callout below for the full chain. |
| `plan-default-visibility` | string | `internal` | Default repo visibility for `/plan new`: `internal`, `private`, or `public`. |
| `plan-prd-location` | string | `docs/prd/` | Directory where PRD documents are saved (relative to project root). |
| `plan-retro-location` | string | `docs/retro/` | Directory where retrospective documents are saved (relative to project root). |

### baseline-ref

- **Type:** string (git ref) | null
- **Default:** null
- **Used by:** bootstrap (rules-fetch bridge)

The git ref (branch name, tag, or commit SHA) on the baseline GitLab project from which to fetch canonical `.claude/rules/*.md` and `.claude/agents/*.md` during `/bootstrap`. When set, the rules-fetch bridge runs as a post-scaffold step.

When `null` (the default), rules arrive in the repo via Clank's weekly baseline sync MRs (the legacy path). Setting `baseline-ref: main` short-circuits that delay so a freshly-bootstrapped repo starts with current rules immediately.

Pin to a specific SHA for reproducible bootstraps:
```yaml
baseline-ref: a1b2c3d4
```

Or float on a branch for always-current rules:
```yaml
baseline-ref: main
```

Requires:
- `GITLAB_TOKEN` env var set with read scope on the baseline project
- `scripts/lib/fetch-baseline.mjs` present in the session-orchestrator plugin

If the fetch fails (network error, auth error, missing file), bootstrap continues without aborting — rules will arrive via the legacy Clank sync path. A warning is printed.

See: session-orchestrator issue #110, projects-baseline `docs/REPO-STATUS.md`.

### baseline-project-id

- **Type:** string | number
- **Default:** `"52"` (infrastructure/projects-baseline on `<your-gitlab-host>`)
- **Used by:** bootstrap (rules-fetch bridge)

The numeric GitLab project ID of the baseline repository. Defaults to `"52"` which corresponds to `infrastructure/projects-baseline`. Override only when adopting this plugin against a different baseline source.

Used together with `baseline-ref`. Has no effect when `baseline-ref` is unset.

## Vault Sync

Opt-in configuration for the `vault-sync` quality gate at session-end (see `skills/vault-sync/SKILL.md`). The gate validates YAML frontmatter against the canonical `vaultFrontmatterSchema` and flags dangling wiki-links across a markdown knowledge base. Projects without a vault leave these fields unset and are unaffected.

All fields live under a top-level `vault-sync` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
vault-sync:
  enabled: true
  mode: warn
  vault-dir: .
  exclude: [ "**/_MOC.md", "**/_overview.md", "**/README.md" ]
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `vault-sync.enabled` | boolean | `false` | If true, session-end runs the vault-sync validator as part of Phase 2 Quality Gate. When false (or missing), the gate is skipped silently. |
| `vault-sync.mode` | string | `warn` | Gate severity. `hard` blocks session close on frontmatter/schema errors. `warn` reports errors in the quality gate report but does not block. `off` bypasses the validator entirely (useful during onboarding when `enabled` is flipped on but the vault is not yet clean). Dangling wiki-links are always warnings regardless of mode. |
| `vault-sync.vault-dir` | string | project root (`$PWD`) | Directory to scan for `.md` files. Passed to the validator via `VAULT_DIR`. Accepts absolute or project-relative paths. |
| `vault-sync.exclude` | list of glob strings | `[]` | File patterns to skip during validation (e.g. `**/_MOC.md`, `**/README.md`, `**/_overview.md`). Legitimate index files that do not carry full note frontmatter should be listed here. Matching files are counted in `excluded_count` but are not validated. Supports `**`, `*`, and `?` wildcards (fnmatch-style). |

## CLAUDE.md Drift Check

Opt-in narrative-drift gate at session-end Phase 2.2 (see `skills/claude-md-drift-check/SKILL.md` for the full spec — the SSOT for check semantics). Ten checks run against top-level repo docs:

1. `path-resolver` — absolute paths in CLAUDE.md / _meta resolve on disk
2. `project-count-sync` — hardcoded `01-projects/` count claims match the actual folder count
3. `issue-reference-freshness` — issue references inside forward-looking sections (What's Next, Backlog, Open Issues, Offene Themen, Todo, Next Steps, Roadmap) are not closed
4. `session-file-existence` — `50-sessions/YYYY-MM-DD-*.md` references exist on disk
5. `command-count` — claimed "N commands" prose matches actual `commands/*.md` count
6. `session-config-parity` — top-level `## Session Config` keys diffed against `docs/session-config-template.md`
7. `vault-dir-parity` — `CLAUDE.md` vs `AGENTS.md` agreement on `vault-integration.vault-dir`
8. `generated-rule-staleness` (WARN-only) — auto-generated rules whose `learning-key` is absent or expired in `learnings.jsonl`
9. `rule-scoping` — `.claude/rules/*.md` `paths:`/`globs:` frontmatter defects, cited-but-missing rule citations, zero-match globs, foreign PascalCase glob tokens
10. `docs-parity` — `docs/components.md` count-claims vs actual on-disk counts, Session Config key parity between `docs/session-config-template.md` and `docs/session-config-reference.md`, and stale legacy metrics-path references (the pre-#217 `.claude`-rooted convention, superseded by `.orchestrator/metrics/`) in the docs tree (three sub-checks a/b/c; issue #780)

Complementary to `vault-sync`: that gate validates frontmatter inside the vault tree; this gate validates narrative claims in top-level docs.

All fields live under a top-level `drift-check` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
drift-check:
  enabled: true
  mode: warn
  include-paths:
    - CLAUDE.md
    - AGENTS.md
    - _meta/**/*.md
  check-path-resolver: true
  check-project-count-sync: true
  check-issue-reference-freshness: true
  check-session-file-existence: true
  check-command-count: true
  check-session-config-parity: true
  check-vault-dir-parity: true
  check-generated-rule-staleness: true
  check-rule-scoping: true
  check-docs-parity: true
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `drift-check.enabled` | boolean | `false` | If true, session-end runs the drift checker as part of Phase 2.2. When false (or missing), the gate is skipped silently. |
| `drift-check.mode` | string | `warn` | Gate severity. `hard` makes the checker exit non-zero on drift; session-end surfaces the errors, creates carryover, and continues. `warn` reports drift in the quality gate report but does not block. `off` bypasses the checker entirely. |
| `drift-check.include-paths` | list of strings | `["CLAUDE.md", "AGENTS.md", "_meta/**/*.md"]` | Files to scan. Supports exact paths and `<dir>/**/*.<ext>` directory-recursive patterns (relative to repo root). |
| `drift-check.check-path-resolver` | boolean | `true` | Enable Check 1 (`path-resolver`): every absolute `/Users/…` path in scope files must resolve via `existsSync`. Code-fence blocks are skipped. |
| `drift-check.check-project-count-sync` | boolean | `true` | Enable Check 2 (`project-count-sync`): hardcoded `(N registered)` / `(N projects)` claims must match the actual `01-projects/*/` count. Auto-skipped if no `01-projects/` directory exists. |
| `drift-check.check-issue-reference-freshness` | boolean | `true` | Enable Check 3 (`issue-reference-freshness`): `#NN` references inside forward-looking sections (What's Next, Backlog, Open Issues, Offene Themen, Todo, Next Steps, Roadmap) must be open per `glab issue view`. Auto-skipped if `glab` is not on PATH or origin repo cannot be detected. |
| `drift-check.check-session-file-existence` | boolean | `true` | Enable Check 4 (`session-file-existence`): every `50-sessions/YYYY-MM-DD-*.md` reference must exist on disk at `<vault>/50-sessions/<file>`. |
| `drift-check.check-command-count` | boolean | `true` | Enable Check 5 (`command-count`): claimed "N commands" prose must match the actual count of `*.md` files directly inside `commands/` (non-recursive). Auto-skipped if no `commands/` directory exists. |
| `drift-check.check-session-config-parity` | boolean | `true` | Enable Check 6 (`session-config-parity`): every top-level key under `## Session Config` in the canonical template (`docs/session-config-template.md`) must also be present in the resolved local instruction file. Missing keys are errors. |
| `drift-check.check-vault-dir-parity` | boolean | `true` | Enable Check 7 (`vault-dir-parity`): when both `CLAUDE.md` and `AGENTS.md` exist, their `vault-integration.vault-dir` values must agree. Skipped when only one instruction file is present. |
| `drift-check.check-generated-rule-staleness` | boolean | `true` | Enable Check 8 (`generated-rule-staleness`, WARN-only): every `.claude/rules/*.md` file with `auto-generated: true` frontmatter must carry a `learning-key` that resolves to a non-expired entry in `.orchestrator/metrics/learnings.jsonl`. Never blocks — this check only ever produces warnings. |
| `drift-check.check-rule-scoping` | boolean | `true` | Enable Check 9 (`rule-scoping`): validates `.claude/rules/*.md` frontmatter against the `rule-loader.mjs` activation contract — a top-level `paths:` key (error), cited-but-missing rule citations in `CLAUDE.md`/`AGENTS.md`/`## See Also` footers (error), zero-match `globs:` patterns (warn), and foreign PascalCase glob tokens (warn). Skipped silently when `.claude/rules/` is absent. |
| `drift-check.check-docs-parity` | boolean | `true` | Enable Check 10 (`docs-parity`): three sub-checks over the public docs surface, all reported under the single `docs-parity` check id — **(a)** `docs/components.md`'s own heading counts vs the same on-disk derivation Check 5's surface-count family uses; **(b)** top-level Session Config keys documented in `docs/session-config-template.md` (opt-in baseline) vs `docs/session-config-reference.md` (a key counts as documented when it appears in a `yaml` fence, a heading, or the first cell of a table row); **(c)** stale legacy metrics-path references (the old `.claude`-rooted convention, superseded by `.orchestrator/metrics/`) in root `docs/*.md` / `docs/examples/*.md`. Skipped silently when `docs/components.md` is absent, or explicitly via `--skip-docs-parity`. Issue #780. |

## Vault Integration

Opt-in configuration for the `vault-mirror` auto-sync that writes learnings and session summaries into the Meta-Vault after each session (see `scripts/vault-mirror.mjs`). When enabled, the session-end skill invokes the mirror script after writing JSONL metrics, and the evolve skill mirrors new learnings after each learning atomic-rewrite. Projects without a vault leave these fields unset and are unaffected.

All fields live under a top-level `vault-integration` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
vault-integration:
  enabled: true
  vault-dir: ~/Projects/vault
  mode: warn
  vault-name:                # optional (#660) — per-project vault namespace override
```

> **Host-local override (#653; extended #819).** `vault-dir` resolves host-locally with precedence: env-var (`SO_VAULT_DIR`) > `owner.yaml` `paths.vault-dir` > the committed default. `plan-baseline-path` resolves with an extra per-context tier in between: `SO_BASELINE_PATH` env > `owner.yaml` `baselines:` directory-prefix match against cwd > `owner.yaml` `paths.baseline-path` (legacy scalar) > the committed default. This keeps maintainer-specific absolute paths out of version control. Resolvers: `scripts/lib/config/host-paths.mjs` (both keys) and `scripts/lib/named-baseline-resolver.mjs` (the `baselines:` match tier).

> **Parser accepts three key-line renderings (#823).** The `vault-integration:` key line is recognized in plain form (`vault-integration:`), dash-bullet form (`- vault-integration:`), and bold-bullet form (`- **vault-integration:**`) — each paired with either the inline-object shape (`{ enabled: true, ... }` on the same line) or the indented block shape shown above. Parser: `scripts/lib/config/vault-integration.mjs` (`_parseVaultIntegration`).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `vault-integration.enabled` | boolean | `false` | If true, session-end and evolve skills invoke `vault-mirror.mjs` to sync learnings and sessions into the vault. When false (or missing), mirroring is skipped silently. |
| `vault-integration.vault-dir` | string or null | `null` | Absolute path to the vault repository. Falls back to `$VAULT_DIR` env variable if not set. Required when `enabled` is true. |
| `vault-integration.mode` | string | `warn` | Mirror error handling. `strict` blocks session close if the mirror exits non-zero. `warn` reports errors but does not block. `off` bypasses mirror invocation entirely (useful when transitioning). |
| `vault-integration.vault-name` | string or null | `null` | Optional override for the per-project vault namespace segment (#660). When set (or via CLI `--vault-name`), vault writes go to `40-learnings/<vault-name>/` and `50-sessions/<vault-name>/`, sanitised to a kebab slug. When null/absent, the namespace is derived from the git origin via `deriveRepo()`. Owner-privacy leaks (personal home path / private slug / personal name) are redacted to `redacted-repo`. NOT a filesystem path → NOT host-path-resolved. **Coverage gap:** portfolio board rows are NOT yet namespace-aware — the override only reaches `40-learnings/`, `50-sessions/`, and the per-repo narrative mirror (`narrative-mirror.mjs`, #832 item 2); tracked separately in #832. Resolver: `scripts/lib/vault-mirror/namespace.mjs` (`resolveRepoNamespace`). |
| `vault-integration.gitlab-groups` | string[] or null | `null` | List of GitLab group paths to scan for repos missing `.vault.yaml`. Consumed by `scripts/vault-backfill.mjs` (via `readVaultIntegrationConfig()`) and the `/plan retro` vault-backfill sub-mode (`skills/plan/mode-retro.md` Phase 1.6 Step 1). When null/unset, the backfill CLI exits with a "no groups configured" notice. |

### Environment override: `VAULT_MIRROR_CANONICAL_SUFFIX`

`vault-mirror.mjs` refuses to mirror into any directory whose `git remote get-url origin` does not end with a canonical-vault path suffix — a network-of-trust guard (#600 D2) that stops notes from silently accumulating in a wrong or typo'd vault location. A non-matching suffix fails the **whole run** (`process.exit(2)`), not a per-entry skip — mirroring even one note into the wrong place is the bug it prevents.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `VAULT_MIRROR_CANONICAL_SUFFIX` | env-var (string) | `/agents/vault` | Tightens the guard from the host-agnostic default (`/agents/vault`, suffix-only — matches that tail on **any** host) to a **host-qualified** match for high-threat / multi-host environments. Example: `VAULT_MIRROR_CANONICAL_SUFFIX=gitlab.mycompany.com/agents/vault`. Whitespace-only values fall back to the default. |

This is an **environment variable only — not a Session Config key** (intentional: a host-qualified suffix embeds an operator-specific hostname, which must never be committed into a public `CLAUDE.md` / `AGENTS.md`). Set it in your shell profile or CI secret store. The sibling `VAULT_MIRROR_SKIP_CANONICAL_CHECK` is an internal test-only escape hatch and is intentionally **not** an operator flag.

## Vault Mirror Quality (#504)

Opt-in quality thresholds applied by `scripts/vault-mirror.mjs` before mirroring a learning or session note to the Meta-Vault. Notes that fail the thresholds are skipped silently (not an error). PRD F1.2.

All fields live under a top-level `vault-mirror` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
vault-mirror:
  quality:
    min-narrative-chars: 400
    min-confidence: 0.5
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `vault-mirror.quality.min-narrative-chars` | integer | `400` | Minimum body length (characters) before a learning or session note is mirrored to the vault. Notes shorter than this threshold are skipped — useful to prevent low-information notes from cluttering the vault during onboarding or when a session yields only stubs. Bounds: integer ≥ 0. Out-of-range values silently fall back to the default. PRD F1.2 / issue #504. |
| `vault-mirror.quality.min-confidence` | float | `0.5` | Minimum learning confidence (0.0..1.0) before a learning note is mirrored. Confidence is read from the source learning record. Notes below this threshold are skipped. Set to `0.0` to mirror every learning regardless of confidence. Bounds: `0.0 ≤ value ≤ 1.0`. Out-of-range values silently fall back to the default. PRD F1.2 / issue #504. |

**Used by:** `scripts/vault-mirror.mjs`.

## Memory Banner (#505)

Opt-out configuration for the session-start memory-load banner. When session memory files are found and loaded at Phase 2.6, the orchestrator emits a `📚 Loaded from memory: N files` banner. Setting `enabled: false` silences the banner without affecting memory loading. PRD F2.3.

All fields live under a top-level `memory` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
memory:
  banner:
    enabled: true                # default true; set false to silence the session-start memory banner
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memory.banner.enabled` | boolean | `true` | When `true`, session-start Phase 2.6 emits a one-line banner listing how many memory files were loaded. When `false`, the banner is suppressed — memory files are still loaded and applied normally. PRD F2.3 / issue #505. |

**Used by:** `scripts/lib/memory-banner.mjs`, `scripts/lib/config/memory.mjs`.

## Memory Proposals (#501)

Opt-out configuration for the agent-writable memory tool. During a wave, an agent may queue a learning proposal via the `memory.propose` CLI. At session-end Phase 3.6.3, the coordinator surfaces every queued proposal to the operator via `AskUserQuestion` for accept / reject / edit. Only accepted proposals are persisted to `.orchestrator/metrics/learnings.jsonl` with a `proposed-by: <agent-name>` provenance tag — a one-line audit trail showing which agent generated the learning. PRD F2.1 / issue #501.

This is a Hermes-style memory-write API **without** Hermes' overwrites-manual-edits critique: the operator confirmation is mandatory and there is no silent overwrite path. Three safety layers keep the surface conservative:

1. **Quota per wave** — `quota-per-wave` (default `5`) caps how many proposals any single agent may queue within one wave. Excess proposals exit `1` and the call-site logs the rejection.
2. **Confidence floor** — `confidence-floor` (default `0.5`) rejects low-confidence proposals before they reach the operator (exit `2`). Tuned so a learning is only proposed when the agent is at least 50% sure of the insight.
3. **AUQ confirm-or-discard** — the session-end phase never auto-persists. Every proposal is `AskUserQuestion`-gated; the operator can accept, reject, or edit before commit.

All fields live under the top-level `memory` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), nested as a sibling of `memory.banner`:

```yaml
memory:
  proposals:
    enabled: true                # default true; opt-out master toggle for the memory.propose feature
    quota-per-wave: 5            # max proposals an agent may queue per wave (exit 1 on overflow)
    confidence-floor: 0.5        # proposals below this confidence are rejected (exit 2)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memory.proposals.enabled` | boolean | `true` | Master toggle for the entire memory-proposals feature. When `false`, the `memory.propose` CLI exits `3` (rejected-wrong-context) for every call and session-end Phase 3.6.3 is skipped. When `true`, agents may queue proposals during waves and the coordinator surfaces them at session-end. PRD F2.1 / issue #501. |
| `memory.proposals.quota-per-wave` | integer | `5` | Maximum number of proposals one wave-executor agent can queue per wave. The 6th proposal from the same agent in the same wave exits `1` (quota-exceeded). Bounds: integer ≥ 0. Set to `0` to disable proposals from agents without disabling the feature entirely (operator can still propose). |
| `memory.proposals.confidence-floor` | float | `0.5` | Minimum confidence (0.0..1.0) required for a proposal to be queued. Proposals with `--confidence < confidence-floor` exit `2` (rejected-low-confidence) before reaching the operator. Bounds: `0.0 ≤ value ≤ 1.0`. Set to `0.0` to accept any confidence (operator filters at AUQ time). |

### Agent CLI invocation

Agents call the CLI with five required flags **and must set `SO_WAVE_AGENT=1`** in the environment:

```bash
SO_WAVE_AGENT=1 node scripts/memory-propose.mjs \
  --type workflow-pattern \
  --subject "vault-mirror BATS test ordering" \
  --insight "BATS test files must be sourced before harness fixtures load the fnmatch shim." \
  --evidence "tests/vault-mirror/harness.bats:23 fails when shim loads after assertion bindings." \
  --confidence 0.85
```

**Wave-executor dispatch**: the boilerplate prompt in `skills/wave-executor/SKILL.md` sets `SO_WAVE_AGENT=1` automatically for every dispatched agent. Direct CLI invocation from the coordinator thread or outside a wave-executor agent context will exit `3` (`rejected-wrong-context`) because the env-var is absent. This is intentional — the guard prevents accidental coordinator-context invocations. Use `/evolve` instead when proposing learnings from the coordinator level (#543 H3).

**`--dry-run` flag (#741.3)**: pass `--dry-run` to validate a proposal (argv parsing + schema shape) without writing to `proposals.jsonl`. Under `--dry-run`, the wrong-context gates above (STATE.md active-check, `SO_WAVE_AGENT`, current-wave presence) are all bypassed — a dry-run never reaches the write step, so their protective purpose is moot, and bypassing them is what makes the flag safely runnable from coordinator context (e.g. for manual CLI verification) without first faking a wave-agent environment:

```bash
node scripts/memory-propose.mjs \
  --type workflow-pattern \
  --subject "vault-mirror BATS test ordering" \
  --insight "BATS test files must be sourced before harness fixtures load the fnmatch shim." \
  --evidence "tests/vault-mirror/harness.bats:23 fails when shim loads after assertion bindings." \
  --confidence 0.85 \
  --dry-run
```

A successful dry-run exits `0` with stdout status `dry-run-ok` (see updated exit-codes table below) and never appends to `proposals.jsonl`.

`--type` accepts one of the `PROPOSAL_TYPES` enum values (the agent-writable subset of the learnings schema): `mode-selector-accuracy`, `hardware-pattern`, `fragile-file`, `effective-sizing`, `recurring-issue`, `workflow-pattern`, `proven-pattern`, `anti-pattern`, `autopilot-effectiveness`, `domain-regression`, `convention`, `architecture-pattern`, `design-pattern`. Analyzer-only learning types such as `autonomy-verdict` are intentionally excluded because their evidence gates are enforced by `/evolve` analyzers, not by agent proposals. Strings with embedded quotes must be shell-escaped per usual conventions. The CLI appends one JSONL line to `.orchestrator/metrics/proposals.jsonl` (atomic via O_APPEND under the `.orchestrator/metrics/proposals-write.lock` mutex) and updates a per-wave summary at `.orchestrator/metrics/proposals-summary-<wave-id>.json` (counters: queued / dropped / below_floor / fs_error). The coordinator surfaces both files at session-end Phase 3.6.3 to render the AUQ multiSelect; approved entries promote into `.orchestrator/metrics/learnings.jsonl` with `_provenance: agent-proposed@<wave-id>`; rejected entries archive to `.orchestrator/proposals.rejected.log`. Privacy: `proposed_by_agent` is captured in the audit hook (`events.jsonl`) only and is stripped before promotion to learnings.jsonl.

### Exit codes

| Exit code | stdout `status` | Meaning | Triggered by |
|-----------|-----------------|---------|--------------|
| `0` | `queued` | Queued | Proposal accepted into the per-wave staging directory; awaits operator confirmation at session-end Phase 3.6.3. |
| `0` | `dry-run-ok` | Validated, not written | `--dry-run` was passed and the proposal (argv + schema) validated successfully. No write to `proposals.jsonl` occurs; the wrong-context gates are bypassed under this flag (#741.3). |
| `1` | `quota-exceeded` | Rejected — quota exceeded | This agent has already queued `quota-per-wave` proposals in this wave. Subsequent calls from the same agent fail until the next wave. Not applicable under `--dry-run` (gate bypassed). |
| `2` | `rejected-low-confidence` | Rejected — low confidence | `--confidence` argument is below `confidence-floor`. Tighten the insight or raise the confidence (operator can still tune the floor). |
| `3` | `rejected-wrong-context` | Rejected — wrong context | Feature disabled (`enabled: false`), STATE.md not active, or `SO_WAVE_AGENT != "1"` (call originated outside a wave-executor agent context). Not applicable under `--dry-run` (gate bypassed). |
| `4` | `error` | Arg error | Missing or malformed flag — invalid `--type`, empty `--subject`, non-numeric `--confidence`. The CLI prints a one-line usage message on stderr. |

The call-site (agent prompt) is expected to handle exit codes `1`, `2`, `3` gracefully — they are anticipated outcomes, not errors. Only exit code `4` indicates a bug in the agent's invocation. `dry-run-ok` (exit `0`) is a distinct success status from `queued` (also exit `0`) — callers that branch on stdout `status` (not just exit code) must match the exact string to distinguish "validated only" from "queued for review".

### Where it fits in the lifecycle

Memory proposals are one of five Epic #498 Phase 2 features that share the same memory-lifecycle picture. The full set:

- **F2.1 / #501 — Memory Proposals** (this section): agents queue learnings during waves; operator confirms at session-end.
- **F2.2 / #502 — Auto-Dream**: session-end auto-dispatches `/memory-cleanup` after every N sessions when memory-file count exceeds `memory-cleanup-soft-limit`.
- **F2.3 / #505 — Memory Banner** (sibling block above): session-start surfaces top learnings at the start of every session.
- **F2.4 / #503 — Peer Cards**: USER.md/AGENT.md curated profiles update from session evidence (operator-driven).
- **F2.5 / #506 — Dialectic-Deriver**: session-end auto-proposes peer-card edits via the dialectic critique loop.

Together: F2.1 captures fresh insight mid-flight, F2.2 consolidates old insight at scale, F2.3 surfaces it at the start, F2.4/F2.5 distill it into the durable peer-card profiles.

**Used by:** `scripts/lib/memory-proposals/{schema,store,collector,sink}.mjs`, `scripts/memory-propose.mjs`, `agents/memory-proposal-collector.md`, `hooks/pre-bash-memory-propose-audit.mjs`, `skills/session-end/SKILL.md` Phase 3.6.3.

**Cross-reference:** issue #501, PRD F2.1 in the Learning-Memory Modernization PRD; issue #741.3 (`--dry-run` flag + `dry-run-ok` status). Sibling features: `memory.banner` (above, F2.3 / #505), `dialectic.cadence` (F2.5 / #506), Auto-Dream (F2.2 / #502, surfaced via `memory-cleanup-soft-limit`).

## Auto-Dream Proposal Filter (#566)

Collect-emit confidence floor for memory proposals. Applied by `collectProposals()` (`scripts/lib/memory-proposals/collector.mjs`) at session-end Phase 3.6.3, immediately before the operator AUQ that promotes/rejects queued proposals. This is a **second** confidence gate above the write-time `memory.proposals.confidence-floor` (default `0.5`) enforced by `scripts/memory-propose.mjs`: the per-record write-floor runs first when an agent calls the CLI; the collect-emit floor here filters what surfaces to the operator's AUQ at session-end.

The two floors are additive — a proposal queued by an agent at confidence `0.6` will pass the default write-floor of `0.5` and be appended to `proposals.jsonl`, but if `auto-dream.min-confidence: 0.7` is set in Session Config, it is dropped from the queue at collect-emit time and never surfaces to the operator. The per-wave summaries in `stats` reflect the full intake (pre-filter) so audit trails remain accurate; only the AUQ-visible queue is filtered.

All fields live under a top-level `auto-dream` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
auto-dream:
  min-confidence: 0.5
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auto-dream.min-confidence` | float | `0.5` | Minimum confidence (0.0..1.0) for a queued proposal to surface in the session-end AUQ. Records with `record.confidence < min-confidence` are dropped from the returned queue (but counted in stats). Set to `0.0` to surface every proposal regardless of confidence. Set to `1.0` to surface only fully-confident records. Bounds: `0.0 ≤ value ≤ 1.0`. Out-of-range values silently fall back to the default. Second confidence gate applied to memory-proposals at session-end Phase 3.6.3 collect-emit (above the write-time `memory.proposals.confidence-floor`). Issue #566. |

**Used by:** `scripts/lib/config/auto-dream.mjs` (parser), `scripts/lib/memory-proposals/collector.mjs` (filter applied inside `collectProposals()`), `skills/session-end/SKILL.md` Phase 3.6.3.

**Cross-reference:** issue #566. Sibling feature: `memory.proposals.confidence-floor` (above, F2.1 / #501 — the write-time floor that runs first).

## Cold Start (#500)

Opt-out configuration for the cold-start detector. The detector nudges the operator at session-start when sessions go silent — no commits, no learnings, long wall-clock idle. PRD F1.3.

All fields live under a top-level `cold-start` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
cold-start:
  enabled: true
  nudge-after-hours: 1
  silence-after-sessions: 1
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cold-start.enabled` | boolean | `true` | Master toggle for the cold-start detector. When `false`, the detector is skipped entirely — no nudges fire and no idle-time tracking is performed. Defaults to `true` so the feature is opt-out rather than opt-in. PRD F1.3 / issue #500. |
| `cold-start.nudge-after-hours` | integer | `1` | Hours of wall-clock idle (since the last session-end) before the cold-start detector fires a nudge at session-start. Set to a higher value (e.g. `24`) to silence transient idle pings on a busy host. Set to `0` to disable the wall-clock check (only the silence-after-sessions check applies). Bounds: integer ≥ 0. PRD F1.3 / issue #500. |
| `cold-start.silence-after-sessions` | integer | `1` | Number of consecutive silent sessions (no commits, no learnings, no vault mirror writes) before the cold-start detector fires a nudge. A session counts as silent when both commits and learnings are zero. Set to `0` to disable the silence-count check. Bounds: integer ≥ 0. PRD F1.3 / issue #500. |

**Used by:** `scripts/lib/cold-start-detector.mjs`.

## Handover Alignment Gate (#769)

Opt-out configuration for the interactive Handover-Alignment-Gate in `/close`. The gate surfaces open questions before carryover issues are filed, giving the operator a chance to align on scope/expectations before the session's incomplete work is handed off. Fail-open: the gate is skipped entirely when disabled, when running headless, or under `/autopilot`.

All fields live under a top-level `handover-gate` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
handover-gate:
  enabled: true
  max-open-questions: 3
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `handover-gate.enabled` | boolean | `true` | Master toggle for the Handover-Alignment-Gate. When `false`, the gate is skipped entirely — `/close` proceeds straight to carryover filing with no interactive triage step. Fail-open: also skipped automatically when running headless or under `/autopilot`, regardless of this value. Issue #769. |
| `handover-gate.max-open-questions` | integer | `3` | Maximum number of open questions surfaced in the gate's triage AUQ. Bounds: integer ≥ 0. `0` means no questions are surfaced — the channel stays active (the gate still runs) but presents nothing to triage. Issue #769. |

**Used by:** `scripts/lib/config/handover-gate.mjs`, session-end Phase 1.65.

## Broken-Window Budget (#730/H5)

Opt-in configuration for the Broken-Window Budget in `/close`. When enabled, session-end Phase 2.6 aggregates THIS session's "knowingly-broken shipments" — echo-stub findings that shipped under `enforcement: warn`, "Override and close" choices in Phase 2.3 / 2.5, MED/LOW review findings routed to "Unresolved Review Findings" (#617), and wave-level reviewer findings overridden without a fix task — and files ONE hard-terminated closure issue per item (labels `broken-window` + `priority::high`, with a hard due-date). It also emits `orchestrator.finding.overridden` events feeding the `effectiveness.override_ratio` metric. Non-blocking and idempotent: a filing failure is a WARN and re-running a close never duplicates issues.

All fields live under a top-level `broken-window-budget` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
broken-window-budget:
  enabled: false
  due-days: 7
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `broken-window-budget.enabled` | boolean | `false` | Master toggle for session-end Phase 2.6. When `false`, the phase is skipped silently — no closure issues are filed and no override-ratio events are emitted. Issue #730 (Epic H / H5). |
| `broken-window-budget.due-days` | integer | `7` | Days from today used as the hard due-date on each filed closure issue. Bounds: integer ≥ 1. On GitLab this is passed to the native `--due-date` flag; on GitHub (no native due-date field) it is surfaced as a `Due: <date>` first body line. Malformed / non-integer / < 1 values fall back to 7 with a stderr WARN. Issue #730 (Epic H / H5). |

**Used by:** `scripts/lib/config/broken-window.mjs`, session-end Phase 2.6, `scripts/lib/spiral-carryover.mjs` (`createBrokenWindowIssue`).

## Dialectic-Deriver (#506)

Opt-in mode for `/evolve --dialectic` and session-end Phase 3.6.7 auto-trigger. When `cadence > 0`, session-end auto-dispatches `/evolve --dialectic --dry-run` after every N sessions to produce a proposed update to USER.md/AGENT.md peer cards (#503). The dry-run writes a sidecar at `.orchestrator/dialectic-pending.md`; the operator applies via `/evolve --dialectic --apply` in a subsequent session. Set `cadence: 0` as a kill-switch.

All fields live under a top-level `dialectic` object in your Session Config (CLAUDE.md or AGENTS.md):

```yaml
dialectic:
  cadence: 5              # integer ≥ 0; 0 = kill-switch
  model: haiku            # haiku | sonnet | opus
  budget-tokens: 8000     # input token budget per call
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dialectic.cadence` | integer | `5` | Number of sessions between auto-dialectic dispatches. Set to `0` to disable all dispatches (kill-switch). Non-integer and negative values silently fall back to default. |
| `dialectic.model` | string | `haiku` | Model tier for the critique call. Must be one of `haiku`, `sonnet`, `opus`. **Fail-fast**: unknown values cause parse-config.mjs to exit 1 at startup — NOT silently ignored. |
| `dialectic.budget-tokens` | integer | `8000` | Input token budget per call. Output budget is fixed at 4000 (per #506). Non-integer and negative values fall back to default. |

**Used by:** `skills/evolve/SKILL.md` Phase 6, `skills/session-end/SKILL.md` Phase 3.6.7, `scripts/dialectic-deriver.mjs`, `scripts/lib/auto-dialectic.mjs`.

**Cross-reference:** PRD F2.5 (#506) — Honcho's "reasoning at consolidation time" insight, adopted without SaaS/AGPL/per-message-LLM-cost.

**Auto-trigger behavior:** When `cadence > 0` AND sessions-since-last-dialectic ≥ cadence AND (≥1 new session OR ≥1 new learning since last run), session-end Phase 3.6.7 dispatches the deriver in dry-run mode. The diff sidecar lands at `.orchestrator/dialectic-pending.md` (gitignored, vault-mirror-excluded). When `cadence: 0`, the auto-trigger is permanently skipped; manual `/evolve --dialectic` always works.

**Token cost:** With defaults (cadence: 5, budget-tokens: 8000, output 4000, model haiku), ~12k tokens every 5 sessions. At haiku pricing this is ~$0.02/run. Surfaced in Final Report.

**Empirical note (2026-07-04 session-3) — the parser default of `8000` proved structurally unreachable for this repo's own peer-card/steering corpus.** Fixed overhead (Peer-Cards + Steering + scaffold) alone runs ≈13k tokens, and a full input set (top-50 learnings + last-10 sessions) runs ≈28.4k tokens — both already exceed the `8000` default before any call is made. This repo's own committed Session Config therefore sets `budget-tokens: 32000`, not the documented default. If your repo accumulates a similarly large peer-card/steering corpus over time, raise `budget-tokens` accordingly rather than leaving the low default in place — a too-low budget silently truncates the dialectic critique input rather than erroring.

## Eval (#803)

Opt-in configuration for the Standard v1 evaluation harness (aiat-llm-eval PRD, `docs/prd/2026-07-16-aiat-llm-eval.md` §S6) and the forthcoming `/eval` skill (Session-Prozess-Eval — lands in a later wave of Epic #803). This section documents the config surface only; the skill that reads it is not yet shipped as of this parser's introduction.

All fields live under a top-level `eval` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
eval:
  enabled: false           # opt-in
  mode: warn               # warn | off
  judge: off               # off | haiku | sonnet
  report: html             # html | none
  handle:                  # optional string — null/absent → null
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `eval.enabled` | boolean | `false` | Master toggle for the eval harness. Non-boolean / garbage values silently collapse to `false` — no throw, no warning (mirrors `docs-orchestrator.enabled`). |
| `eval.mode` | string | `warn` | Gate severity. Must be one of `warn`, `off`. **Fail-fast**: an unknown value throws `eval.mode must be warn|off, got '<value>'` at parse time — NOT silently ignored. |
| `eval.judge` | string | `off` | LLM-judge tier used by the harness. Must be one of `off`, `haiku`, `sonnet`. **Fail-fast** on an unknown value, same as `eval.mode`. |
| `eval.report` | string | `html` | Report artifact format. Must be one of `html`, `none`. **Fail-fast** on an unknown value, same as `eval.mode`. |
| `eval.handle` | string \| `null` | `null` | Optional free-text handle/label for the eval run. Absent, empty, or whitespace-only values all collapse to `null` (never an empty string). |

**Parser gotcha (learning confidence 0.9 — mirrors `custom-phases:` and every other block-shaped key):** the `eval:` key-line itself MUST NOT carry an inline comment. The block-open scan uses the shared `matchBlockHeader(line, 'eval')` (`scripts/lib/config/block-header.mjs`) — it tolerates the bold-bullet `- **eval:**` rendering (#830) but a trailing `# comment` on the header line still fails the match, so the parser never enters the block and ALL fields silently fall back to their defaults — no error, no warning surfaces anywhere. Sub-key lines (`enabled:`, `mode:`, …) tolerate inline comments without issue. See § Parser Gotcha: No-Inline-Comment Block Headers (top of this file) for the general contract this key shares with 36 other block-shaped keys.

**Used by:** `scripts/lib/config/eval.mjs` (`_parseEval`), `scripts/lib/config.mjs`. Skill consumer (`skills/eval/SKILL.md`) is a follow-up wave of Epic #803 — not yet implemented as of this parser.

## Vault Staleness

Opt-in configuration for vault-drift discovery probes. Detects stale vault projects and narratives. Used by `/discovery vault` (on-demand probe execution) and session-end Phase 2.3 (automatic gate at close time). Projects without a vault leave these fields unset and are unaffected.

All fields live under a top-level `vault-staleness` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
vault-staleness:
  enabled: false           # opt-in
  mode: warn               # warn | strict | off  (NOT 'hard'; canonical per #217)
  thresholds:
    top: 30                # days — tier=top narrative staleness threshold
    active: 60             # days — tier=active
    archived: 180          # days — tier=archived
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `vault-staleness.enabled` | boolean | `false` | If true, vault-staleness probes are activated. When false (or missing), Phase 2.3 and `/discovery vault` probes are skipped silently. |
| `vault-staleness.mode` | string | `warn` | Gate severity. `warn` runs probes and reports findings in the Docs Health line but never blocks session close. `strict` runs probes and blocks session close when findings are present; an interactive override prompt is available and any deviation is logged to STATE.md. `off` skips Phase 2.3 entirely — no probe execution. |
| `vault-staleness.thresholds.top` | integer | `30` | Days before a `tier=top` project's `lastSync` or narrative file (`context.md`, `decisions.md`, `people.md`) is flagged as stale. |
| `vault-staleness.thresholds.active` | integer | `60` | Days before a `tier=active` project's narrative is flagged as stale. |
| `vault-staleness.thresholds.archived` | integer | `180` | Days before a `tier=archived` project's narrative is flagged as stale. |

**Mode behavior:**

| Mode | Phase 2.3 | Blocks close? | Notes |
|------|-----------|---------------|-------|
| `off` | Skipped | No | No probe execution at all. |
| `warn` (default) | Runs | No | Findings reported in session-end Docs Health line. |
| `strict` | Runs | Yes | Override available via interactive prompt; deviation logged to STATE.md. |

**Related skills and files:**
- `/discovery vault` — on-demand probe execution command
- `skills/discovery/probes/vault-staleness.mjs` — project-staleness probe (flags `01-projects` with `lastSync` age > threshold)
- `skills/discovery/probes/vault-narrative-staleness.mjs` — narrative-staleness probe (checks `context.md`, `decisions.md`, `people.md` by tier)
- `skills/session-end/SKILL.md` — Phase 2.3: staleness gating and interactive override
- `.orchestrator/metrics/vault-staleness.jsonl` — JSONL output from the project-staleness probe
- `.orchestrator/metrics/vault-narrative-staleness.jsonl` — JSONL output from the narrative-staleness probe
- GitLab issue `#232` (foundation), `#242` (Sub-Epic C integration)

## Docs Staleness (#781)

Opt-in filesystem-mtime staleness probe for living reference docs — root-level `docs/*.md` plus `docs/examples/*.md`. Deliberately excludes `docs/adr/` (historically stable, immutable-by-design decision records) and `docs/prd/` (active work-in-progress scoped to a project's lifecycle). Unlike `vault-staleness` above, which reads a YAML frontmatter `updated:` field, this probe measures staleness via filesystem mtime — most repo docs under `docs/` carry no frontmatter at all. Used by `/discovery` when enabled. Epic #774 / issue #781.

All fields live under a top-level `docs-staleness` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
docs-staleness:
  enabled: false                       # opt-in
  mode: warn                           # strict | warn | off
  thresholds:
    living: 90                         # days — single tier; severity escalates at 1×/2×/3× threshold
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `docs-staleness.enabled` | boolean | `false` | If true, the probe is activated as part of `/discovery`. When false (or missing), the probe is skipped silently. |
| `docs-staleness.mode` | string | `warn` | Gate severity: `strict` \| `warn` \| `off`. A malformed value falls back to `warn`. The probe itself is fail-soft regardless of mode — it never throws. |
| `docs-staleness.thresholds.living` | integer (days) | `90` | Age threshold for the single `living` tier. Severity escalates relative to this threshold: `low` above `1×`, `medium` above `2×`, `high` above `3×`. Non-numeric or non-positive values fall back to the default. |

**Used by:** `skills/discovery/probes/docs-staleness.mjs` (`runProbe`), `scripts/lib/config/docs-staleness.mjs` (`_parseDocsStaleness`). Writes one JSONL summary record per run to `.orchestrator/metrics/docs-staleness.jsonl`. See `docs/README.md` for the living-vs-archived docs classification this probe enforces.

## MOC Staleness (#831/B2)

Opt-in session-start banner probe for Obsidian "map of content" index notes — `<vault>/08-topics/*-moc.md` whose frontmatter `updated:` is older than the threshold. Complements `vault-staleness` (which covers project narratives) by covering the topic index layer. Rendered at session-start Phase 4 alongside the other banners; never blocks a session.

```yaml
moc-staleness:
  # Parser gotcha: this key line must carry NO inline comment (§ Parser Gotcha: No-Inline-Comment Block Headers, top of this file).
  enabled: false                       # opt-in
  thresholds:
    moc: 90                            # days — frontmatter `updated:` staleness threshold
  mode: warn                           # warn | off
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `moc-staleness.enabled` | boolean | `false` | Must be explicitly `true` to activate. The gate fails CLOSED — a missing block, a missing `enabled` key, or an omitted `config` argument all return `null` before any filesystem I/O. |
| `moc-staleness.thresholds.moc` | integer (days) | `90` | Age threshold measured against frontmatter `updated:`. Non-numeric or non-positive values fall back to the default. |
| `moc-staleness.mode` | string | `warn` | `warn` \| `off`. A malformed value falls back to `warn`. |

A MOC whose `updated:` is **missing or unparseable is deliberately EXCLUDED**, not reported as stale — the corrective action there is "fix the frontmatter", not the banner's own hint. Same rule as `scripts/lib/peer-cards/staleness-banner.mjs`.

**Used by:** `scripts/lib/moc-staleness-banner.mjs` (`checkMocStaleness`), `scripts/lib/config/moc-staleness.mjs` (`_parseMocStaleness`). Wired at `skills/session-start/SKILL.md` Phase 4.

## Context Coverage (#831/B4)

Opt-in session-start coverage banner: registered `<vault>/01-projects/<slug>/` folders that carry **neither** `context.md` nor `_passive.md`. A project counts as *registered* iff its folder contains `_overview.md` — the same convention `discoverVaultRepos()` uses (`scripts/lib/gitlab-portfolio/vcs-detect.mjs`). Folders lacking `_overview.md` are never counted and never reported as gaps.

```yaml
context-coverage:
  # Parser gotcha: this key line must carry NO inline comment (§ Parser Gotcha: No-Inline-Comment Block Headers, top of this file).
  enabled: false                       # opt-in
  mode: warn                           # warn | off
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `context-coverage.enabled` | boolean | `false` | Must be explicitly `true` to activate. Fails CLOSED, as above. |
| `context-coverage.mode` | string | `warn` | `warn` \| `off`. A malformed value falls back to `warn`. |

**Used by:** `scripts/lib/context-coverage-banner.mjs` (`checkContextCoverage`), `scripts/lib/config/context-coverage.mjs` (`_parseContextCoverage`). Wired at `skills/session-start/SKILL.md` Phase 4.

## Worktree Orphans (#831/B5)

Opt-in session-end sweep (Phase 4b) identifying git worktree branches with **0 commits ahead of the base branch** — leftovers from finished sessions. The module **proposes; it never disposes**: it returns `candidates` and the coordinator renders the removal AUQ. Nothing is removed without explicit operator confirmation (PSA-003).

```yaml
worktree-orphans:
  # Parser gotcha: this key line must carry NO inline comment (§ Parser Gotcha: No-Inline-Comment Block Headers, top of this file).
  enabled: false                       # opt-in
  base-branch: main                    # ref the ahead-count is measured against
  mode: warn                           # warn | off
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `worktree-orphans.enabled` | boolean | `false` | Must be explicitly `true` to activate. Fails CLOSED — a repo that never opted in pays no git invocation. |
| `worktree-orphans.base-branch` | string | `main` | Ref the ahead-count is measured against. **Validated:** a value beginning with `-`, or containing whitespace or shell metacharacters, is rejected and falls back to `main`. |
| `worktree-orphans.mode` | string | `warn` | `warn` \| `off`. A malformed value falls back to `warn`. |

**Why `base-branch` is validated rather than passed through.** It reaches an argv position in `git rev-list --count <base>..<branch>`. A value shaped like a git flag (e.g. `--glob=refs/heads/*`) is parsed as an OPTION rather than a revision range, exits 0, and prints `0` — silently marking **every** worktree as a 0-ahead orphan and offering the operator a deletion prompt for worktrees full of live work. The conservative default does not catch it, because `0` parses fine. Defence is two-layer: the parser rejects leading-dash values, and the sink passes `--end-of-options` so any surviving payload becomes a hard git error. This makes `base-branch` a **fifth command-influencing Session Config surface** beyond the four listed in `.claude/rules/security.md` § "Session Config Command Trust" — and unlike those, no attacker is required: a typo reaches the same outcome.

A worktree holding uncommitted, staged or untracked work is **never** a candidate — `isWorktreeClean()` (the Phase 4a helper) is consulted first, and any git error while checking excludes the worktree conservatively.

**Used by:** `scripts/lib/session-end/worktree-orphan-sweep.mjs` (`checkWorktreeOrphans`), `scripts/lib/config/worktree-orphans.mjs` (`_parseWorktreeOrphans`, `_isSafeBaseBranch`). Wired at `skills/session-end/SKILL.md` Phase 4b.

## Docs Orchestrator

Opt-in configuration for the `docs-orchestrator` skill, which generates audience-split documentation (User / Dev / Vault) within sessions (see `skills/docs-orchestrator/SKILL.md`). When enabled, session-start runs a Phase 2.5 docs-context step, session-plan assigns a Docs role, and session-end runs a Phase 3.2 gap-reporting step. The `docs-writer` agent is made available automatically when `enabled: true`.

All fields live under a top-level `docs-orchestrator` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
docs-orchestrator:
  enabled: false                 # opt-in; when true, session-start Phase 2.5 runs + docs-writer agent available
  audiences: [user, dev, vault]  # allowed audiences — can be narrowed per project
  mode: warn                     # warn | strict | off — session-end Phase 3.2 gap reporting
```

| Field | Type | Default | Allowed values | Description |
|-------|------|---------|----------------|-------------|
| `docs-orchestrator.enabled` | boolean | `false` | `true` / `false` | If true, the docs-orchestrator lifecycle hooks activate: session-start Phase 2.5 runs a docs-context step, and session-end Phase 3.2 reports documentation gaps. When false (or missing), all docs-orchestrator steps are skipped silently. |
| `docs-orchestrator.audiences` | array of string | `[user, dev, vault]` | `user`, `dev`, `vault` | Audiences for which documentation is generated. Can be narrowed to a subset (e.g., `[user, dev]`) to skip vault-targeted docs on projects without a vault. Each value must be one of the three canonical audience identifiers. |
| `docs-orchestrator.mode` | string | `warn` | `warn` / `strict` / `off` | Gap-reporting severity at session-end Phase 3.2. `warn` reports undocumented changes but does not block session close. `strict` blocks session close when documentation gaps are detected. `off` bypasses gap reporting entirely (useful during onboarding). |

**Related skills and files:**
- `skills/docs-orchestrator/SKILL.md` — full skill spec, hook points, and source-citation rules
- `skills/docs-orchestrator/audience-mapping.md` — per-audience content rules and output formats
- `skills/session-start/SKILL.md` — Phase 2.5 docs-context step (activated when `enabled: true`)
- `skills/session-end/SKILL.md` — Phase 3.2 gap-reporting step (activated when `enabled: true`)
- `agents/docs-writer.md` — agent dispatched for documentation generation

## Events Rotation

Size-based rotation for `.orchestrator/metrics/events.jsonl` (#251). Rotation fires at **session-start only** — per-append overhead is rejected design given typical growth of ~6 KiB/day. When the active log exceeds `max-size-mb`, it is renamed to `events.jsonl.1`, older backups shift down (`.1` → `.2`, …, `.N-1` → `.N`), and the oldest backup (`events.jsonl.{max-backups}`) is deleted. Rotation failure never blocks session-start; errors are logged to stderr and swallowed.

All fields live under a top-level `events-rotation` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
events-rotation:
  enabled: true     # default true; set false to disable rotation entirely
  max-size-mb: 10   # default 10; integer, bounds 1..1024
  max-backups: 5    # default 5; integer, bounds 1..20
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `events-rotation.enabled` | boolean | `true` | If false, rotation is skipped entirely and `events.jsonl` grows unbounded. |
| `events-rotation.max-size-mb` | integer | `10` | Size threshold in MiB. When `events.jsonl` exceeds this, it is rotated at the next session-start. Bounds: `1..1024`; out-of-range values silently fall back to the default. |
| `events-rotation.max-backups` | integer | `5` | Number of retained backup files (`events.jsonl.1` … `events.jsonl.N`). The oldest is deleted before shifting. Bounds: `1..20`; out-of-range values silently fall back to the default. |

**Rename safety (POSIX):** Atomic rename is safe with in-flight writers. Open file descriptors continue writing to the original inode (now `events.jsonl.1`); new writers open the new file on next append. Maximum observed line size is 220 bytes, well under the 4096-byte PIPE_BUF atomicity guarantee.

## Test

Opt-in configuration for the `/test` agentic end-to-end test command (Epic #378, issue #383). When `enabled: true`, the `/test` command reads this block to determine which profile to run, where the profile registry lives, how to handle issue reconciliation findings, and how long to retain test-run artifacts. Projects that have not configured this block leave all fields at their defaults and are unaffected — `/test` will report "test is disabled" and exit unless `enabled` is set to `true`.

All fields live under a top-level `test` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
test:
  enabled: false                                         # master toggle
  default-profile: smoke                                 # profile name used when no --profile flag given
  profiles-path: .orchestrator/policy/test-profiles.json # profile registry location
  mode: warn                                             # warn | strict | off
  retention-days: 30                                     # artifact retention in days
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `test.enabled` | boolean | `false` | Master toggle for the `/test` agentic end-to-end test command. When `false`, `/test` reports "test is disabled" and exits. |
| `test.default-profile` | string | `smoke` | Profile name used when no `--profile` flag or positional arg is given. Must match a key in the profile registry at `profiles-path`. |
| `test.profiles-path` | string | `.orchestrator/policy/test-profiles.json` | Path (relative to repo root) where the test profile registry lives. |
| `test.mode` | string (`warn` \| `strict` \| `off`) | `warn` | Issue reconciliation severity. `warn` files findings non-blockingly. `strict` blocks session-end on HIGH/CRITICAL findings. `off` skips reconciliation entirely. |
| `test.retention-days` | integer | `30` | Days to retain `.orchestrator/metrics/test-runs/<run-id>/` artifacts before cleanup. Set to `0` to disable cleanup. |

## Custom Phases (#637)

Opt-in, repo-declared deterministic phases that run as their own phase during session close (and/or housekeeping). Where the freeform `special:` key gives no execution guarantee, `custom-phases` is a **contract**: each phase runs a deterministic `command` via Bash with exit-code gating and summary reporting, so a repo can run a domain command (e.g. an eval-learn aggregate) as a first-class close step. Absent/empty ⇒ `[]` ⇒ no custom phases run; existing sessions are unaffected.

**Parser gotcha:** like every other block-shaped Session Config key, the `custom-phases:` key-line itself MUST NOT carry an inline comment — see § Parser Gotcha: No-Inline-Comment Block Headers (top of this file) for the general `matchBlockHeader` contract. A trailing `# comment` on that exact line means the parser never enters the block and `custom-phases` silently resolves to `[]` — no error, no warning.

The block is a YAML list under a top-level `custom-phases` key:

```yaml
custom-phases:
  - name: eval-learn-aggregate         # required, non-empty, SAFE slug
    when: housekeeping                  # housekeeping | session-end | both (default: session-end)
    command: npm run eval:aggregate     # required; run verbatim — NO interpolation from records
    mode: hard                          # warn | hard | off (default: warn)
    review: docs/eval/last-run.md       # optional; SAFE path; default null
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | — (required) | Phase identifier. Must match `^[A-Za-z0-9._-]+$` (SAFE slug — no spaces, no shell metacharacters). A record missing `name` or carrying an unsafe `name` is dropped with a stderr WARN. |
| `when` | string (`housekeeping` \| `session-end` \| `both`) | `session-end` | Trigger gate against STATE.md `session-type`. `housekeeping` ⇒ only housekeeping sessions; `session-end` ⇒ every non-housekeeping session-type; `both` ⇒ all. Invalid values fall back SILENTLY to `session-end`. |
| `command` | string | — (required) | Shell command run verbatim via Bash. NO value from any record is interpolated. Rejects shell metacharacters (`; $ \` \| & > <`); records with an unsafe `command` (or missing `command`) are dropped with a stderr WARN. |
| `mode` | string (`warn` \| `hard` \| `off`) | `warn` | `off` skips the phase. `warn` runs + reports in the Final Report but never blocks. `hard` + non-zero exit code BLOCKS the close (AskUserQuestion: Fix / Override+log Deviation / Abort). Invalid values fall back SILENTLY to `warn`. **Note:** the blocking value is `hard`, not `strict` — unlike `vault-sync`/`drift-check` (see #217). |
| `review` | string \| null | `null` | Optional repo-relative or absolute file path the coordinator reads as a review step after the command. SAFE-path validated (`^[A-Za-z0-9._~/-]+$`); an unsafe path drops the whole record with a stderr WARN. |

**Security note.** Like the mandatory `test-command` / `typecheck-command` / `lint-command`, a `custom-phases[].command` is executed by the shell and is therefore a command-bearing surface. It is acceptable under the same **VCS-trust-anchor** model: any change to `custom-phases` is commit-gated and visible in `git log` for review. The parser additionally rejects shell metacharacters in `command`/`review`/`name` as a defense-in-depth layer. See `.claude/rules/quality-gates-autofix.md` § "Session Config Command Injection (RCE via shell: true)".

Read by: `scripts/lib/config/custom-phases.mjs` (parser), `skills/session-end/SKILL.md` Phase 2.5 (executor + routing).

**This repo's committed phases.** Two `archive-closed-*` phases are declared in `CLAUDE.md`, both `when: both`, `mode: warn`, both driven by the same generic `scripts/archive-closed-prds.mjs` (archive docs of closed Epics/Issues into the Meta-Vault; fail-closed — skips on unclear Epic state):

- `archive-closed-prds` (#782, Epic #774) — `node scripts/archive-closed-prds.mjs --apply` — archives `docs/prd/` PRDs (defaults).
- `archive-closed-plans` (#786) — `… --apply --prd-dir docs/plans --vault-subdir 01-projects/session-orchestrator/plans` — archives `docs/plans/` executable-plan artefacts of closed features/Epics. The plan's tracking `#NNN` (inline in the plan's `Source:` header, see `skills/write-executable-plan/`) is the anchor this phase reads; a plan with no `#NNN` is never archived (fail-closed `no-epic-ref`).

## Remote Hosts (#1160)

Opt-in declaration of ssh-reachable hosts a heavy wave role may be OFFLOADED to instead of shrinking the wave under local resource pressure. This key only DECLARES: it never probes a host, never dispatches, and never changes a wave by itself. Absent/empty ⇒ `[]` ⇒ every wave stays local, exactly as before.

**Parser gotcha:** like every other block-shaped Session Config key, the `remote-hosts:` key-line itself MUST NOT carry an inline comment — see § Parser Gotcha: No-Inline-Comment Block Headers (top of this file). A trailing `# comment` on that exact line means the parser never enters the block and `remote-hosts` silently resolves to `[]`.

```yaml
remote-hosts:
  - alias: m5                          # required, SAFE slug; reaches argv as `-H <alias>`
    roles-allowed: [test, ui, perf]    # subset of test|ui|perf (default: all three)
    repo-path: ~/Projects/Alice     # optional; SAFE path; default null
    claude-path: ~/.local/bin/claude   # optional; SAFE path; default null
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `remote-hosts` | list | `[]` | The declared hosts, in preference order — the gate takes the FIRST host that accepts the role and is witnessed ready. |
| `alias` | string | — (required) | ssh destination as configured on this host. Must match `^[A-Za-z0-9._-]+$`; it reaches argv as `-H <alias>`. A record missing or failing this is dropped with a stderr WARN. |
| `roles-allowed` | string[] | `[test, ui, perf]` | The `agent-mapping` roles this host accepts. Entries outside `test` / `ui` / `perf` are filtered with a WARN; a record whose list is empty after filtering is dropped. `impl`, `db`, `security`, `compliance` and `docs` work never leaves the local host. |
| `repo-path` | string \| null | `null` | Checkout location on the remote host. SAFE-path validated (`^[A-Za-z0-9._~/-]+$`); an unsafe value drops the whole record with a WARN. |
| `claude-path` | string \| null | `null` | `claude` binary location on the remote host. Same validation as `repo-path`. |

**Two enums, never conflated.** `roles-allowed` holds `agent-mapping` roles (`test`, `ui`, `perf`) — NOT wave roles (`Impl-Core`, `Quality`, …). The wave→role translation is `OFFLOADABLE_WAVE_ROLES` in `scripts/lib/wave-resource-gate.mjs`; a wave role absent from that map is local-only by default.

**Placement contract.** The gate applies its offload arm only after the HR-004 heavy-repo cap, and only when the resource verdict was `reduce` or `coordinator-direct`. It does NOT probe the network: the coordinator supplies a readiness witness (`remoteReady: { m5: true }`, or an async `probeFn`). With no witness, no host counts as ready and the decision stays local — the gate fails toward local, never toward an unverified host. A role in `NEVER_FOREIGN_ROLES` (`scripts/lib/wave-executor/dispatch-common.mjs`) is never offloaded regardless.

**agent-mapping interaction.** A declared alias is what an `agent-mapping` value of the form `<role>: ssh:<alias>` validates against; naming an undeclared host throws at parse time, naming the `ssh` channel with no target throws as for any other channel.

Read by: `scripts/lib/config/remote-hosts.mjs` (parser), `scripts/lib/config.mjs` (`ssh:` channel validation), `scripts/lib/wave-resource-gate.mjs` (placement).

See `skills/remote-offload/SKILL.md` for the wave-executor-side decision rule, the three offload channels, and how a declared alias here is what an `agent-mapping` `ssh:<alias>` value validates against.

## Evolve Extra Sources (#638)

Opt-in EXTRA learning sources for `/evolve`. A domain measurement (e.g. an eval-learn regression harness) runs OUT-OF-BAND and writes a sidecar JSON of regression flags; `/evolve` then READS each declared sidecar and emits a `domain-regression` learning candidate per flag that has persisted across ≥2 consecutive sessions. This is a strict **read-only consumption contract**: `/evolve` never runs the domain measurement — it only consumes the sidecar output. Absent/empty ⇒ `[]` ⇒ no extra sources are read; existing `/evolve` runs are unaffected.

The block is a nested YAML list under a top-level `evolve` key with an `extra-sources` sub-key. The returned config value is exposed as the dotted key `evolve.extra-sources` (mirroring the `cross-repo.projects` precedent), defaulting to `[]`:

```yaml
evolve:
  extra-sources:
    - path: eval/learn/reports/latest.json   # required; SAFE path
      kind: regression-flags                  # enum: regression-flags
      learning-type: domain-regression        # enum: domain-regression
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | — (required) | Repo-relative or absolute path to the sidecar JSON. SAFE-path validated (`^[A-Za-z0-9._~/-]+$`); a record missing `path` or carrying a shell-metacharacter in `path` is dropped with a stderr WARN. The sidecar is schema-gated by `/evolve` against `{ flags: [{ metric, baseline, recent, delta }] }`; an unknown/missing schema ⇒ skip + WARN. |
| `kind` | string (`regression-flags`) | `regression-flags` | Selects the sidecar parser. Only `regression-flags` is defined; an unknown value DROPS the entry with a stderr WARN (schema gate — `/evolve` never guesses a parser). |
| `learning-type` | string (`domain-regression`) | `domain-regression` | Stamps the emitted learning candidate's `type`. Only `domain-regression` is registered (in `LEARNING_TTL_DAYS` and `PROPOSAL_TYPES`); an unknown value DROPS the entry with a stderr WARN. |

**Security note.** `path` is a read-only file path consumed by `/evolve`; it rejects shell metacharacters as a defense-in-depth layer. Confinement at the read sink is the actual path-traversal guard. Changes are commit-gated under the same **VCS-trust-anchor** model as the other path/command-bearing keys.

Read by: `scripts/lib/config/evolve.mjs` (parser), `skills/evolve/SKILL.md` Step 3.1b (read + emit).

## Reconcile (#693 / #696 / #697)

Opt-in configuration for the learning→conditional-rule reconciliation engine (Epic #693). When enabled, the reconciliation engine runs at session-end Phase 3.6.8 and proposes new `.claude/rules/` entries derived from accumulated learnings. The proposal is always operator-AUQ-gated — rules are **never** auto-applied. FA3 (#696) delivers proposals via `AskUserQuestion`; FA4 (#697) adds the guardrail config block documented here. When `enabled: false` (the default), Phase 3.6.8 is a silent no-op and the engine never runs.

All fields live under a top-level `reconcile` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
reconcile:
  enabled: false           # opt-in; Phase 3.6.8 is a no-op when false
  mode: warn               # warn | off
  targets: [repo-local]    # where approved rules are written
  rule-expiry-days: null   # null = per-type TTL (default 60d via deriveExpiresAt)
  confidence-floor: 0.5    # min learning confidence before a learning is eligible
  min-rule-days: 7         # floor on emitted expires-at so a rule is never born-dead
  min-insight-chars: 24    # reject placeholder/minimal insights before rule conversion
  max-proposals-per-run: 10 # volume brake — cap on proposals minted per engine run
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `reconcile.enabled` | boolean | `false` | Master toggle. When `false`, session-end Phase 3.6.8 is a silent no-op — the reconciliation engine never runs. When `true`, the engine evaluates learnings that meet `confidence-floor` and presents rule proposals to the operator via `AskUserQuestion`. Rules are never written without explicit operator approval. Epic #693 FA3 (#696). |
| `reconcile.mode` | string (`warn` \| `off`) | `warn` | Advisory posture. `warn`: proposals surface in the session-end AUQ and the operator may accept or reject each one; accepted proposals are written to `targets`. `off`: advisory surface is suppressed entirely (equivalent to `enabled: false` for the AUQ step, but Phase 3.6.8 may still emit metrics). In both modes, rules are **never** auto-applied — every write is operator-AUQ-gated. |
| `reconcile.targets` | string[] | `["repo-local"]` | Where approved rules are written — a **CLOSED enum**: `repo-local` → `<repoRoot>/.claude/rules/<slug>.md`; `baseline` (#1099) → `<baselineRoot>/proposals/<slug>.md`, where `<baselineRoot>` is `plan-baseline-path` resolved host-locally (`SO_BASELINE_PATH` env > `owner.yaml` `paths.baseline-path` > committed value). Both targets are equally AUQ-gated and advisory — the `baseline` write drops files into `proposals/` in that checkout and commits nothing. This is the rule-write location — it is NOT issue-state or label sync. An **unknown member is DROPPED with a stderr WARN** naming it and the valid set (`scripts/lib/config/reconcile.mjs` `VALID_TARGETS`), never a throw: the parser is tolerant by contract and runs at session-start, where a throw would fail the session on a config typo. `global` (cross-repo) is documented-but-unimplemented and is deliberately NOT a member — admitting a value nothing implements is the same defect class as the unvalidated pass-through this enum replaced. When `baseline` is declared but its root is unresolvable on all three tiers, is still the committed `OVERRIDE-IN-…` placeholder, or is not absolute, `resolveEffectiveTargets()` (`scripts/lib/reconcile/engine.mjs`) drops it with ONE WARN **before** the approval AUQ, so the operator is never asked to approve a write to a destination that cannot exist; a root that does not exist on disk is refused at the writer and is never created. |
| `reconcile.rule-expiry-days` | integer \| null | `null` | Optional override for the TTL stamped into each generated rule's `expires-at` frontmatter. **Default is `null`** — when null or absent, the engine uses per-type TTL (`deriveExpiresAt`, default 60 days). Setting this to a positive integer N forces a flat N-day expiry for all proposals in this repo, overriding per-type TTL. CRITICAL: the default must remain `null` to preserve per-type TTL behaviour; a non-null committed default would silently force flat expiry. |
| `reconcile.confidence-floor` | float | `0.5` | Minimum learning confidence (0.0..1.0) required before a learning is eligible for a rule proposal. Learnings with `confidence < confidence-floor` are skipped by the engine. Bounds: `0.0 ≤ value ≤ 1.0`; out-of-range values silently fall back to `0.5`. Set to `0.0` to surface proposals for all learnings regardless of confidence. |
| `reconcile.min-rule-days` | integer | `7` | Floor (in days) applied to the emitted rule's `expires-at` — issue #741.1. A learning close to its natural per-type TTL expiry could otherwise generate a rule that expires almost immediately ("born-dead"); `computeExpiresAt()` (`scripts/lib/reconcile/emitter.mjs`) floors the result at `now + min-rule-days` so an approved rule always has at least this many days of active life. Mirrors the hardcoded `MIN_RULE_DAYS_DEFAULT` constant in the emitter. Bounds: positive integer; non-finite or ≤0 values fall back to the default. |
| `reconcile.min-insight-chars` | integer | `24` | Minimum `insight` length (characters) required before a learning is eligible for rule conversion — issue #741.2. Opt-in and additive to the always-on placeholder/empty-insight rejection in `classifyLearning()` (`scripts/lib/reconcile/eligibility.mjs`): a non-empty but too-short insight (e.g. a stub or a recovery placeholder) is rejected with reason `placeholder-insight` before it reaches proposal generation. Set to `0` to disable the length check (only the always-on empty/placeholder-regex check applies). |
| `reconcile.max-proposals-per-run` | integer | `10` | Volume brake — issue #900 D. After the eligibility filter runs, `runReconcile()` (`scripts/lib/reconcile/engine.mjs`) sorts eligible learnings by confidence DESC and proposes at most this many per run; the rest are recorded as `capped` rejections (visible in `summary.capped` and each carrying a `capped — ...` reason) rather than silently dropped. Both production call sites — the session-end Phase 3.6.8 dispatcher (`decideReconcile()` in `scripts/lib/session-end/phase-skip.mjs`) and the on-demand `/reconcile` command (`skills/reconcile/SKILL.md`) — forward this Session Config value to `runReconcile()` as `maxProposalsPerRun`. The brake is **always active** even beyond that: a caller that omits the parameter entirely (e.g. a direct programmatic `runReconcile()` call) still gets the engine's own internal default, which mirrors the Session Config parser's default of `10`. Bounds: positive integer (≥ 1); malformed, absent, or non-positive values fall back to `10`. |

### Never-always-on invariant

Generated rules carry a `globs:` frontmatter key (path-scoped conditional loading) and are **never** emitted with `always-on: true`. The engine throws if a proposal would produce an always-on rule — this is an FA3 invariant enforced in `scripts/lib/reconcile/emitter.mjs`. Background: always-on rules accumulate in the coordinator context regardless of path scope and count toward the instruction-budget ceiling (`instruction-budget.ceiling`, issue #687 / see [Instruction Budget](#instruction-budget-687) above). Allowing the reconciler to generate always-on rules would be a vector for unchecked instruction-budget growth.

### Cross-references

- Engine: `scripts/lib/reconcile/` (eligibility, emitter, renderer, idempotency, engine)
- Session-end Phase 3.6.8: `skills/session-end/SKILL.md` — gated on `reconcile.enabled: true`
- Resolver: `scripts/lib/config/reconcile.mjs`
- `/reconcile` command: `skills/reconcile/SKILL.md` (on-demand invocation)
- Epic #693 (reconciliation engine umbrella), FA3 #696 (advisory delivery), FA4 #697 (guardrails + this config block)
- Issue #741.1 (`min-rule-days` born-dead floor) / #741.2 (`min-insight-chars` placeholder gate)
- Instruction-budget guard: [Instruction Budget](#instruction-budget-687) (`instruction-budget.ceiling`, issue #687) — the never-always-on invariant protects this ceiling from reconciler-driven growth
- Rule-authoring cross-reference: [`docs/rule-authoring.md`](rule-authoring.md#learning-type-taxonomy-ttl--provenance-standard-issue-723-b6--733) § "Learning Type-Taxonomy, TTL & Provenance Standard" — the type-taxonomy registry these config keys tune

**Used by:** `scripts/lib/config/reconcile.mjs` (parser), `scripts/lib/reconcile/engine.mjs` (engine), `skills/session-end/SKILL.md` Phase 3.6.8.

## STATE.md Schema §Recommendations (v1.1)

> Added by Epic #271 Phase A (issues #272–#275). **Additive** — `schema-version` remains `1`. Absence of all 5 fields is a valid `schema-version: 1` STATE.md meaning "no recommendation available" (pre-v1.1 compatibility). Readers MUST treat missing fields identically to explicit nulls.

Session-end Phase 3.7a is the **only writer** of these fields. Session-start Phase 1.5 is the reader (renders a one-line banner on `status: completed`). Phase B Mode-Selector (planned) will consume these fields as its primary input.

### Fields

| Field | Type | Value range | Description |
|-------|------|-------------|-------------|
| `recommended-mode` | string | `housekeeping` \| `feature` \| `deep` \| `discovery` \| `evolve` \| `plan-retro` | v0 heuristic output: suggested mode for the next session. |
| `top-priorities` | integer[] | 0–5 entries | Carried-over issue IIDs, pre-sorted (priority::critical/high first, FIFO tiebreak). |
| `carryover-ratio` | float | `0.00`–`1.00` | `carryover_count / planned_issues` (0 when planned=0). Rounded to 2 decimals. |
| `completion-rate` | float | `0.00`–`1.00` | `completed_issues / planned_issues`. Rounded to 2 decimals. |
| `rationale` | string | ≤ 120 chars, single line | Which v0 rule branch fired (e.g. `"v0: completion <50% → retro"`). |

### Example frontmatter

```yaml
---
schema-version: 1
session-type: deep
branch: main
issues: [272, 273, 274, 275]
started_at: 2026-04-24T18:10:00+02:00
status: completed
current-wave: 5
total-waves: 5
recommended-mode: feature
top-priorities: [278, 283, 285]
carryover-ratio: 0.00
completion-rate: 1.00
rationale: "v0: default clean completion"
---
```

### v0 heuristic (deterministic)

Evaluated in order; first match wins:

1. `completion_rate < 0.50` → `plan-retro` (rationale: `v0: completion <50% → retro`)
2. `carryover_ratio >= 0.30` → `deep` (rationale: `v0: carryover ≥30% → deep`)
3. otherwise → `feature` (rationale: `v0: default clean completion`)

Implementation: `scripts/lib/recommendations-v0.mjs` → `computeV0Recommendation()`. Deterministic — same inputs always produce same output. Phase B will replace this with a learnings-driven selector; the contract (5 fields, same types) stays stable.

### Backward compatibility

- Pre-v1.1 STATE.md files (produced by sessions before Epic #271 shipped) simply do not contain these fields. The parser returns `null` from `parseRecommendations`; the banner silently no-ops.
- `schema-version` is NOT bumped to `1.1` in the frontmatter — the existing `schema-version: 1` remains canonical. The v1.1 label is documentation-only, describing the additive surface.
- Idle Reset (session-start Phase 1.5) archives these fields into the `## Previous Session` body block of STATE.md as a human-readable block, then removes them from the frontmatter — so a fresh session never inherits stale recommendations in its live frontmatter.

### Reader behavior

The banner renders with one of the following shapes:

- **All 5 fields present, `top-priorities` non-empty:**
  ```
  📋 Previous session recommended: deep — v0: carryover ≥30% → deep (completion: 85%, carryover: 40%)
    Suggested issues: #272, #273, #274
  ```
- **All 5 fields present, `top-priorities` empty:** banner line only (no "Suggested issues" line).
- **Partial fields (1–4 present):** banner still renders; missing numeric fields display as `—`; WARN event `state-md-partial-recommendation` written to `.orchestrator/metrics/sweep.log`.
- **`top-priorities` type-mismatch** (not an array): field treated as null; WARN `state-md-type-mismatch` written to sweep.log; other fields still render.
- **Unknown `recommended-mode`:** banner shows `(unknown-mode)` instead of the string.
- **Pre-v1.1 STATE.md (no fields at all):** silent no-op, no banner, no WARN.

### Consumer cross-reference

- **Writer:** `skills/session-end/SKILL.md` § Phase 3.7a "Compute and Write Recommendations" (runs after Phase 3.7 sessions.jsonl write, before Phase 3.4 `status: completed` setting).
- **Reader:** `skills/session-start/SKILL.md` § Phase 1.5 "Recommendations Banner" (renders on `status: completed` branch only).
- **Archival:** `skills/session-start/SKILL.md` § Idle Reset rule 6 (removes fields from frontmatter, prepends readable block to `## Previous Session`).
- **Future consumer:** Phase B Mode-Selector skill (planned in Epic #271) will read these fields as the primary input for autonomous mode selection.

## Frontend-Slop Hook (#684)

Opt-in configuration for the frontend-slop detector hook. When enabled, the `PostToolUse` hook runs the deterministic frontend-slop detector (`scripts/lib/frontend-detect/detect.mjs`) on a UI file right after it is edited and surfaces findings as a `hookSpecificOutput.additionalContext` roll-up. **Warn-only / non-blocking** — it never blocks an edit. The Hook Runtime Profile Control gate (below) also applies, so the hook can be silenced via the standard profile env-vars even when `enabled: true`. Default OFF — opt-in by design (unlike `loop-guard`, which defaults on). Epic #684 P1.

All fields live under a top-level `frontend-slop-hook` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`):

```yaml
frontend-slop-hook:
  enabled: false           # opt-in; PostToolUse warn-only / non-blocking
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `frontend-slop-hook.enabled` | boolean | `false` | Master toggle for the frontend-slop PostToolUse hook. Only an explicit `enabled: true` enables it; any other value (or an absent block) resolves to disabled. When `true`, the hook fires after `Edit`/`Write`/`MultiEdit` on UI files, runs the deterministic detector, and emits findings as `additionalContext` (warn-only, never blocks). Profile-gate also applies. Issue #684. |

**Used by:** `hooks/post-tooluse-frontend-slop.mjs` (parser/loader: `scripts/lib/config/frontend-slop-hook.mjs`).

**Cross-reference:** detector rule markers (`<!-- rule:<id> -->`) live in `.claude/rules/frontend.md` (Absolute Bans / Motion / Layout sections). Mirrors the opt-in / default-on contrast against `loop-guard`.

## Loop Guard (#619)

Always-on `PostToolUse` guard that maintains a per-session ring buffer of recent `{tool, argsHash}` pairs and injects an `additionalContext` loop-warning when the same (tool + args) call recurs `threshold` or more times within the last `window` tool calls. Warn-only / non-blocking — it never stops a tool call, it only surfaces a hint. The Hook Runtime Profile Control gate (below) also applies, so the hook can be silenced via the standard profile env-vars even when `enabled: true`. Default ON — the contrast case for `frontend-slop-hook` (above), which defaults off.

All fields live under a top-level `loop-guard` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
loop-guard:
  enabled: true                        # on by default; warn-only, non-blocking; profile-gate also applies
  threshold: 3                         # identical (tool+argsHash) calls within window before a loop-warning fires
  window: 5                            # ring-buffer size (recent tool calls tracked per session)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `loop-guard.enabled` | boolean | `true` | Master toggle. Only an explicit `enabled: false` disables the hook — any other value (or an absent `enabled` line inside a present block) leaves it on. |
| `loop-guard.threshold` | integer (≥ 2) | `3` | Number of identical `{tool, argsHash}` calls within `window` before a loop-warning fires. Non-integer or below-minimum values fall back to the default. |
| `loop-guard.window` | integer (≥ 2) | `5` | Ring-buffer size — how many recent tool calls are tracked per session. Non-integer or below-minimum values fall back to the default. Self-healing clamp: a `window` smaller than `threshold` is silently widened to `threshold` (a shorter ring could never recur `threshold` times, so the guard would never fire). |

**Used by:** `hooks/loop-guard.mjs`, `scripts/lib/config/loop-guard.mjs` (`_parseLoopGuard`). Issue #619.

## Config Protection (#622)

`PreToolUse` `Edit`/`Write` guard that intercepts edits to a small allow-list of quality-gate config files (eslint, vitest, tsconfig, prettier, commitlint, gitleaks) and warns — or, in `strict` mode, blocks — when an edit LOOSENS a gate (a threshold lowered, a disable/ignore directive added, a rule removed, a gitleaks allowlist widened, tsconfig strictness relaxed). The edit-tool analogue of the test-the-mock gate-cheating anti-pattern (see `.claude/rules/testing.md`). First-time file creation, tightening edits, and neutral edits are always allowed regardless of mode.

All fields live under a top-level `config-protection` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
config-protection:
  enabled: true                        # PreToolUse guard: warn when an Edit/Write loosens a quality gate
  mode: warn                           # warn (stderr + event, exit 0) | strict (block loosening edits, exit 2)
allow-config-weakening: false          # per-session bypass (mirrors allow-destructive-ops); top-level, NOT nested under config-protection
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `config-protection.enabled` | boolean | `true` | Master toggle. Only an explicit `enabled: false` disables the guard — any other value (or an absent `enabled` line inside a present block) leaves it on. |
| `config-protection.mode` | `warn` \| `strict` | `warn` | `warn` emits a stderr message + an event, exit code 0 (never blocks). `strict` blocks the loosening `Edit`/`Write` with exit code 2. Any value other than `strict` resolves to `warn`. |
| `allow-config-weakening` | boolean | `false` | Top-level key (NOT nested under `config-protection`) — a per-session bypass mirroring `allow-destructive-ops`. When `true`, the guard is bypassed for the entire session — for intentional config-weakening changes (e.g. deliberately relaxing a rule as planned work). |

**Used by:** `hooks/config-protection.mjs`, `scripts/lib/config/config-protection.mjs` (`_parseConfigProtection`, `_isConfigWeakeningAllowed`). Issue #622.

## Instruction Budget (#687)

Always-on directive-budget banner. At session-start Phase 4 the probe (`scripts/lib/instruction-budget-guard.mjs`, `checkInstructionBudget`) sums the structural directives (bullets, ordered items, headings ≥ depth 2 — fenced code and YAML frontmatter excluded) across the always-on `.claude/rules/*.md` files (membership delegated to `rule-loader.mjs`; glob-scoped rules excluded) and renders a **warn-only / non-blocking** banner when the total **exceeds** `ceiling`. It is a *growth-ratchet*: the current baseline (~457 structural directives across 11 always-on rules) sits under the default ceiling of `480`, so the banner is silent today and only fires when NEW always-on directives push the count over the ceiling — "mechanism over discipline". Default ON (this is a guard, not an opt-in feature) — set `enabled: false` or `mode: off` to silence it.

**Two axes, not one (#931a).** Since the byte dimension shipped in #877 it was measured but never judged: `overBudget` followed from the directive count alone, and the banner text never named a byte. It now reads `overDirectiveBudget || overByteBudget`, and the banner names only the axis that actually broke (re-sorting the top-files list by bytes when bytes were the trigger, because the count ordering points at the wrong file).

| Key | Default | Meaning |
|---|---|---|
| `instruction-budget.ceiling` | `480` | Structural-directive ceiling. Baseline ~457, i.e. +5% headroom. |
| `instruction-budget.byte-ceiling` | `114000` | Byte ceiling over the same always-on corpus. Baseline 108,589 measured 2026-07-30, i.e. the same +5% headroom — the two axes are calibrated alike so neither is accidentally the stricter one. |

Why both: a 9 KB prose rule carrying three bullets is nearly invisible to the directive count while consuming real prompt payload. Why the headroom rather than the measured value: a ceiling that reddens the current state is switched off within a session and then measures nothing.

All fields live under a top-level `instruction-budget` object inside the `## Session Config` block of your host file (`CLAUDE.md` or `AGENTS.md`):

```yaml
instruction-budget:
  enabled: true            # default on (growth-ratchet guard)
  ceiling: 480             # structural-directive ceiling
  mode: warn               # warn (surface banner) | off (silent no-op)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `instruction-budget.enabled` | boolean | `true` | Master toggle. `false` → the Phase 4 probe returns `null` (no banner). Default on because this is a structural-drift guard, not an opt-in feature. Issue #687. |
| `instruction-budget.ceiling` | integer | `480` | Structural-directive ceiling. The banner fires only when the always-on count **strictly exceeds** this. The default `480` is an operator-chosen ratchet just above the ~457 baseline, leaving headroom for normal edits while catching unchecked growth. A config value `≤ 0` falls back to the default. |
| `instruction-budget.mode` | `warn` \| `off` | `warn` | `warn` surfaces the banner alongside the other Phase 4 banners; `off` is a silent no-op (equivalent to `enabled: false`). Any value other than `off` resolves to `warn`. |

**Behaviour on config-load failure:** if no instruction file is found (or it is unreadable), the probe falls back to `{ enabled: true, ceiling: 480, mode: warn }` and still computes — graceful, like the other session-start probes. The wrapper never throws.

**Why a ratchet, not in-repo glob-respecting injection:** the Claude Code harness injects ALL `.claude/rules/*.md` into the coordinator context regardless of each rule's `globs:` frontmatter (`rule-loader.mjs` governs only the PER-WAVE surface). The repo cannot make the harness respect `globs:` for coordinator injection — see "Instruction-Budget Mechanism — Coordinator-Injection Verdict" (#687; archived in the private Meta-Vault). The directive-budget ratchet is therefore the one in-repo, mechanism-over-discipline lever; physically trimming/merging rule files is tracked separately in #688.

**Used by:** session-start Phase 4 (`skills/session-start/SKILL.md`). Probe: `scripts/lib/instruction-budget-guard.mjs`.

## Hook Runtime Profile Control (#211)

Control which hooks run at runtime via environment variables — no settings-file edits required.

### Environment variables

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `SO_HOOK_PROFILE` | `full` \| `minimal` \| `off` | `full` | Preset bundle that enables/disables groups of hooks. |
| `SO_DISABLED_HOOKS` | Comma-separated hook names | _(none)_ | Disable individual hooks regardless of profile. |

### Profile bundles

| Profile | Enabled hooks |
|---------|--------------|
| `full` | All hooks (default — no behaviour change when env unset) |
| `minimal` | `on-session-start`, `pre-bash-destructive-guard` only |
| `off` | No hooks |

### Precedence

`SO_DISABLED_HOOKS` takes precedence over `SO_HOOK_PROFILE` for the listed names. Unknown `SO_HOOK_PROFILE` values fall back to `full` with a single stderr warning.

### Examples

```bash
# Disable all hooks for a quick one-shot run
SO_HOOK_PROFILE=off claude ...

# Keep only the safety guard active
SO_HOOK_PROFILE=minimal claude ...

# Disable only the typecheck-on-save hook, keep everything else
SO_DISABLED_HOOKS=post-edit-validate claude ...

# Disable two hooks independently
SO_DISABLED_HOOKS=enforce-scope,enforce-commands claude ...
```

### Hook name reference

| Hook name | hooks.json event |
|-----------|-----------------|
| `on-session-start` | SessionStart |
| `pre-bash-destructive-guard` | PreToolUse/Bash |
| `enforce-commands` | PreToolUse/Bash |
| `enforce-scope` | PreToolUse/Edit\|Write |
| `post-edit-validate` | PostToolUse/Edit\|Write |
| `post-bash-write-verify` | PostToolUse/Bash |
| `on-stop` | Stop + SubagentStop |

### Implementation

Each hook handler imports `shouldRunHook` from `hooks/_lib/profile-gate.mjs` at the top level and calls `process.exit(0)` immediately when gated off. The exit is silent (no stdout, no stderr), so Claude Code sees an allow as if the hook had never run.

## Webhooks (#228)

Opt-in webhook notifications delivered by `scripts/lib/webhook-url.mjs`. The helper centralizes URL resolution so no personal-domain default ever silently fires — callers must supply a URL explicitly.

### Resolution order

For every supported kind the resolver checks sources in this order; the first non-empty string wins:

1. **Environment variable** `SO_WEBHOOK_<KIND>_URL` — uppercase kind, hyphens → underscores  
   e.g. `SO_WEBHOOK_SLACK_URL`, `SO_WEBHOOK_GITLAB_PIPELINE_STATUS_URL`
2. **Session Config** `webhooks.<kind>.url`
3. **Error** — `WebhookConfigError` is thrown. No silent personal-domain fallback.

### Supported kinds

| Kind | Env variable | Config key |
|------|-------------|------------|
| `slack` | `SO_WEBHOOK_SLACK_URL` | `webhooks.slack.url` |
| `discord` | `SO_WEBHOOK_DISCORD_URL` | `webhooks.discord.url` |
| `generic` | `SO_WEBHOOK_GENERIC_URL` | `webhooks.generic.url` |
| `gitlab-pipeline-status` | `SO_WEBHOOK_GITLAB_PIPELINE_STATUS_URL` | `webhooks.gitlab-pipeline-status.url` |

### Session Config example

```yaml
webhooks:
  slack:
    url: https://hooks.slack.com/services/REDACTED/REDACTED/REDACTED
  discord:
    url: https://discord.com/api/webhooks/REDACTED/REDACTED
  generic:
    url: https://example.com/hooks/session-events
  gitlab-pipeline-status:
    url: https://gitlab.example.com/hooks/pipeline
```

### Clank Event Bus (events.mjs / on-stop.mjs)

The internal Clank Event Bus webhook is controlled by two environment variables:

| Variable | Purpose |
|----------|---------|
| `CLANK_EVENT_SECRET` | Bearer token. **Required** — if absent, no POST is made. |
| `CLANK_EVENT_URL` | Target base URL. **Required** — if absent, no POST is made (no personal-domain default). |

Both variables must be set for the fire-and-forget POST to fire. Setting only `CLANK_EVENT_SECRET` without `CLANK_EVENT_URL` is a safe no-op.

## Express Path (#214)

Codified coordinator-direct flow for housekeeping and simple single-issue sessions. When the express path activates, session-start Phase 8.5 skips the full 5-wave plan decomposition and runs all tasks directly as the coordinator — no subagents dispatched, no inter-wave checkpoints.

> **Historical context:** The 13 coordinator-direct sessions documented in the project `CLAUDE.md` (2026-04 series: vault-mirror GH#31, phased-rollout #307, v3.2.0 release, Architecture-DDD-Trio, etc.) were running this pattern implicitly without a codified path. Issue #214 codifies it so that future housekeeping sessions gain the express path automatically without needing to know to opt in manually.

All fields live under a top-level `express-path` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
express-path:
  enabled: true   # default true; set false to always use the full 5-wave flow
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `express-path.enabled` | boolean | `true` | When `true`, session-start Phase 8.5 evaluates the express-path activation conditions. When `false`, the evaluation is skipped and the full session-plan 5-wave flow always runs. |

### Activation conditions

All three conditions must be true simultaneously for the express path to activate:

1. `express-path.enabled: true` (default)
2. Session type is `housekeeping` (confirmed in session-start Phase 8 Q&A)
3. Agreed issue scope is ≤ 3 issues AND no parallel agents are required

When any condition is false, the full 5-wave flow runs as before — the check is a transparent no-op.

### What changes when express path is active

- **session-start:** After Phase 8 Q&A, Phase 8.5 runs `node scripts/express-path.mjs` (the canonical caller — it makes the decision and records `orchestrator.express_path.evaluated` on refusal as well as activation, #1146), which emits the `"Express path activated — N tasks, coordinator-direct, no inter-wave checks."` banner. Tasks are then executed directly as the coordinator. session-plan is called but receives the express-path signal.
- **session-plan:** Detects the banner in conversation context and emits a minimal 1-wave `coordinator-direct` plan (0 agents dispatched). Skips all role decomposition, complexity scoring, and wave splitting.
- **STATE.md:** Activation is logged in the `## Deviations` section for traceability.
- **Inter-wave checkpoints:** Skipped entirely — no Discovery → Impl-Core → Quality pipeline.

### When to disable

Set `express-path.enabled: false` when:

- You want all housekeeping sessions to go through the standard quality-gate pipeline (Discovery + Quality waves).
- The session involves ≥ 4 issues (the scope check already prevents activation, but disabling makes the intent explicit).
- You are running an automated `/autopilot` loop and want predictable wave counts across session types.

### Condition matrix

| Session type | Issue count | `express-path.enabled` | Parallel agents? | Activates? |
|---|---|---|---|---|
| `housekeeping` | 1–3 | `true` | No | **Yes** |
| `housekeeping` | 4+ | `true` | No | No — scope too large |
| `housekeeping` | 1–3 | `false` | No | No — opted out |
| `feature` | 1–3 | `true` | No | No — not housekeeping |
| `housekeeping` | 1–3 | `true` | Yes | No — parallel agents required |

**Related skills and files:**
- `scripts/express-path.mjs` — the CLI Phase 8.5 runs; `scripts/lib/express-path.mjs` holds the decision + its `orchestrator.express_path.evaluated` record
- `skills/session-start/SKILL.md` — Phase 8.5: Express Path Evaluation (activation logic + banner)
- `skills/session-plan/SKILL.md` — Express Path Short-Circuit section (1-wave plan emission)
- GitLab issue `#214` (foundation and codification)

## Autopilot Multi-Story (#431)

Opt-in configuration for `autopilot --multi-story` (`scripts/autopilot-multi.mjs`). Controls how parallel story pipelines are isolated when N stories run concurrently. Projects that do not use `--multi-story` leave this block unset and are unaffected.

All fields live under a top-level `autopilot` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
autopilot:
  bg-isolation: worktree   # worktree | none (default: worktree)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `autopilot.bg-isolation` | `worktree` \| `none` | `worktree` | Isolation mode for concurrent story pipelines. `worktree` (default): each story creates its own git worktree — safe for parallel writes, costs disk space and EnterWorktree latency. `none`: no worktrees; sub-sessions spawn directly in the main working tree — faster for monorepos with heavy build state but requires explicit file-scope deconfliction (see below). |

**`bg-isolation: none` hard-error guard:** when `bg-isolation: none` AND `--max-stories > 1`, `autopilot-multi` requires `--deconflict-paths=<glob>` on the CLI to confirm that per-story file ownership is planned. Omitting the flag exits with code 1. This enforces the parallel-session discipline defined in `.claude/rules/parallel-sessions.md` PSA-001/002/003 — two agents editing the same file in the main tree simultaneously will corrupt each other's work.

**Feature introduced by:** GitLab issue #431 (CC 2.1.143 `worktree.bgIsolation` changelog adoption). Implementation: `scripts/autopilot-multi.mjs` reads `config?.autopilot?.['bg-isolation']` via `scripts/parse-config.mjs`. Documentation: `skills/autopilot/SKILL.md` § Configuration.

## Wave Reviewers

Opt-in inter-wave architecture/QA/PRD audit dispatch. When configured, wave-executor's `### 5a. Persona-reviewer dispatch` step (Impl-Core and Impl-Polish waves only — Discovery, Quality, and Finalization are skipped) fans out the named code-oriented reviewer agents in parallel with read-only scope after the wave's own work completes. Findings are **advisory only** — a `WARN` or `FAIL` never blocks the wave; it is surfaced in the wave progress summary and fed into the next wave's agent assignments, or logged as an overridden Deviation (#730/H5) when not actioned.

All fields live under a top-level `wave-reviewers` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
wave-reviewers:
  enabled: false            # opt-in inter-wave architecture/QA/PRD audits
  reviewers: []             # ["architect-reviewer", "qa-strategist", "analyst"]
  mode: warn                # warn | strict | off
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `wave-reviewers.enabled` | boolean | `false` | Master toggle. Absent, `false`, or an empty `reviewers` array all resolve to the same no-op — the dispatch step is skipped entirely and the wave loop proceeds exactly as before. |
| `wave-reviewers.reviewers` | string[] | `[]` | Reviewer agent names to dispatch in parallel. Plugin-provided values: `architect-reviewer`, `qa-strategist`, `analyst`. Custom reviewer agents under `agents/` are also valid if their `name` frontmatter matches. Each name is dispatched via `Agent({ subagent_type: "session-orchestrator:<reviewer-name>", ... })` with read-only scope. |
| `wave-reviewers.mode` | string (`warn` \| `strict` \| `off`) | `warn` | Parsed but currently only `enabled` + a non-empty `reviewers` array gate the dispatch step in `skills/wave-executor/wave-loop.md`; `mode` is reserved for future escalation behaviour (e.g. blocking on `FAIL`). |

**Deprecated alias:** `persona-reviewers` is accepted as a backward-compatible alias. When only `persona-reviewers` is present, its values are used and a deprecation WARN is emitted to stderr; when both keys are present, `wave-reviewers` wins and the WARN still fires. Issue #461/#478.

**Distinct from `persona-gate-wave`** (below): `wave-reviewers` dispatches code-oriented reviewer agents (`architect-reviewer`, `qa-strategist`, `analyst`) that judge implementation correctness; `persona-gate-wave` dispatches catalog domain/buyer/audit personas from `.claude/personas/` that judge audience fit. The two keys are independent and may both be configured on the same project without conflict.

**Used by:** `scripts/lib/config/wave-reviewers.mjs` (`_parseWaveReviewers`), `scripts/lib/config.mjs`, `skills/wave-executor/wave-loop.md` § 5a.

## Persona-Gate Wave (#458)

Opt-in mid-wave hook that dispatches a `/persona-panel`-style review after a configured wave completes (Quality or Impl-Polish). Distinct from `wave-reviewers` (which targets code-oriented reviewer agents like `architect-reviewer` and `qa-strategist`): `persona-gate-wave` dispatches catalog personas from `.claude/personas/` — domain-experts, buyer-personas, and auditors. The two keys are independent; a project may configure both on the same wave without conflict.

When enabled, wave-executor runs `### 3b. Persona-Gate Hook` after the wave's STATE.md update and before the progress summary. The consolidated panel verdict is written to a JSON sidecar under `.orchestrator/persona-panel/<iso>-<runId>.json` (validated against `agents/schemas/persona-panel-sidecar.schema.json`). On `mode: 'strict'` with a non-PROCEED verdict, the operator is prompted via `AskUserQuestion` to proceed, revise the remaining waves, or abort the session.

All fields live under a top-level `persona-gate-wave` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
persona-gate-wave:
  enabled: false               # opt-in; default false preserves existing behavior
  after: quality               # quality | impl-polish — wave name after which to fire
  threshold: "all"             # "M-of-N" | "all" | "N-of-N" — passed to parseThreshold
  personas: []                 # list of persona names from .claude/personas/; empty = all catalog
  dispatch-model: claude-opus-4-7   # alias or full model ID — default 'claude-opus-4-7'
  mode: off                    # off | warn | strict
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `persona-gate-wave.enabled` | boolean | `false` | Master toggle. When `false` (or the block is absent), the hook is skipped entirely — wave-executor proceeds from `### 3a` to `### 4` without dispatching personas. |
| `persona-gate-wave.after` | string (`quality` \| `impl-polish`) | `quality` | The wave role after which the hook fires. The hook runs once per session, immediately after the named wave's STATE.md update. |
| `persona-gate-wave.threshold` | string | `"all"` | Voting threshold passed to `parseThreshold()` from `scripts/lib/persona-panel/threshold.mjs`. Accepts `"all"`, `"any"`, or `"M-of-N"` where `1 ≤ M ≤ N ≤ 20`. Example: `"6-of-6"` requires every persona to vote PASS; `"4-of-6"` allows two dissenters. |
| `persona-gate-wave.personas` | string[] | `[]` | Roster of persona names to dispatch. Each entry must match `^[a-z0-9-]{1,64}$` and refer to a persona file under `.claude/personas/<name>.md`. When the list is empty (default), every persona in the catalog is dispatched. |
| `persona-gate-wave.dispatch-model` | string | `claude-opus-4-7` | Model used for each persona agent dispatch. Accepts the same shape as agent frontmatter `model:` — one of `inherit` \| `sonnet` \| `opus` \| `haiku`, or a full model ID like `claude-opus-4-7`. |
| `persona-gate-wave.mode` | string (`off` \| `warn` \| `strict`) | `off` | Behaviour on consolidator result. `off` skips dispatch entirely even when `enabled: true` (silent no-op). `warn` consolidates and logs findings under a `Persona-gate:` bullet in the wave progress update without blocking. `strict` consolidates and on any non-PROCEED verdict prompts the operator via `AskUserQuestion` to proceed-as-is, revise remaining waves, or abort. |

**Validation:**
- An `enabled: true` + `mode: off` combination is degenerate — `parseSessionConfig` emits a single stderr WARN at load time so the operator can spot the configuration drift, but the hook itself is a no-op.
- `threshold` is parsed via `parseThreshold()` at config-load time; a malformed spec (e.g. `"21-of-21"`, `"5/5"`, empty string) raises a precise error before wave-executor even starts.

### When to enable

The canonical use case is the **Buyer-Panel pattern** from a flagship product's W5 hard-gate: six buyer personas evaluate UI/UX work at the end of every Quality wave, with `threshold: "6-of-6"`, `mode: 'strict'`, and `after: 'quality'`. Any dissent pauses the session and surfaces the dissenters' rationale via `AskUserQuestion` before commit — UI changes that would dilute a target persona's experience are caught before they ship.

Enable when:
- Domain or audience perspective is load-bearing for the work (UX, marketing pages, on-boarding flows, persona-specific feature releases).
- Code-level review (`wave-reviewers`) is insufficient — the question is "does this work serve persona X?", not "is the implementation correct?".
- A small, stable set of persona files (2–10) live under `.claude/personas/` and the catalog rarely changes mid-session.

Leave disabled (default) when:
- The project has no persona files or the work is purely infrastructural.
- The wave's deliverable is server-side / backend-only and persona evaluation would be noise.

**Related skills and files:**
- `commands/persona-panel.md` — standalone `/persona-panel` command for ad-hoc panel runs (not gated on `persona-gate-wave.enabled`).
- `skills/persona-panel/SKILL.md` — full skill spec (catalog format, consolidation modes, sidecar shape).
- `skills/wave-executor/wave-loop.md` § 3b — the wave-executor hook contract.
- `agents/schemas/persona-panel-sidecar.schema.json` — sidecar JSON Schema enforced before write.

## Skill Evolution (#646)

Opt-in configuration for the Skill Self-Evolution Foundation (Epic #643, Sub-issue #646). Controls whether `/evolve` surfaces skill health signals for operator review only (`advisory`) or additionally applies deterministic repairs to local config artifacts behind an evidence gate (`autonomous-gated`). The default is `off` — no behavior change for repos that omit this block.

All fields live under a top-level `skill-evolution` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
skill-evolution:
  autonomy: off            # off | advisory | autonomous-gated — default off (opt-in)
  evidence-floor: 0.5      # float 0.0..1.0 — min evidence before autonomous-gated repair acts
  judge: false             # opt-in session-end LLM-judge for advisory L3; default false
  judge-budget-tokens: 8000 # token budget for the L3 judge dispatch; default 8000
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `skill-evolution.autonomy` | string (`off` \| `advisory` \| `autonomous-gated`) | `off` | Master autonomy mode. `off`: feature inactive, no skill-health signals surfaced. `advisory`: `/evolve` surfaces a session-end skill-health summary (D-token rollup, telemetry gaps, A/B experiment deltas) for operator review — no automated edits. `autonomous-gated`: surfaces the advisory summary AND applies repairs that clear the `evidence-floor` gate to the repo's own local config artifacts (Session Config fields, local skill overrides). Plugin-level and remote skill repairs are always MR-only regardless of this setting. |
| `skill-evolution.evidence-floor` | float | `0.5` | Minimum evidence score (0.0..1.0) required before an `autonomous-gated` repair is applied without operator confirmation. Repairs below the floor are surfaced as advisory suggestions only. Bounds: `0.0 ≤ value ≤ 1.0`. Out-of-range values silently fall back to the default. Only evaluated when `autonomy: autonomous-gated`. |
| `skill-evolution.judge` | boolean | `false` | When `true`, session-end (Phase 3.6.6) dispatches a bounded **read-only** haiku LLM-judge that reads the transcript tail and emits advisory per-skill `applied`/`completed` judgments (L3). The judge RETURNS JSON; the coordinator writes the `.orchestrator/metrics/skill-judgments.jsonl` sidecar (#614-safe — the read-only agent never writes its own sidecar). Adds one subagent call per session-end when enabled. Advisory only — every judgment carries a schema-enforced `advisory: true` and provably cannot reach a C2 repair gate. |
| `skill-evolution.judge-budget-tokens` | integer | `8000` | Token budget for the L3 judge dispatch (`runSkillJudge`). The budget gate fires BEFORE dispatch: if the built prompt's estimated input exceeds this, the judge is skipped (`status: budget-exceeded`) rather than truncated. Non-positive or non-integer values silently fall back to `8000`. Only evaluated when `judge: true`. |

**Used by:** `skills/evolve/SKILL.md` (skill-health summary step), `scripts/lib/config/skill-evolution.mjs` (parser), `scripts/lib/skill-judge.mjs` (L3 judge), `scripts/lib/skill-judgments-schema.mjs` (sidecar schema), `skills/session-end/SKILL.md` § Phase 3.6.6 (judge dispatch + coordinator-write).

**Cross-reference:** "Skill Self-Evolution Foundation (OpenSpace-inspired)" (#643; archived in the private Meta-Vault), Sub-issue #646.

**Parity note.** The `skill-evolution:` key is documented in `docs/session-config-template.md` as a **standalone `## Skill Evolution` section** outside the `## Session Config` block — intentionally parity-exempt from `claude-md-drift-check` Check-6. Adding it as a column-0 key inside `## Session Config` would hard-fail every repo with `drift-check.mode: hard` that has not yet adopted the feature.

**Root instruction-file activation capture (#652).** This repo's own `## Skill Evolution` block records why the feature was armed (`autonomy: autonomous-gated`) here specifically: the engine was activated for this repo (#652) after the C2 engine (#647/#651) plus the H1 `evidence_kind` guard (session-3) made autonomous-apply safe. Under that gate, the engine may auto-apply ONLY the `command-count` drift shape on the root instruction file, behind the quadruple condition (autonomy ∧ safe-posture ∧ gate-green ∧ evidence ≥ evidence-floor) AND only for `filesystem-fact`-sourced candidates. Plugin-level, local-skill, and remote-skill repair targets are ALWAYS MR-only regardless of this setting.

## Dispatcher Autonomy (#679)

Opt-in configuration for the cross-repo free-repo dispatcher autonomy gate (Epic #673, Sub-issue #679). Controls whether the `/dispatcher` flow runs in advisory mode (surfaces ranked candidates for operator review only) or applies dispatch decisions behind a confidence gate. The default is `off` — fail-closed, no behavior change for repos that omit this block.

All fields live under a top-level `dispatcher-autonomy` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
dispatcher-autonomy:
  autonomy: off            # off | advisory | autonomous-gated — default off (fail-closed)
  confidence-floor: 0.5    # float 0.0..1.0 — min confidence before an autonomous-gated dispatch acts
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dispatcher-autonomy.autonomy` | string (`off` \| `advisory` \| `autonomous-gated`) | `off` | Master autonomy mode. `off`: dispatcher inactive, no cross-repo candidate routing. `advisory`: the dispatcher surfaces ranked free-repo candidates for operator review — no automated dispatch. `autonomous-gated`: surfaces the advisory ranking AND routes dispatches that clear the `confidence-floor` gate. Fail-closed: any invalid/empty value resolves to `off`. |
| `dispatcher-autonomy.confidence-floor` | float | `0.5` | Minimum confidence score (0.0..1.0) required before an `autonomous-gated` dispatch is routed without operator confirmation. Candidates below the floor are surfaced as advisory suggestions only. Bounds: `0.0 ≤ value ≤ 1.0`. Out-of-range values silently fall back to the default. Only evaluated when `autonomy: autonomous-gated`. |

**Used by:** `scripts/lib/config/dispatcher-autonomy.mjs` (parser + `resolveDispatcherAutonomy` resolver), `skills/dispatcher/SKILL.md` (cross-repo dispatch flow).

**Host-local override (#653 pattern).** The effective `autonomy` enum is resolved at config-load time with precedence (highest first): `SO_DISPATCHER_AUTONOMY` env-var > `owner.yaml` `dispatcher.autonomy` (host-local, never committed) > committed `dispatcher-autonomy.autonomy` > `off`. An invalid/empty value at any tier falls through to the next tier — mirroring the `vault-dir` / `baseline-path` host-path resolution layer (`scripts/lib/config/host-paths.mjs`). This keeps a per-host autonomy posture out of the committed Session Config. The pure parser keeps the raw committed value for `claude-md-drift-check` raw-value parity; only the final `loadConfig()` object carries the resolved enum.

**Cross-reference:** "Cross-Repo Vault-Status Mirror + Autopilot Dispatcher" (#673; archived in the private Meta-Vault), Sub-issue #679.

**Parity note.** The `dispatcher-autonomy:` key is documented in `docs/session-config-template.md` as a **standalone `## Dispatcher Autonomy` section** outside the `## Session Config` block — intentionally parity-exempt from `claude-md-drift-check` Check-6 (session-config-parity). Adding it as a column-0 key inside `## Session Config` would hard-fail every repo with `drift-check.mode: hard` that has not yet adopted the feature.

**Root instruction-file adoption capture (#681).** This repo's own `## Dispatcher Autonomy` block is the one-time capture of #681 (dogfooded here), committed with `autonomy: off` — fail-closed, identical to this repo's de-facto state before adoption. Its committed PRESENCE is itself the never-re-ask marker: session-start Phase 1.1's migration trigger checks for the block's existence and will not re-prompt, regardless of the value inside. See the Host-local override paragraph above (#653 pattern) for the full env > `owner.yaml` > committed > `off` precedence chain that lets a machine opt this repo into `advisory`/`autonomous-gated` without editing the committed block.

## Defaults

If no `## Session Config` section exists in the platform config host file (`CLAUDE.md` or `AGENTS.md`), skills use: `feature` type, 6 agents, 5 waves, and field-specific defaults listed above.
