# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Vault namespacing coverage-lift — `repo:` backfill (#700, phase-2 follow-up).** The flat-corpus relocation engine (`scripts/relocate-vault-corpus.mjs`) gains an opt-in `--with-backfill` mode that infers the owning repo for the ~466 session notes that lack a `repo:` frontmatter field, lifting their (and their transitive learnings') namespace-derivability. The signal is **authoritative, not heuristic**: a session note's `id:` is joined against each sibling repo's own `.orchestrator/metrics/sessions.jsonl` `session_id` — an exact single-repo match is `HIGH` confidence; a unique `branch+date` match is `MEDIUM`; anything ambiguous (an id present in >1 repo, or a colliding branch+date) stays `_unsorted` (`SKIP`). A new pure module `scripts/lib/vault-repo-backfill.mjs` (`inferRepoForSession` / `buildBackfillIndex` / `isBackfillDerivable`) does the inference; every inferred slug still routes through the `resolveRepoNamespace()` CP1/CP6/CP10 leak-guard (private slugs → `redacted-repo` → never a confident move). `namespaceForSession(frontmatter, opts?)` gains an additive optional 2nd arg (backward-compatible — all existing 1-arg call-sites unaffected). New `--repos-root <dir>` flag (default: parent of `--vault-dir`) bounds the sibling-repo scan (`Archiv`/dot-dirs excluded; malformed jsonl tolerated). A pre-flight **intra-batch dest-uniqueness detector** surfaces same-basename collisions in dry-run that the runtime `existsSync` guard would otherwise only catch at apply-time. Measured on the live vault: confident moves rise **307 → 897** (backfill 232 + transitively-lifted learnings 531 + existing signals). Without `--with-backfill` the output is byte-identical to before. 38 new tests; full gate green.

- **Cross-repo learnings harvest into `.claude/rules` — #672.** Promoted ~41 stranded cross-repo DOMAIN learnings from the shared vault into path-scoped rule files (budget-neutral — always-on instruction count 425→427/480, headroom 53): `backend.md` (+3: MCP-tool SEC-009 mirror, webhook-recreate-rotates-signing-secret, SEC-009 raw-content→`details` field), `backend-data.md` (+14: PostgREST schema-cache SIGUSR1 reload / `PGRST204`, RLS-dead-code-under-`service_role` + verify-under-`authenticated`, `SECURITY DEFINER` `current_user` paradox, node-`pg` numeric→`z.coerce`, backdated-migration ordering, `migration repair` history-drift, non-recursive migration glob, `config.toml` seed paths, singleton-table PK pattern, mutating-dataset keyset, BAO immutable-retention, PostgREST 1000-row silent cap), `security-web.md` (+1: localhost single-process in-memory rate-limit carve-out), `development.md` (+2: whitespace-env `.trim()` truthy trap, dead-env / three-wirings audit), `frontend.md` (+5: `redirects()` identity-loop, `router.refresh` action-replay bounce, `router.push`-in-`startTransition` hang, shared-component `data-testid` forwarding, react-compiler `eslint-disable` block), `testing.md` (+18: Vitest mocking gotchas — `clearAllMocks` / `vi.hoisted` / ESM-`spyOn` / `new`-class mocks / centralized-env `resetModules`, Playwright `isVisible`-ignores-timeout / comma text-selector / `testIgnore` cascade / `.first()` hydration discriminator, `--project` & `bail:N` CI traps, `Promise.race` `timer.unref`, busy-wait forks-pool orphan, fake-regression-for-negative-tests, security-test-must-not-encode-vuln). BE-012 family + RLS confirmed **already-covered**; ~10 ops/runbook/repo-specific learnings **archived** with rationale. Baseline-sync issue filed for the cross-repo subset. `validate-plugin` 122/0; full See-Also integrity (0 dangling); markdown fences balanced.

### Changed

- **Generalized dead-bridge / dormant-seam validator — #671** (consolidates the 3 point-guards). A new `scripts/lib/validate/check-dead-bridge.mjs` (with pure `dead-bridge-detectors.mjs` + `dead-bridge-corpus.mjs`) subsumes the three standalone dead-bridge guards — `check-subagent-types.mjs` (#614), `check-rules-references.mjs` (#445), `check-baseline-fetch-bridge.mjs` (#618) — behind one rule engine, and **retires** all three. Class-(a) **dangling-reference** detection reproduces every old guard's behaviour verbatim (subsumption proven by a corpus equivalence test: each old guard's positive/negative case is an anchor); a NEW class-(b) **bridge-balance** detector flags set-but-never-read / read-but-never-set against a *declared* producer/consumer registry (registry-bounded → zero false positives, so the new gate keeps CI green). Wired into `validate-plugin.mjs`; the sunset-walker boilerplate-site exemption was repointed from the retired guard to the new validator files. 37 new tests; full gate green.

## [3.10.0] - 2026-06-23

Additive, backward-compatible release. Headline: a **cross-repo dispatcher** that picks
the next-best repo to work on, a **learning → rule reconciliation engine** that turns
session signals into reviewable `.claude/rules/` proposals, and the foundation +
activation of **skill self-evolution**. Every new behaviour is opt-in and off by default;
existing sessions are unaffected. CI green across the full suite on every commit.

### Added

- **Cross-repo Dispatcher — Epic #673** (closes #674, #675, #676, #677, #678, #679, #680, #681, #682). A new `/dispatcher` command (+ `dispatcher` skill) that enumerates the repos you are *not* currently working on, resolves free/busy from each repo's `session.lock` lease, ranks the free ones by **backlog priority × staleness × readiness**, recommends the single best one via `AskUserQuestion`, atomically claims its lease so two sessions can't collide, and routes you to the chosen entry command.
  - **#674/#675 — cross-repo session board + durable narrative mirror:** a `_active-sessions.md` vault board plus durable session-narrative mirroring so the dispatcher and the operator share one view of what's running where.
  - **#679/#680 — suitability verdict engine:** a new `dispatcher-autonomy` config block and a fail-closed suitability check that must pass before any autonomous launch.
  - **#681/#682 — autonomy wired end-to-end:** one-time capture of the committed autonomy posture + verdict-gated launch. Autonomous launch is **opt-in and off by default** (`dispatcher-autonomy.autonomy: off`); the effective dial resolves host-locally (`SO_DISPATCHER_AUTONOMY` env > `owner.yaml` > committed > `off`).
- **Learning → Rule Reconciliation Engine — Epic #693** (closes #694, #695). A new `/reconcile` command (+ `reconcile` skill) that converts confidence-scored session learnings into **conditional `.claude/rules/` proposals** — every write is operator-AUQ-gated and rules are never auto-applied.
  - **#694 — rule-loader activation:** wired the previously-dormant per-wave rule-loader and conditional rule frontmatter (glob / mode / host-class / expiry gating), so `.claude/rules/*.md` can load conditionally instead of always-on.
  - **#695 — reconciliation engine (FA2):** the learning → conditional-rule proposal pipeline.
  - **FA3/FA4 — advisory delivery + guardrails:** session-end advisory rule-proposal delivery (gated on a new `reconcile:` config block, default off), a `check-rules.mjs` CI guard (never-always-on firewall for generated rules), and a per-type rule-expiry TTL (`rule-expiry-days: null` → per-type default).
- **Skill Self-Evolution — Epic #643** (closes #643, #645, #647, #651). Foundation + activation of the self-evolution surface: token rollup, a `skill-evolution` config block, and L1/L2 telemetry; a **C2 tiered auto-repair engine** that gates auto-apply per artifact type; the C2 real apply-path plus an opt-in L3 session-end LLM judge (advisory only); and a closeout pass adding per-skill health, an MCP fix, and security hardening. Autonomous-apply is armed only for the safest drift shape (root-instruction command-count, filesystem-fact-sourced) behind a quadruple gate; plugin/local/remote targets are always MR-only. New `skill-applied-judge` agent.
- **Per-project Vault namespacing + relocation — #660, #700.** Per-project vault namespacing with a commit-isolation guard (#660), plus a phase-2 relocation engine and **walk-up named-vault resolution** (#700): vault-mirror can now route to the vault whose `match.org-prefix` matches the current repo's remote slug, configured via an optional `vaults:` list in `owner.yaml`. Absent config degrades byte-identically to single-vault behaviour.
- **Instruction-budget guard — #687.** An always-on session-start directive-budget banner (warn-only, growth-ratchet) that fires when the always-on structural-directive count exceeds a ceiling — a guard against silent instruction-file bloat. Paired with a PSA operator-session re-scope (#689) clarifying the operator-session vs in-run axes.
- **Frontend-slop detector — #684.** An impeccable-inspired deterministic frontend-slop detector and an opt-in `PostToolUse` hook (default off, warn-only, profile-gated) that flags templated-default UI tells after UI-file edits, plus the `frontend.md` design-ban rule markers it enforces.
- **Optional User-Story intent layer in `/plan` — Epic #654.** An opt-in user-story intent layer for the `/plan` flow.
- **Host-local, privacy-clean path resolution — #653.** `vault-dir` and `baseline-path` now resolve host-locally (env > `owner.yaml` `paths:` > committed default), so a machine can point at its own paths without committing personal locations to the repo.
- **gitlab-ops MR/PR evidence block — #669** and **SubagentStop feed-back-and-continue — #666** (additional context fed back to the coordinator on subagent stop).
- **6-surface drift detection — #663.** `claude-md-drift-check` extended to detect count drift across six surfaces.
- **LSP-posture rule** — new `.claude/rules/lsp.md` documenting the deliberate no-LSP-MCP navigation posture (ripgrep + steering map), so the absence reads as intentional.

### Changed

- **Config-cycle break + memory time-decay — #664, #670.** Refactored to break a config-module dependency cycle and wired memory time-decay into recall.
- **Doc-sync + loop-engineering positioning.** Corrected verified surface counts that had drifted across README and the session-injected steering docs, and reframed positioning around the "loop engineering" discipline. `.orchestrator/steering/{structure,product}.md` refreshed (skills/commands/agents/hooks inventory + mission re-centered on the durable moat: mechanical guards, telemetry, skill self-evolution, public-repo-safe shared memory, parallel-operator-session safety, multi-harness portability).
- **Native-overlap ADR refresh + prompt-caching rule demoted** to path-scoped (the orchestrator itself uses no LLM SDK).
- **README slimmed** to a leaner public landing page with private-tracker references removed.

### Fixed

- **Security — owner-leakage scanner canonicalize-before-match (#661)** and a scanner-safe Google-API-key test fixture (secret-scanning #5).
- **Metrics — pre-write JSONL round-trip self-validation + repair (#662)**, so a malformed metrics line is caught and repaired before it lands.
- **resource-probe — judge macOS RAM-criticality on *available*, not *free* (#667)**, fixing spurious resource-overload trips on healthy machines.
- **CI green-baseline restoration (#685, #686).** Sharded the vitest suite for the root Hetzner autoscaler; guarded chmod-as-root tests; replaced a root-only `/proc` `mkdirSync` that hung a shard with a uid-uniform unwritable-path helper; closed a CI false-green blind-spot in the fail-closed verifier; widened per-shard timeouts with headroom; hardened a multi-session-registry concurrency test and excluded the coverage lane double-count.
- **Reliability sweep** — CI-flake poll, vault-mirror drift correction, memory-cleanup stamp, and metrics hygiene.
- **deps** — `vite` overridden to `^8.0.16` (resolves a Dependabot HIGH advisory); `vitest` bumped to `^4.1.0` in the `claude-md-drift-check` skill.

## [3.9.0] - 2026-06-13

### Added

- **Pi harness adapter — session-orchestrator runs under `pi` (earendil-works/pi) like Codex/Cursor** — closes #639 (MR !23, merged from `codex/pi-adapter-639`). New `pi/` prompt-wrapper surface (20 generated prompts via `scripts/generate-pi-prompts.mjs --check`), `scripts/lib/pi-hook-bridge.mjs` (Pi native-hook manifest bridge, 328 LOC), `scripts/pi-install.mjs` installer, `hooks/hooks-pi.json` manifest, and `docs/pi-setup.md`. Platform/config/state/scope resolution now recognise the `.pi` marker dir + `PI_*` env vars (`PI_PLUGIN_ROOT` / `PI_PROJECT_DIR`) across `platform.mjs`, `config.mjs`, `common.mjs`, `plugin-root.mjs`, and `state-md-peer-guard.mjs` — **additive and backward-compatible** (claude/codex/cursor behaviour unchanged). New `check-pi-package.mjs` + `check-pi-prompts.mjs` validate-plugin checks (138 checks total, 0 failures) plus extended hook-symmetry coverage. CI pipeline #5577 full 7-job suite green (test 257s, coverage 439s).
- **Autonomy-Commands ADR + /loop-Anchoring + Owner-Leakage-Hardening** — closes #631, #633, #634; #632 repo-local part (deep session main-2026-06-10-deep-1, 5 waves / 16 agents + coordinator fold-ins).
  - **#633 Hebel 1 (ADR-0010)** — new `docs/adr/0010-native-autonomy-commands.md`: per-primitive verdicts for the native autonomy family verified against live docs on v2.1.170 (**/loop = Adopt** — `.claude/loop.md` IS the native customization seam; **/goal = Adapter** — adopt native per-turn continuation, keep judgment deterministic: the Haiku evaluator reads the transcript only and runs no tools, so it never replaces exit-code quality gates; **/batch = Stay** — GitHub-PR-shaped, no kill-switch/telemetry parity with `autopilot-multi`; **/background = Adapter** — gated on a detachment empirical test instead of pre-building autopilot Phase C-5). Closes the keystone gap next to ADR-0002/0003/0004.
  - **#633 Hebel 2 (LM rules)** — `.claude/rules/loop-and-monitor.md`: `/goal` completion-condition axis as the new first LM-001 branch (with an explicit "NOT: until CI goes green → Monitor" counter-example), new **LM-008 "Use /goal When …"** section, 2 new `/goal` anti-patterns (quality-gate misuse, unbounded goal), LM-005 "never reimplement /goal" bullet.
  - **#633 Hebel 3 (loop.md baseline)** — new vendorable `templates/_shared/loop.md` (repo-agnostic: VCS auto-detect glab/gh without `-R` hardcodes, Session-Config-gated vault check, CLI-error-tolerant) wired into all 4 bootstrap templates; host-wide `~/.claude/loop.md` user-baseline written (strictly read-only, account-neutral, privacy-clean). Project `.claude/loop.md` stale vault path fixed to the Session-Config SSOT.
  - **#633 Hebel 6 (readiness banner)** — new `scripts/lib/loop-readiness-banner.mjs` (`checkLoopReadiness`, sync, fail-silent, null when repo OR user loop.md exists) + 13 tests + session-start Phase-4 wiring: warns when bare `/loop` would fall back to the generic Anthropic maintenance prompt.
  - **Doc-drift sweep** — kill-switch count corrected to the runtime SSOT (`kill-switches.mjs:18-32` = **10**) in `skills/autopilot/SKILL.md` (table + pseudocode + frontmatter), `commands/autopilot.md`, and LM-005; `.orchestrator/steering/structure.md` inventory rows added. Dogfooding: the session itself ran a 30-min `/loop` maintenance cron on off-minutes (`7,37 * * * *`) per LM-003 hygiene.
- **Agent-status side-channel helper + ecc test-depth** — closes #565, #628 (deep "Value-Drain" session).
  - **#565 (agent-status)** — new `scripts/lib/agent-status.mjs`: a lean, no-throw, best-effort per-agent status push helper (`setStatus` / `setProgress` / `readCurrentStatus`) writing an append-only `.orchestrator/runtime/agent-status.jsonl` (`O_APPEND`-atomic) + a lock-serialised last-write-wins `agent-status-current.json` map. Self-contained `linkSync` create-or-fail mutex with PID-liveness stale-detection (reuses `isPidAliveOnHost`), PSA-003-compliant release (owner pid/host match), cross-host locks never overridden. Wave-executor integration documented at 3 anchors (dispatch / agent-end / wave-end rollup, gated `persistence: true`, fire-and-forget); opt-in `tmux-layout --with-status-pane` 5th pane. Tests include a **true cross-process race test** (8 spawned `node` processes — PoC-verified falsifiable: 4/8 keys lost without the lock) plus stale-lock recovery.
  - **#628 (ecc test-depth)** — new `tests/lib/config/{loop-guard,config-protection}.test.mjs` (parser clamping, mode validation, `allow-config-weakening` plain-vs-dead-bold form), corrupt-ring recovery + `session_id` path-traversal containment pins for the loop-guard hook, a `threshold > window` self-heal clamp in `scripts/lib/config/loop-guard.mjs`, a 50 MB `statSync` transcript size-bound in `hooks/subagent-telemetry.mjs`, and legacy `.eslintrc*` detection pins for the config-protection guard.
- **Sunset-review surface tooling + rule-reference hygiene** — closes #444, #445, #617; closes #446 (moot). Reduces backlog/review noise and gives the plugin a read-only way to find its own dead skills/agents/commands.
  - **#444 (sunset-review)** — new `scripts/lib/sunset/walker.mjs`: a READ-ONLY surface walker that enumerates the skill/agent/command surface, combines agent-dispatch telemetry (`subagents.jsonl`, `event==="start"` only) with static reference scanning, and classifies each item into a 4-tier verdict (Active / Investigate / Demote / Retire). Low-confidence guardrail downgrades every Retire to Investigate when telemetry coverage < window. JSON-first CLI (`--json`/`--window-days`/`--kind`, exit `0/1/2` per cli-design.md). **W5 hardening:** a command whose `skills/<name>/SKILL.md` linkage points at a skill no longer present on disk now classifies **Investigate** (reason "command invokes a skill not present on disk"), not Active — the exact staleness a sunset tool must catch (R1 architect + R3 qa convergent MED). +6 test-depth gaps (command read-error graceful degradation, `--kind` filter + hand-computed summary tally, skill-kind README boilerplate exclusion, scanned-dir `node_modules` skip).
  - **#445 (rule merge)** — merged `.claude/rules/test-quality.md` into `.claude/rules/testing.md` § "Test Quality — False-Positive Prevention"; redirected the 3 orphaned intra-repo links (`skills/wave-executor/SKILL.md` ×1, `skills/write-executable-plan/SKILL.md` ×2) to the new section, plus a `check-rules-references` guard against future dangling rule links.
  - **#617 (review-noise)** — stop auto-filing MED/LOW review findings as backlog issues (the backlog-noise root cause; #614 sibling).
  - **#446 (moot)** — closed; folded into the vault decisions log.

### Fixed

- **Owner-leakage scanner: trailing-slash blindspot (P1) + dash-encoded form (P9) + dotfile-allowlist reachability** — closes #631 (priority:high), #634 (priority:high, W4 panel finding).
  - **#631** — P1 regex `/\/Users\/bernhard[a-z.]*\//` required a slash AFTER the username, so bare `/Users/<owner>.` strings (end-of-line, before `&&`, before newline) passed undetected. Replaced with Candidate F `/\/Users\/bernhardg[a-z.]*(\/|\b)/` (tightest false-positive profile: rejects `bernhardo`/`bernhardt`/`bernhardg9`/`bernhardg_x` lookalikes — all pinned by tests); neutralized the 2 genuinely-leaking scanned lines (`memory-paths.mjs` docstring, `memory-paths.test.mjs` literal → dynamic-construct); 5 issue-form regression tests + 7 W3 edge-case tests + word-boundary intent pins. Fleet re-run with the fixed scanner across 43 repos posted to #632 (19 repos with P1 hits / ~233 occurrences quantified).
  - **#634** — W4 security-review found a committed dash-encoded home path (`-Users-<owner>--…`, the Claude Code projects-dir encoding) in `docs/migrations/2026-05-18-461-persona-reviewers-rename.md` shipping to the public mirror, structurally invisible to P1–P8. Scrubbed the line, added **P9** `/-Users-bernhardg[a-z.]*-/`, added the encoding-contract fixture file to SELF_EXCLUSIONS, + positive/negative regression tests. Residual: git history retains the old line (same accepted-residual class as #632 point 2).
  - **Dotfile-allowlist reachability (W3-P3 finding, folded in-session)** — `isTextFile()` checked `extname()` first, but `extname('.env.example')` is `'.example'` (truthy), making the `DOTFILE_ALLOWLIST` entry unreachable — `.env.example` was silently never scanned. Now basename-first + 2 reachability regression tests.
- **Dead baseline-fetch rule-bridge in bootstrap** — closes #618 (priority:high). Bootstrap Step S99/D99 gated the on-demand baseline fetch on `scripts/lib/fetch-baseline.sh`, a file the plugin never ships (only the Node port `fetch-baseline.mjs` exists since #218) — so the guard was always false and the step silently never fired in real installs. Flipped all bootstrap guards/refs (`skills/bootstrap/{_shared-template,SKILL,standard-template}.md`) to drive the shipped `fetch-baseline.mjs` single-file CLI in a per-manifest-rule `while`-loop (404→skip→continue) followed by an inline `node -e` `.baseline-fetch.lock` write, and plumbed the GitLab host from the `gitlab-host` Session Config key / `GITLAB_HOST` env (the `.mjs` keeps the host **mandatory with no private-host default** — privacy-correct for the public mirror; the issue's suggestion to reintroduce the legacy `.sh`'s hardcoded private-host default was a leak trap and was avoided). Mechanically pinned by a new `scripts/lib/validate/check-baseline-fetch-bridge.mjs` validate-plugin check (asserts the guarded file exists + zero dead `.sh`/shell-function refs) and a 19-test regression guard, so the dead-bridge class cannot silently recur.
- **Undocumented `--no-verify` in vault-mirror auto-commit** — closes #603. The vault-mirror auto-commit's `git commit --no-verify` (`scripts/lib/vault-mirror/auto-commit.mjs`) is now documented inline + in `skills/vault-mirror/SKILL.md` (rationale: only generator-stamped mirror artifacts ever reach the commit — already validated — and the unattended session-end close must not block on interactive/slow vault-side hooks) and pinned by a regression test asserting the flag on the real commit args.
- **Housekeeping: cut dead session-end auto-consolidation dispatch + add a dispatch-target guard** — closes #614, #606; closes #489 (moot). Express-path coordinator-direct session.
  - **#614 (dead automation)** — session-end Phase 3.6.5 (Auto-Dream) and Phase 3.6.7 (Auto-Dialectic) dispatched `subagent_type`s (`memory-cleanup`, `evolve`) that were never built in `agents/`, so the dispatch never fired — the symptom was a recurring "auto-dream/dialectic SKIPPED (agent-types unavailable)" line in 7+ session memories. Replaced both dead `Agent({…})` blocks with a lean manual-cadence nudge (run `/memory-cleanup --dry-run` / `/evolve --dialectic --dry-run` manually next session); the `shouldDispatchAutoDream` / `shouldDispatchAutoDialectic` decision helpers + `auto-dream.mjs` / `auto-dialectic.mjs` libs are preserved (they compute the signal that drives the nudge). Auto-dialectic advances `.orchestrator/dialectic-last-run` on nudge-emit so the reminder surfaces once per cadence window rather than every session. Also corrected the documented `writeDialecticLastRun(repoRoot, …)` positional call to the real `{ repoRoot, isoTimestamp }` object signature.
  - **New guard** — `scripts/lib/validate/check-subagent-types.mjs` asserts every `subagent_type: "session-orchestrator:<X>"` reference under `skills/**` resolves to an existing `agents/<X>.md`; wired into `scripts/validate-plugin.mjs` (exits non-zero on any unresolved reference). Supports an inline `check-subagent-types:ignore` marker for documenting historical/example dead references. +9 unit/integration tests.
  - **#606 (docs)** — documented the `VAULT_MIRROR_CANONICAL_SUFFIX` env-var (host-qualified canonical-vault guard override; environment-only, intentionally not a Session Config key) in `docs/session-config-reference.md`.
  - **#489 (moot)** — closed: the Windows-only test failures it tracked can no longer occur after `windows-latest` was dropped from the test matrix (v3.8.0 / `990be3a`).

## [3.8.0] - 2026-05-29

### Added

- **Housekeeping: GitHub public-safety + green CI** — restored a clean public mirror (github.com/Kanevry/session-orchestrator) with a green CI badge.
  - **CI green:** dropped the never-green `windows-latest` leg from the GitHub Actions test matrix. The orchestrator is POSIX-first (paths, `/tmp`, symlinks, shell built-ins) and Windows was never a required check nor a supported target; ~49 suites failed on Windows. CI now runs ubuntu + macOS + security (macOS is the priority platform). Also made the quality-gate test stand-ins cross-platform (`node -e` replacing POSIX `true`/`false`/`test -f`) as a correctness improvement.
  - **Privacy hardening:** scrubbed the literal internal subnet from the SSRF example in `security.md`; extended `check-owner-leakage.mjs` with P8 — full RFC1918 dotted-quad detection (placeholder `.x`/CIDR forms and TEST-NET exempt; the IP-redaction test allowlisted) + 5 regression tests; genericized SSH-string test fixtures to TEST-NET (192.0.2.x). Leak-scanner GREEN (1073 files, 0 leaks).
  - **Repo hygiene:** removed internal session-exhaust artifacts that had been committed to the public repo (`.orchestrator/{scratch,session-artifacts,consumed}`) and added gitignore rules for these + `.orchestrator/STATE.md` (was untracked-but-unignored). Project-private feature names (Clank, vault, projects-baseline) are intentional and retained per maintainer decision.

- **Vault + Observability Follow-up Drain (session-1, resumed)** — closes #602, #604, #607, #611, #612, #613. Resumed a crashed deep session at the W2→W3 boundary: verified the crashed W2 work (vault track + #612, 420 tests green / no regression), then completed W3–W5. 5 waves / 7 subagents / 8232 tests passing (+6 net from the W5 fold-in), 0 fail. 0 BLOCKER across 4 W4 reviewers (security PROCEED clean). Follow-ups #615 (#607 items 4/5/7 vault-path housekeeping), #616 (W4 test-depth + emitEvent `{filePath}` contract).
  - **#611 (Track A observability)** — additive `emitEvent(type, payload, { filePath })` path override (default unchanged; 9 existing 2-arg callers grep-verified unbroken); new `scripts/emit-event.mjs` CLI (`--type/--payload/--file/--json/--help`, exit `0/1/2` per cli-design.md); `compute-grounding-injection.sh` routed through the CLI (jq `--arg`/`--argjson` escaping preserved); `grounding_injected` → `orchestrator.grounding.injected` rename with both consumers (`metrics-collection.md` jq filter + `wave-loop.md`) updated in lockstep.
  - **#612 (Track B observability)** — mechanical `orchestrator.wave.{started,completed}` lifecycle in `post-tool-batch-wave-signal.mjs` (diff `.claude/wave-scope.json` `.wave` vs persisted `last_wave`); verified live in-session (dogfooded). W4 panel (3 reviewers converged) surfaced a `wave.started` double-emit; **root cause + fix:** `on-session-start.mjs` full-overwrote `current-session.json`, dropping `last_wave` on every SessionStart — now preserves `last_wave`/`last_batch` when `semantic_session_id` is unchanged (stable across clear/compact/resume; the UUID `session_id` is not). +5 idempotency/coverage tests.
  - **#602 (vault-mirror frontmatter)** — slugify-at-the-generator: `buildTag`/`slugifyIdSafe` sanitize non-kebab interpolated segments + uppercase-`T` ISO ids across all session/learning generators (root cause: re-reading the raw entry after the caller sanitized only the filename).
  - **#607 (vault testability/hardening — items 1-3 + 6)** — `_normalizeRemote` exported for unit tests; `rewriteMissingSegment.originalContent` made required + `isOwnedByUsernamePath` extracted; `scripts/lib/vault-consolidate-fs.mjs` extracted (deep module; #514 symlink guards preserved) + `import.meta.url` entry-guard; `VAULT_MIRROR_CANONICAL_SUFFIX=""` boundary pinned. Items 4/5/7 → #615.
  - **#604 / #613 (coverage)** — `vault-migration-rules.mjs` suite (41 tests; never-throws envelope contract pinned); 4 observability test refinements (quality_gate `incremental` variant, on-stop populated commit path, `wave_number:0` boundary, `isIso8601` Date.parse guard).

- **Epic #583 Hardening Close-out (deep-6)** — closes #590 (HIGH), #591, #592. 5 waves / 18 subagents / +38 net tests (7826 → 7864 passing). 0 BLOCKER / 0 HIGH across 5 W4 reviewers. Follow-ups #594 (findPeers caller-migration), #595 (v1→v2 lock-schema sunset, target 2026-08-25), #596 (residual MED+LOW bundle).
  - **#590-2 (HIGH) — `acquire()` TOCTOU fix:** fresh-acquire write migrated from tmp+`renameSync` (last-writer-wins) to a new `createSessionLockExclusive()` helper using `fs.linkSync` (POSIX-atomic create-or-fail), mirroring the existing `createStateLockExclusive`/`createStagingFenceLockExclusive` idiom in the same file. Two concurrent `SessionStart` hooks can no longer both win the lock. EEXIST-loser path re-reads + re-classifies (active/stale-*) with an ENOENT-vanish defensive fallback to `active`. `forceAcquire()` + `updateHeartbeat()` intentionally KEEP rename-based `writeLockAtomic` (they must overwrite). Proven by NEW `tests/integration/session-lock-cross-process.test.mjs` (5 sibling processes → exactly-one-winner; falsifiable — fails against the old tmp+rename impl).
  - **#590-1 — bootstrapLock conflict signal:** when `acquire()` returns `active` for a FOREIGN session, `hooks/_lib/lock-bootstrap.mjs` now records `conflict_with_session_id` + `conflict_detected_at` into `.orchestrator/current-session.json` via atomic read-modify-write (preserving concurrently-written fields) before its (unchanged) `null` bail. Best-effort — FS errors never block the hook.
  - **#590-3 — `updateHeartbeat()` cadence extension:** wave-executor inter-wave checkpoints (`wave-loop.md` §3a) + session-end entry (before Phase 3.8 lock-release) now refresh the session.lock heartbeat, covering long-idle deep sessions with no PostToolBatch activity for >4h.
  - **#592 MED-1 — `findPeers(repoRoot)` 3-surface union unifier:** NEW `scripts/lib/peer-discovery.mjs` unions lock+registry (via `discoverActiveSessions`) with STATE.md (via `checkPeerStateMd`) into one provenance-tagged flat list, fail-open per surface (never throws). Library-only; Phase 0.5 + Phase 1.2.1 caller-migration tracked in #594.
  - **#592 MED-2 — `mapToKnownMode` encapsulation:** deleted the shadow mode-enum from `lock-bootstrap.mjs`; `acquire()` gained an additive `{ quiet }` param that suppresses the unknown-mode stderr-warn. lock-bootstrap now passes the raw mode + `quiet: true`. Genuine coupling reduction (the matrix vocabulary lives in one place).
  - **#592 MED-3 / LOW-1 / LOW-3:** sessionId-equality invariant precondition comment in `state-md-peer-guard.mjs`; `isPidAlive` → `isPidAliveOnHost` rename + `@forensic` JSDoc (clarifies it is NOT the discovery-path liveness check — that is heartbeat-age); local `writeJsonAtomic` in `lock-bootstrap.mjs` consolidated to the canonical `writeJsonAtomicSync` from `io.mjs`.
  - **#591 — 6 boundary/race test gaps + 2 anti-patterns:** H1 exact-TTL strict-`<` boundary, H2 `updateHeartbeat` empty-repo, H3 `registryReaderFn` throw fail-open (SUT re-attributed to `session-discovery.mjs`), H4 real cross-process race, H5 STATE.md no-`session:`-field, H6 3+ peer E2E; AP1 `setTimeout`→`vi.useFakeTimers()` (2 sites), AP2 `toBeTruthy()`→dual-format-regex (NOT strict-UUID — semantic-OR-uuid id-space, RCR-006 pushback on issue text).

- **Value+Maintainability Sweep (deep-4)** — single coherent bundle of 1 medium feature + 5 refactors + 1 continuation + 1 test-quality + 1 epic close. Closes #566, #510, #511, #512, #513, #542, #581, #515, #378. Net +73 tests vs deep-3 (7658 → 7731 passing).
  - **#566** `auto-dream.min-confidence` config knob (numeric `[0.0, 1.0]`, default `0.5`) — second confidence gate above `memory.proposals.confidence-floor`, applied at session-end Phase 3.6.3 `collectProposals()` collect-emit time (NOT at `auto-dream.mjs` proposal-emit time as the original AC literally said — `scripts/lib/auto-dream.mjs` has no per-item proposal stream; grep-verified 0 confidence references). User-AUQ-approved adaptation. New `scripts/lib/config/auto-dream.mjs` parser (mirrors `cold-start.mjs` structure + `vault-mirror-quality.mjs` float-range validation); `minConfidence` parameter on `collectProposals()` with back-compat `null` default; 1-line docstring pointer in `auto-dream.mjs` for AC-traceability; SSOT parity across CLAUDE.md + `docs/session-config-template.md` + `docs/session-config-reference.md` (drift-check Check 6 GREEN).
  - **#510** `scripts/lib/cli-flags.mjs` (NEW) — shared `parseColumnFlags({knownBool, knownString, defaults, onUnknown})` helper around `node:util parseArgs` strict mode + typed `CliFlagError`. Migrated 4 scripts (`vault-consolidate.mjs`, `vault-mirror.mjs`, `migrate-cold-start-seed.mjs`, `migrate-vault-paths.mjs`) to the SSOT. **Intentional behavior change**: `vault-mirror.mjs` unknown-flag policy changed from silent-ignore → exit-1 (grep-verified no caller in `skills/` passes unknowns; tightening, not loosening); wet-run-default preserved on `vault-mirror.mjs`.
  - **#512** `scripts/lib/memory-paths.mjs` (NEW) — `resolveMemoryDir` extracted from `auto-dream.mjs` (no re-export — auto-dream did not use it internally); single production consumer (`memory-banner.mjs`) re-pointed.
  - **#511** `emitAction` in `scripts/lib/vault-mirror/process.mjs` — 6 positional params → options-object `{action, path, kind, id, vaultDir, meta}` (param renames `filePath→path`, `fileKind→kind`); 15 call sites + 2 test sites updated. `scripts/vault-backfill.mjs` separate `emitAction` untouched.
  - **#542** memory-banner.mjs test-only exports renamed with `_`-prefix convention (`_truncateLine`, `_formatLearningLine`, `_formatStatsLine`, `_extractCardExcerpt`, `_formatBanner`) matching `scripts/lib/session-id.mjs:218` precedent; public API (`renderMemoryBanner`, `readBannerInputs`) unchanged.
  - **#581** 4-item residual bundle (Items 1-3 = tests, Items 4-5 = code/doc):
    - Item 1+2: NEW `tests/lib/config/discovery-validator.test.mjs` (17 parser unit tests + 2 `parseSessionConfig` integration assertions, mirrors `tests/unit/slopcheck.test.mjs` style).
    - Item 3: 2 new edges in `tests/hooks/post-subagent-discovery-validator.test.mjs` (multi-violation count → 2 events; `TAIL_RECORDS=8` window boundary with 10-record fixture).
    - Item 4: `scripts/lib/autopilot/loop.mjs:312` hardcoded `.claude/STATE.md` → `${SO_STATE_DIR}/STATE.md` (platform-resolved via `scripts/lib/platform.mjs`, INERT pre-cloud-flip).
    - Item 5: `docs/adr/0009-worktree-path-layouts.md` 3 line-range citations → symbol/section anchors matching ADR-0008 style.
  - **#515** 3 test-quality assertions tightened: cold-start-detector banner-lines (exact-string `toContain` instead of `.length > 0`); learning-memory-modernization integration (`readFileSync` + `toContain(insight)` + length floor); migrate-vault-paths classification (`JSON.parse` + `toHaveLength(1)` + `toMatchObject` + symmetric no-leak guard, replacing `.find()` + `toBeTruthy`).
  - **#378** epic `/test [scope]` umbrella verified + closed — all 9 sub-issues (#379-#387 including WEB-PROOF and MAC-PROOF) confirmed closed; scaffolding shipped at `commands/test.md` + 4 skills (`test-runner`, `playwright-driver`, `peekaboo-driver`) + `agents/ux-evaluator.md` + `scripts/lib/test-runner/issue-reconcile.mjs`.

- **Epic #583 — Parallel-Session Detection Wiring Hardening** (closes #584 #585 #586 #587 #588): Five compounding wiring defects in Epic #568's parallel-aware detection were identified via live-verification (session ran parallel-aware-preamble against a real active peer and detection did not fire):
  - **#584 — Mechanical lock trigger (D1):** `hooks/_lib/lock-bootstrap.mjs` (`bootstrapLock()`) is now invoked from `hooks/on-session-start.mjs` on every `SessionStart`. Closes the Disziplin-statt-Mechanik gap: the `session.lock` was previously only written when the coordinator-LLM executed Phase 1.2 prose — a silent-skip risk on every session that skipped that prose step.
  - **#585 — Heartbeat-based liveness (D2/D3):** Lock schema v2 adds `last_heartbeat` (ISO-8601, updated by `SessionStart` + `PostToolBatch`/`Stop` hooks). Heartbeat-based liveness `(now - last_heartbeat) < ttl_hours * 3600 * 1000` replaces PID-liveness (`isPidAlive(pid)`). The recorded `pid` in v1 locks was the hook subprocess PID (~500ms lifetime), making every lock appear stale immediately after hook exit. This is the PostgreSQL pattern — use an application-level heartbeat, not process-table interrogation.
  - **#586 — `resolveSemanticSessionId` history-aware (D3):** Now consults `sessions.jsonl` + sibling worktree STATE.md files before computing `n`. Previously returned duplicate `deep-1` when `discoverActiveSessions()` returned an empty array (which it always did — D2 meant all locks looked pid-stale).
  - **#587 — `semantic_session_id` always surfaced (D4):** Lock schema v2 adds `semantic_session_id` field alongside `session_id`. On Claude Code, stdin always provides a UUID-v4 → the semantic-id code path in `on-session-start.mjs:236-313` was unreachable. Now `bootstrapLock()` derives and records the semantic form independently so peer-detection can use the human-readable id.
  - **#588 — Host-registry `mode` field (D5):** `session-registry.mjs:registerSelf()` entry schema-v2 adds a `mode` field. Without it, every cross-repo registry entry contributed `mode=undefined`, which `classifyMode(undefined)` bucketed into `parallel-ok` — bypassing the exclusivity-matrix for all cross-repo peers.
  - New module `scripts/lib/state-md-peer-guard.mjs` — `checkPeerStateMd()`. Defense-in-depth Phase 1b guard: reads STATE.md frontmatter and detects when a *different* active session currently owns it, even when the session.lock has been swept. Fires the Worktree-Promotion AUQ before STATE.md is overwritten.
  - **W5-F1c — `on-stop` heartbeat-refresh, NOT release (post-W3-P3 correction):** Initial W3-P3 wiring called `release({sessionId, repoRoot})` from `hooks/on-stop.mjs`. Stop fires per-turn-end (NOT per-session-end), so release-on-Stop would delete the lock after the first assistant turn → session goes blind. W5-F1c swaps `release` for `updateHeartbeat({sessionId, repoRoot})`: the lock stays live, heartbeat is refreshed every turn, TTL handles eventual cleanup. Closes W4-Q3 H2 cadence finding.
  - **W5-F1c — Q5 H1: `semantic_session_id` propagation:** Previously, `semantic_session_id` lived only on the `session.lock`. Issue #587 AC said both `current-session.json` and the host-registry entry must also carry it. Fixed: `hooks/on-session-start.mjs` payload + `scripts/lib/session-registry.mjs:registerSelf()` entry both record the field. Live-verified: `current-session.json` after hook fire shows `{session_id: "<UUID>", semantic_session_id: "<branch>-<date>-deep-N", ...}`.

### Fixed (pre-existing, surfaced by Epic #583 review)

- **Pre-existing latent bug uncovered by W2-I1 PSA-006 grep + fixed in-scope:** `hooks/on-session-start.mjs:278` destructured `entryPath` from `session-registry.mjs` but `entryPath` was never exported (only `function entryPath(...)`). The `TypeError: entryPath is not a function` was silently swallowed by the surrounding try/catch and the semantic-id generation degraded to UUID-fallback — defeating Issue #573 (P2.2) entirely on Claude Code. Fixed by inlining `path.join(activeDir(), \`${sessionId}.json\`)`. Surfaces in the CHANGELOG separately from Epic #583's intended scope because it predates this Epic but landed in the same commit (W2-I1 grep verified non-exported via `grep -n "^export function entryPath\\|^function entryPath" scripts/lib/session-registry.mjs`).
- **eqeqeq lint violation in `scripts/lib/state-md-peer-guard.mjs:135`:** W2-I4 wrote `parsed.frontmatter == null`. Tightened to `=== null` per ESLint `eqeqeq` rule.

- **#593 vault-integration parser block-form collision** — `_parseVaultIntegration(kv)` read `enabled` from a shared KV map collapsed across all Session Config blocks (the same `enabled:` key is used by `docs-orchestrator`, `vault-staleness`, `slopcheck`, `templates-first`, `verification-auto-fix`, `discovery-validator`, `state-md-lock`, `cold-start`, `memory.banner`, `memory.proposals`, `events-rotation`, `test`, `gitlab-portfolio`, `drift-check`, `vault-sync`, `wave-reviewers` — 16 collision-eligible blocks). Whichever block declared `enabled:` LAST in `CLAUDE.md` (currently `discovery-validator: enabled: false`) silently overwrote `vault-integration.enabled: true` — disabling vault-sync + vault-mirror at session-end. Converted to `_parseVaultIntegration(content)` mirroring the `cold-start.mjs` content-based block parser pattern (every other peer parser was already content-based; this was the lone kv-based outlier). Inline-form path from #497 preserved with precedence over block form. Regression tests in `tests/lib/config/vault-integration.test.mjs` (`issue #593 regression` describe) + integration test in `tests/lib/config.test.mjs` (realistic peer-block layout asserts vault-integration.enabled:true wins over peer enabled:false). The pre-#593 side-effect that quoted-boolean `'false'` on nested `memory.proposals.enabled:` exited non-zero is now gone — `_parseMemory` strips quotes and treats `'false'` as `false` (tolerant parsing — see `tests/scripts/parse-config.memory-proposals.test.mjs`).

- **Epic #568 Phase 3 — Worktree-Auto-Promotion + Hybrid Cleanup** (closes #574, #575):
  - `enterWorktree({basePath, sessionId, branch, repoRoot})` named export in `scripts/lib/autopilot/worktree-pipeline.mjs` — creates sibling worktree at `<basePath>/<repo-name>-<sessionId>/`, idempotency check, security boundary via `realpathSync` + `validateWorkspacePath`.
  - `skills/_shared/parallel-aware-auq.md` + `parallel-aware-preamble.md` — PROMOTION_OFFER outcome wired to `enterWorktree()` (no more "P3.1 #574 stub").
  - `skills/session-end/SKILL.md § Phase 4a` — Auto-Promoted Worktree Cleanup. Clean → auto-remove + WARN. Dirty → 3-option AUQ (Behalten/Löschen/Manuell). PSA-003 compliance. Runs AFTER Phase 4 commit+push (respects #490 durableCommit ordering).
  - `skills/memory-cleanup/SKILL.md § Phase 4.5` — Worktree-Stale-Sweep. Stale auto-promoted worktrees (age > `stale-branch-days`, default 7d) offered for batch-removal in housekeeping prune flow.

### Fixed

- **#576** `validateSession` accepts `schema_version ∈ {0, 1, 2, 3}` (additive contract). Previous validator rejected ADR-364 schema_version=3 entries written 2026-05-24; read-path tolerance only — `CURRENT_SESSION_SCHEMA_VERSION` unchanged at 1.

### Tests

- New `tests/integration/worktree-auto-promotion.test.mjs` (Gherkin rows 1-2 coverage)
- New `tests/skills/session-end-cleanup.test.mjs` (Gherkin rows 2-3 + PSA-003)
- New `tests/skills/housekeeping-stale-sweep.test.mjs` (Gherkin row 4)
- Extended `tests/lib/session-schema/validator.test.mjs` with additive contract assertions (schema_version 0/1/2/3 accept, -1/4/99/"1"/1.5 reject)

- **Epic #568 Parallel-Aware Sessions Phase 1+2 (#570 #571 #572 #573)** — extends Phase 1.1 foundational helpers (#569, shipped in d012db9) with:
  - **P1.2 (#570)** `acquire()` exclusivity-matrix integration in `scripts/lib/session-lock.mjs`. New return reasons (`active-incompatible-exclusive`, `active-compatible-parallel`, `active-readonly-bypass`) + `exclusivityClass` field on all returns. Backward-compatible: 4 existing reasons unchanged when `activeSessions` arg omitted. Sync function (caller pre-computes `discoverActiveSessions(repoRoot)`).
  - **P1.3 (#571)** new `skills/_shared/parallel-aware-preamble.md` (mirrors `bootstrap-gate.md` 7-section pattern; `HARD-GATE` for exclusive, `SOFT-GATE` for parallel-ok, pass-through for always-ok) + new `skills/_shared/parallel-aware-auq.md` (3 AUQ variants per PRD §3 P1 with Codex CLI/Cursor numbered-Markdown fallback per AUQ-004). Adopted at Phase 0.5 in all 5 orchestrator SKILL.md (autopilot, session-start, session-plan, wave-executor, session-end); session-start Phase 1.2 stale-lock AUQ delegates to the preamble (not replaced — local-lock semantics preserved).
  - **P2.1 (#572)** new `scripts/lib/session-id.mjs` exporting `resolveSemanticSessionId({branch, mode, activeSessions, repoRoot})` → `<branch>-<YYYY-MM-DD>-<mode>-<n>` (n = max+1 monotonic, serialized via `withStateMdLock`), `parseSessionId(id)` dual-format reader (semantic OR UUID-v4 per PRD §3 P2 row 3 backward-compat), `SEMANTIC_ID_RE` + `UUID_V4_RE` regexes.
  - **P2.2 (#573)** `hooks/on-session-start.mjs:resolveSessionId` switched from `randomUUID()` to semantic-first via `resolveSemanticSessionId`. Consults host-wide registry for cross-repo n-uniqueness (not just worktree-local `discoverActiveSessions`). Atomic O_EXCL slot claim with silent UUID-v4 fallback on collision (parallel hooks). `source` label now distinguishes `generated-semantic` / `generated-uuid-fallback` / `generated-uuid-fallback-collision` / `stdin`. `skills/_shared/state-ownership.md` schema-doc updated to match P2 format with `since #573` anchor.
  - +28 net tests: 8 acquire matrix scenarios + 20 session-id (parseSessionId dual-format × 8, resolveSemanticSessionId happy/backward-compat × 8, regex × 4). All existing tests preserved; 2 hook contract tests updated for new source labels.
  - Closes P3 dependencies on Phase 2 — only #574 P3.1 (Worktree-Auto-Promotion AUQ) + #575 P3.2 (Hybrid Cleanup) remain in Epic #568, both externally blocked by #448 (autopilot-multi terminal-reason race) + #490 (durableCommit for 3-File-Commit).
- **`/tmux-layout` skill (opt-in)** — operator-side tmux visualization for session side-channels (STATE.md tail, vcs-aware CI-watch, events.jsonl tail). Renders a 4-pane default layout via a printable one-liner the operator pastes into a second terminal. Pane 1 is a scratch shell (AUQ-001 compliant — coordinator chat stays in original terminal). PSA-003-compliant session-collision policy (`--force` required to replace). Per **ADR-0007** (`docs/adr/0007-tmux-visualization-substrate.md`). Closes #561, #562 (debug variant), #563 (telemetry + promotion gate).
- **#557 staging-fence test-depth bundle** — added 33 unit tests for `hooks/pre-bash-staging-fence.mjs` (G1-G6 gate ladder + 14 GIT_ADD_REGEX variants), `withStagingFenceLock` (timeout/stale-PID/holder-mismatch/fn-throws/TypeError paths — fs-error path flagged as production-code testability seam follow-up), and `wave-scope-commit-guard` lock-failure branch. Closes #557.
- **tmux-layout best-practice hardening** — coordinator E2E verification (14 practical CLI tests) found and fixed `jq --line-buffered` (not supported in jq 1.7+) → `--unbuffered`. Added 9 gap-fill tests (Pane 4 jq filter content + Pane 2 STATE.md path resolution + shellQuote injection safety + vcs-detector contract per platform). WebSearch research confirmed alignment with claude-squad/workmux/Anthropic Agent Teams patterns (different use-case: side-channel observability vs. multi-agent visualization).

### Security / Hardening

- **#577** `execSync` → `execFileSync` arg-array conversion in worktree-cleanup + worktree-sweep — shell-injection impossible when branch/path args are passed as array elements (never interpolated into a shell string). PSA-003-aligned.
- **#567** New opt-in `hooks/post-subagent-discovery-validator.mjs` SubagentStop hook — mechanical PSA-006 grep-transcript enforcement; flags discovery output that asserts distributional claims without a quoted `grep`/`rg` transcript (logs a `discovery_validator_violation` event + stderr WARN; non-blocking in v1 — exits 0 always, never rejects the subagent). Default-off (`discovery-validator.enabled: false`); enable per-session or globally in Session Config.

### Refactor

- **#578** `SKILL.md` inline JS stubs replaced with authoritative-impl reference pointers — eliminates SSOT drift between `SKILL.md` documentation and `.mjs` implementation files. No behaviour change.
- **#580-DI-001** Documented divergent sync/async DI seams (`execFileFn` vs `zx-$`) across worktree-cleanup and worktree-sweep — cross-references added in both SKILL.md and relevant `.mjs` files so future contributors understand the seam boundary intentionally.

### Fixed

- **#490** `durableCommit` now commits `autopilot.jsonl` + `sessions.jsonl` + `STATE.md` as a 3-file atomic commit before setting `autopilot.enabled: true` — HARD GATE closes the window where a crash between `enabled:true` write and commit could leave sessions without telemetry entries.
- **#580-HARDEN-002** Phase 4.5 stale-sweep AUQ now warns when live peer sessions are detected (`discoverActiveSessions` count > 0) before offering batch worktree removal — prevents accidentally removing a worktree that another active session is using.

### Tests

- **#579** Closed 3 MED coverage gaps: multi-match worktree disambiguation, branch-flag command-capture in `execFileSync` arg-array path, exclusive-vs-parallel EARS ordering contract.

### Docs

- **ADR-0008** (`docs/adr/0008-worktree-cleanup-ordering.md`) — records the decision that Phase 4a cleanup runs AFTER Phase 4 commit+push (not before), rationale: preserves `#490` durableCommit ordering so `sessions.jsonl` + `STATE.md` are persisted to origin before worktree removal.
- **ADR-0009** (`docs/adr/0009-worktree-path-layouts.md`) — records the two distinct worktree path layouts (`enterWorktree` sibling-flat `<basePath>/<repo-name>-<sessionId>/` vs `setupWorktree` 2-level `<base>/<basename>/<issueIid>/`), when to call which, and the deliberate sync/async DI-seam divergence (`execFileFn` vs zx `$`) — kept divergent, not unified.
- **#580-AUQ-001** Phase 4a dirty-worktree AUQ option order is intentionally `[Behalten (Recommended) / Löschen / Manuell]`, not the PRD §3 P3 Row 3 literal `[Löschen / Behalten / Manuell ich mach's selbst]`. The inversion is PSA-003-aligned: placing the non-destructive "Behalten/Keep" option first + recommended means an accidental Enter keypress never destroys a worktree. Treat the implementation as the authoritative spec; the PRD row was updated retroactively.

## [3.7.0] - 2026-05-23

Eighteen sessions spanning **9 days** (2026-05-15 → 2026-05-23) since v3.6.0. The headline is the **F2 Memory & Personas cluster** — agent-writable `memory.propose`, the session-start memory banner, USER.md + AGENT.md peer cards, and the dialectic-deriver — alongside the **gsd Pattern Adoption Epic #517** (4 mechanical hardening patterns) and a **Persona-Panel Foundation** (`/persona-panel` skill + 4 templates). Tests grew from **5001 → 7360** (+2359, ~47%), validate-plugin **43 → 94/94**, typecheck **67 → 230 files**, zero breaking changes, zero CI regressions, zero open issues/MRs on either GitLab or GitHub at the cut point.

1. **2026-05-15 deep-1 — Wire + Visibility cluster (#386 #449–#456)** — wave-executor visibility wiring (#449 #450), language-mapper `ExportAllDeclaration` fix (#454), GitLab CI `NODE_VERSION` bump 22→24 (#456 follow-on), CI plugin-schema-validate fix (#84455b ajv-cli local fetch).
2. **2026-05-15 deep-2 + deep-3 — BP-2026 ADR cluster (#437–#447, #480–#487)** — strategic ADRs, EARS personas, persona-gate hook tests, polish triplet, H3/Routines scaffolds, deep-3 implementation pass (#487 #482 #483 #484 #485). Architecture vocabulary firmed up per LANGUAGE.md.
3. **2026-05-16 deep-1 — Persona-Panel Foundation (#457–#480)** — NEW `skills/persona-panel/` + `commands/persona-panel.md` + `templates/personas/` (4 personas: buyer, expert, compliance, custom). Three modes: voting-quorum, hard-gate-threshold, coordinator-summary. Writes timestamped sidecars to `.orchestrator/persona-panel/`. Polish triplet (#474 #479 #480).
4. **2026-05-16 deep-3 — harness-audit Cat-8 flagship + correctness/debt cluster (#472 #473 #475 #476 #477 #478)** — `skills/harness-audit/` 8-category rubric scoring, `commands/harness-audit.md`, baseline drift detection. Correctness/debt sub-cluster surfaces architectural smells.
5. **2026-05-16 → 17 — Marketplace + SEC + Anthropic + Superpowers ecosystem cluster (GH #34 #35–#40 #43 #44 #45 + GL #213 #409–#414)** — five-pattern Anthropic adoption (`hooks/operator-steer.mjs` mid-wave guidance via STEER.md, `mcp-builder` in-process MCP docs, OTel `gen_ai.*` aliases on subagents.jsonl, security-reviewer Hard Exclusions reducing FPs ~35%→15%, knowledge-work-plugins submission prep), five-pattern superpowers adoption (`/brainstorm` Socratic design dialogue, `/debug` 4-phase root-cause workflow with Iron Law, `write-executable-plan` skill with placeholder linter, `verification-before-completion` always-on rule, `receiving-review` always-on rule), Marketplace + SEC (vault-dir CWE-22 guard, Codex composer icon, awesome-codex-plugins + composio + knowledge-work-plugins submission docs).
6. **2026-05-17 → 18 — Clawpatch + CC 2.1.x + prompt-caching cluster (#415–#436, #421, #426)** — six architectural patterns borrowed from Clawpatch (#415–#420), Claude Code 2.1.x adoption matrix (#427–#436 + #426 monitor when=on-skill-invoke), NEW `.claude/rules/prompt-caching.md` path-scoped rule with PoC outcomes (#421).
7. **2026-05-18 deep-1 — Phase 1 Learning & Memory Modernization (#499 #500 #502 #504 #507)** — auto-dream automation foundation (#499), cold-start nudges (#500 — `cold-start.enabled` / `nudge-after-hours` / `silence-after-sessions`), memory-cleanup soft-limit (#502 — `memory-cleanup-soft-limit`), vault-mirror quality gates (#504 — `vault-mirror.quality.min-narrative-chars` / `min-confidence`), session-start cold-start banner (#507).
8. **2026-05-19 — Privacy/Public-Mirror Epic (#462 #461 #468 #469 #470 #471)** — generic vault-migration scripts via per-user config, deep-1 operator-narrative docs moved to vault, CHANGELOG slug-leak fix (#5d1f241), private-slug template rename to neutral identifier (#ae6d5e9).
9. **2026-05-22 — gsd Pattern Adoption Epic #517 (#518 #519 #520 #521)** — four mechanical hardening patterns: STATE.md write-lock via `withStateMdLock` + real cross-process mutex (tmp+linkSync) (#518), `pre-bash-templates-first` PreToolUse hook + `/templates-ack` bypass + transcript-history helper (#519), Slopcheck (LLM-hallucinated package detection) via `scripts/lib/slopcheck.mjs` + `classifyPackages` + supply-chain-slopcheck probe + plan Phase 3.5 Package Legitimacy Audit (#520), bounded auto-fix loop via `runQualityGateWithRetry` + RCE-equiv docs + drift banner + diagnostics redaction (#521). +122 unit tests across all 4 patterns.
10. **2026-05-23 — F2 Memory & Personas cluster (#501 #503 #505 #506 + Pattern-Quality Follow-Up #522–#528 + Memory-Proposals Hardening #540–#549)** — **F2.1** `memory.propose` agent-writable CLI + session-end Phase 3.6.3 AUQ collector + `memory-proposal-collector` agent (#501), **F2.3** session-start memory banner via `renderMemoryBanner` (#505), **F2.4** Peer Cards Foundation (USER.md + AGENT.md per-repo behavioural identity) (#503), **F2.5** Dialectic-Deriver orchestrator pattern with cadence helper + session-end Phase 3.6.7 auto-trigger (#506), Pattern Quality Follow-Up (#522–#528) shipping in-session cleanups, Memory-Proposals Hardening Sweep (#540–#545) + Tail-End Sweep (#495 #509 #546–#549).

No breaking changes. The new commands (`/brainstorm`, `/debug`, `/persona-panel`, `/memory-cleanup`, `/harness-audit`, `/repo-audit`, `/portfolio`, `/templates-ack`, `/autopilot-multi`) are opt-in additions; the F2 Memory cluster fields in Session Config (`memory.proposals.enabled`, `memory.banner.enabled`, `cold-start.enabled`, `state-md-lock.enabled`, `slopcheck.enabled`, `templates-first.enabled`, `verification-auto-fix.enabled`) all default to safe values (most opt-in, banner opt-out). Existing `/session`, `/go`, `/close`, `/evolve`, `/plan`, `/discovery`, `/autopilot`, `/test`, `/bootstrap` flows are byte-equivalent for repos that haven't enabled the new opt-ins.

### Added

- **F2 Memory & Personas cluster — F2.1 Agent-writable Memory-Tool (#501)** — `scripts/memory-propose.mjs` CLI (env-gated by `SO_WAVE_AGENT=1`, exits with status dict: `queued=0`, `quota-exceeded=1`, `rejected-low-confidence=2`, `rejected-wrong-context=3`, `error=4`), 4-module store at `scripts/lib/memory-proposals/` (schema/store/collector/sink), atomic linkSync quota lock, session-end Phase 3.6.3 AUQ multi-select with 4-per-batch FIFO pagination, confidence floor 0.5, privacy-redacted `hooks/pre-bash-memory-propose-audit.mjs`. NEW `agents/memory-proposal-collector.md` (reference documentation, not dispatchable). Session Config: `memory.proposals.enabled` (default `true`), `memory.proposals.quota-per-wave` (5), `memory.proposals.confidence-floor` (0.5). +193 tests.
- **F2 Memory & Personas cluster — F2.3 Session-Start Memory Banner (#505)** — `scripts/lib/memory-banner.mjs` `renderMemoryBanner()` reads top-5 surfaced learnings + memory-stats line + USER.md/AGENT.md excerpt; renders at session-start Phase 6.7. Operator-confidence anchor borrowed from doobidoo/mcp-memory-service. Session Config: `memory.banner.enabled` (default `true`). Silent no-op when disabled or persistence is off.
- **F2 Memory & Personas cluster — F2.4 Peer Cards Foundation (#503)** — `.orchestrator/peers/USER.md` + `.orchestrator/peers/AGENT.md` per-repo behavioural identity files, `scripts/lib/peer-cards/staleness-banner.mjs` (`checkPeerCardsStaleness`) surfaces banner at session-start Phase 4 when card age >30d (suggests `/evolve --dialectic`). Cross-reference: `.claude/rules/owner-persona.md` (host-wide `owner.yaml`) and vault `type: peer-card`.
- **F2 Memory & Personas cluster — F2.5 Dialectic-Deriver (#506)** — NEW `agents/dialectic-deriver.md` (read-only, haiku, bounded budget) reasons over top-50 learnings + last-10 sessions + existing peer cards to derive USER.md/AGENT.md updates. **Pattern B (orchestrator-pattern)** — does NOT use Anthropic SDK directly (per `.claude/rules/prompt-caching.md:3` scope rule). Session-end Phase 3.6.7 auto-trigger via cadence helper mirroring auto-dream API.
- **gsd Pattern Adoption Epic #517 — STATE.md Write-Lock (#518)** — `scripts/lib/state-md-lock.mjs` `withStateMdLock(repoRoot, fn)` + real cross-process mutex via tmp-file + `linkSync` atomic acquire (TOCTOU-safe), PID-liveness stale-detection with atomic override on dead PID + WARN on stderr, 10s default timeout. PSA-005 mechanical complement to PSA-003/PSA-004. Session Config: `state-md-lock.enabled` (default `true`), `state-md-lock.timeout-ms` (10000).
- **gsd Pattern Adoption Epic #517 — Templates-First Hook (#519)** — NEW `hooks/pre-bash-templates-first.mjs` PreToolUse hook + transcript-history helper. Detects `gh`/`glab` issue/MR/release create without prior template read, prompts operator to read template first. Per-session bypass via `/templates-ack` command. Session Config: `templates-first.enabled` (default `true`), `templates-first.hosts` (default `[github, gitlab]`). Symlink rejection via `lstatSync` + symmetric bypass-prefix strip.
- **gsd Pattern Adoption Epic #517 — Slopcheck (#520)** — NEW `scripts/lib/slopcheck.mjs` `classifyPackages()` defends against LLM-hallucinated package names ("Slopsquatting"). Classifications: `LEGITIMATE` (download_count > threshold), `ASSUMED` (very new / low downloads — warning), `SUS` (audit warning — confirmation required), `SLOP` (not in registry — hard block in plan-flow). NEW `skills/discovery/probes/supply-chain-slopcheck.mjs`. NEW plan Phase 3.5 Package Legitimacy Audit. Session Config: `slopcheck.enabled` (default `false`), `slopcheck.sources` (`[plan, discovery]`). Complementary to SEC-020 baseline (`ignore-scripts=true`, `block-exotic-subdeps=true`, `minimum-release-age=1440`).
- **gsd Pattern Adoption Epic #517 — Bounded Auto-Fix Loop (#521)** — `runQualityGateWithRetry()` from `scripts/lib/quality-gate.mjs` dispatches up to N code-implementer fixer-agent retries on inter-wave Quality-Gate failure before hard abort. Fixer prompt MUST include `.claude/rules/test-quality.md` "test-the-mock" anti-pattern reminder. Diagnostics-bundle written to `.orchestrator/metrics/verification-failures/<ISO>.json` on retry exhaustion. NEW `.claude/rules/quality-gates-autofix.md`. NEW `scripts/lib/qg-command-drift-banner.mjs` (RCE-equiv trust-anchor banner). Session Config: `verification-auto-fix.enabled` (default `false`), `verification-auto-fix.max-retries` (2).
- **Persona-Panel Foundation (#457–#480)** — NEW `skills/persona-panel/` skill + `commands/persona-panel.md` + `templates/personas/` (4 personas: buyer, expert, compliance, custom). Three reconciliation modes: voting-quorum (majority approves), hard-gate-threshold (any veto blocks), coordinator-summary (advisory only). Dispatches N persona agents in parallel via `Agent` tool, writes timestamped sidecars to `.orchestrator/persona-panel/<ISO>/`. Polish triplet (#474 #479 #480) hardens reconciliation contract.
- **harness-audit Cat-8 flagship (#472–#478)** — NEW `skills/harness-audit/` 8-category rubric scoring (Anthropic large-codebase best-practice rubric), `commands/harness-audit.md`. Surfaces architectural smells via correctness/debt sub-cluster.
- **repo-audit baseline compliance skill** — NEW `skills/repo-audit/` 9-category checklist (Configuration, Code Quality, Git Hygiene, CI/CD, Testing, Security, Documentation, Clank Integration optional, MCP Configuration). Markdown report + JSON sidecar at `.orchestrator/metrics/repo-audit-<timestamp>.json`. Companion `commands/repo-audit.md`.
- **gitlab-portfolio skill (GL #41 #42)** — NEW `skills/gitlab-portfolio/` + `commands/portfolio.md`. Cross-repo health dashboard discovered from vault `01-projects/*/_overview.md` frontmatter. Aggregates open issues, MRs, critical labels, stale signals via parallel `glab`/`gh` calls; writes idempotent `_PORTFOLIO.md`. Session-start Phase 2.7 dry-run banner when `gitlab-portfolio.enabled: true`.
- **Auto-skill-dispatch meta-skill** — NEW `skills/using-orchestrator/` phrase-match meta-skill. Silent no-op when `auto-skill-dispatch: false` (default).
- **Architecture skill** — NEW `skills/architecture/` (LANGUAGE.md vocabulary — Module / Interface / Implementation / Depth / Seam / Adapter / Leverage / Locality). Surfaces shallow modules and hypothetical seams.
- **convergence-monitoring skill** — NEW `skills/convergence-monitoring/`. Three signals (shrinking diff, pass-rate plateau, velocity) drive Stop/Continue/Investigate at inter-wave checkpoints. Primary consumer: `/autoresearch` loops + wave-executor inter-wave checkpoints.
- **Frontmatter-guard skill** — NEW `skills/frontmatter-guard/`. Injects canonical vault frontmatter schema snippet into agent prompts before vault-write tasks. Wired into wave-executor pre-dispatch hook.
- **Mode-selector skill — Phase B-2 wired** — `selectMode(signals)` pure function, first wired invocation at session-start Phase 7.5 (pre-Phase-8). High-confidence output pre-selects AUQ option. Writes `mode-selector-accuracy` learning to `learnings.jsonl` (Phase B-4).
- **prompt-caching always-on rule (#421)** — NEW `.claude/rules/prompt-caching.md` path-scoped rule (PC-001..PC-007). Documents Anthropic prompt-caching placement discipline (last shared block, never on per-request placeholder), 5-min vs 1h TTL trade-off, `max_tokens: 0` pre-warm pattern + hard rejections, Vercel AI SDK adapter shape, breakpoint budget + order (4 max, tools→system→messages, 20-block lookback), PC-007 smoke test for cache-hit verification.
- **verification-before-completion always-on rule (#38)** — NEW `.claude/rules/verification-before-completion.md`. Iron Law: *NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE*. 5-step Gate Function (IDENTIFY → RUN → READ → VERIFY → STATE), Common Failures table, 9 banned phrases.
- **receiving-review always-on rule (#40)** — NEW `.claude/rules/receiving-review.md`. 6-step pattern (READ → UNDERSTAND → VERIFY → EVALUATE → RESPOND → IMPLEMENT). 6 forbidden phrases (no performative agreement). Source-specific posture table. YAGNI check before "implement properly" suggestions.
- **loop-and-monitor always-on rule** — NEW `.claude/rules/loop-and-monitor.md`. Decision tree for `/loop` vs `Monitor` vs Routines/Desktop scheduled tasks. Coverage rule: Monitor filter must match every terminal state (silence is not success).
- **Marketplace + SEC cluster (GH #44 + #43 + #34 + GL #213)** — four-issue cluster shipped via 2026-05-16 deep-4. User-facing additions: SEC path-traversal guard on `--vault-dir`/`vault-integration.vault-dir` (CWE-22), Codex composer plugin icon, awesome-codex-plugins icon-enhancement submission docs, ComposioHQ/awesome-claude-plugins submission refresh (v3.2→v3.6 + new "Session & Workflow Orchestration" category proposal). Tests **5285 → 5303** (+18: 5 Q1 path-traversal + 12 Q2 R6 composerIcon + 1 foreign-session port-fix). validate-plugin **43 → 46** (+3 R6 codex `composerIcon` field-presence + file-exists + valid-XML/SVG-root checks).
  - **`scripts/lib/gitlab-portfolio/cli.mjs` path-traversal guard (#44, SEC)** — applies `validatePathInsideProject` (two-phase: lexical + symlink) to resolved `--vault-dir` against `os.homedir()`. Rejects `/tmp/../etc`, symlink escapes, and out-of-home absolutes with `exit 2`. Mirrors `scripts/lib/playwright-driver/runner.mjs:130-142` pattern (set in #402, deep-5). New `### Security` subsection in `skills/gitlab-portfolio/SKILL.md` documents the contract.
  - **Codex plugin icon (#43, NEW)** — `assets/icon.svg` (512×512, currentColor, five-wave glyph representing the 5-wave orchestration model). `.codex-plugin/plugin.json` `interface.composerIcon` field references it. Also bumped stale `.codex-plugin/plugin.json` version 3.5.0 → 3.6.0 to match `package.json`.
  - **Marketplace submission prep (#34 + #213)** — `docs/marketplace/awesome-codex-plugins-submission.md` (NEW) + `docs/submissions/awesome-codex-plugins-pr-body.md` (NEW) for the hashgraph-online/awesome-codex-plugins icon-enhancement PR (existing listing). `docs/marketplace/composio-submission.md` refreshed v3.2.0→v3.6.0 (feature summary + comparison table updated). `docs/submissions/composio-awesome-claude-plugins-pr-body.md` (NEW) for ComposioHQ/awesome-claude-plugins. Both upstream PRs deferred to operator action.

- **Anthropic-adoption cluster (GL #409 #410 #411 #412 #414 + GH #45)** — six patterns adopted from Anthropic-published reference repos. User-facing additions: new operator-steering hook (mid-wave guidance via `STEER.md` handshake), `mcp-builder` SKILL.md docs for `@tool` decorator + in-process MCP, security-reviewer false-positive exclusions reducing noise ~35%→15%. Components: 37 skills, 16 commands, **11 hook handlers** (+1: `hooks/operator-steer.mjs`), **11 hook matchers** (+1: PostToolBatch entry for operator-steer). Tests **5255 → 5285** (+30). validate-plugin 43/43.
  - **`hooks/operator-steer.mjs` (#409, NEW)** — PostToolBatch hook reading `.orchestrator/STEER.md`, emitting contents as `{ systemMessage }` JSON to stdout, then truncating. Lets the operator inject guidance mid-wave without aborting. Errors swallowed (always exit 0). Adopted from `anthropics/cwc-long-running-agents` claude-code-config/.claude/hooks/steer.sh. Registered in both `hooks.json` (Claude Code) and `hooks-codex.json` (Codex CLI). Cursor support deferred (different event model).
  - **`skills/mcp-builder/SKILL.md` updated (#410)** — new "Tool-Hosting Pattern wählen — In-Process vs Stdio MCP" section after Phase 1 (Research & Plan). Decision tree (≤5 tools / latency-critical / no external auth → in-process; else stdio), `@tool` decorator Python + TS `registerTool` snippets, `readOnlyHint`/`destructiveHint` annotation docs, trade-off table. Adopted from `anthropics/claude-agent-sdk-python` (examples/mcp_calculator.py). File grew 164→250 lines.
  - **OTel `gen_ai.*` aliases on subagents.jsonl (#411, additive)** — `gen_ai.usage.input_tokens` + `gen_ai.usage.output_tokens` + `gen_ai.system: "anthropic"` alongside existing `token_input`/`token_output`. Schema-version stays at 1 (additive optional fields, backwards-compat). Source: `anthropics/claude-code-monitoring-guide` OTel Semantic Conventions for GenAI. **Scope-reduced** during Discovery: events.jsonl Stop hook does not carry token/model fields; `gen_ai.request.model` and `gen_ai.response.finish_reasons` require upstream harness changes and are deferred.
  - **`agents/security-reviewer.md` Hard Exclusions section (#412)** — 5 new FP-pattern sub-classes (Open Redirect without CWE-601 surface, Memory-Safety in GC'd languages, Regex catastrophic backtracking without trigger, SSRF in HTML-only routes, Memory Leak without reproducer) plus cross-references to existing Exclusions and Confidence Calibration sections. Empirical FP-reduction ~35%→15% per upstream `anthropics/claude-code-security-review` (claudecode/findings_filter.py:L20-100). File grew 183→212 lines.
  - **`docs/marketplace/knowledge-work-plugins-submission.md` + `docs/submissions/knowledge-work-plugins-pr-body.md` (#414, NEW)** — submission prep for `anthropics/knowledge-work-plugins` Cowork-Marketplace. Manifest already compliant with Anthropic's canonical schema (`name`, `description`, `author.name`, `author.email`); npm-style additions (`version`, `homepage`, `repository`, `license`, `keywords`) are tolerated extensions. Trimmed README plan + PR body drafted. External branch/PR step intentionally deferred (manual).
  - **`scripts/lib/gitlab-portfolio/aggregator.mjs` execWithTimeout refactor (GH #45)** — `promisify(execFile)` does NOT honor AbortSignal; refactored to raw `spawn()` + `controller.signal` per `scripts/lib/playwright-driver/runner.mjs:232-245` pattern (set in #399). Opts-override key renamed `execFile`→`spawn`. EventEmitter-style child mock helper added to `tests/lib/gitlab-portfolio/aggregator.test.mjs`. Signature `execWithTimeout(cmd, args, opts) → { stdout, stderr }` preserved.

- **Superpowers-adoption cluster (GH #35 umbrella + #36 #37 #38 #39 #40)** — five high-leverage patterns adopted from [obra/superpowers](https://github.com/obra/superpowers). User-facing additions: 2 new slash commands (`/brainstorm`, `/debug`) + 2 always-on rules. Components: **37 skills** (+3: `brainstorm`, `debug`, `write-executable-plan`), **16 commands** (+2: `/brainstorm`, `/debug`), **17 rules** (+2: `verification-before-completion`, `receiving-review`). 11 NEW files + 9 cross-ref edits across `wave-executor`, `code-implementer`, `session-reviewer`, `plan`, `session-plan`, and 3 existing rule files. Tests **5129 → 5256** (+127). validate-plugin 43/43.
  - **`/brainstorm` skill + command (#36)** — lightweight Socratic design dialogue (3–5 AUQ rounds) before any implementation work. HARD-GATE prevents Edit/Write tool use until the user approves the design. Writes spec to `docs/specs/YYYY-MM-DD-<slug>-design.md`. Hand-off to `/plan feature` (primary) or `/write-executable-plan` (alternative). Use BEFORE `/plan feature` when scope/UX is still ambiguous.
  - **`/debug` skill + command (#37)** — 4-phase systematic debugging with Iron Law: *NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST*. Phases: Root Cause → Pattern → Impact → Solution. Writes a Phase-1 artifact at `.orchestrator/debug/<session>-<n>.md` that fix-implementers must reference. wave-executor Error Recovery now routes bugfix-classified tasks through this skill.
  - **`.claude/rules/verification-before-completion.md` (#38, always-on)** — Iron Law: *NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE*. 5-step Gate Function (IDENTIFY → RUN → READ → VERIFY → STATE), Common Failures table, 9 banned phrases ("should pass", "looks correct", "Great!", "Done!", etc.). Bidirectional See-Also with `development.md`, `testing.md`, `cli-design.md`. Same enforcement weight as `ask-via-tool.md` (AUQ-001) and `parallel-sessions.md` (PSA-001).
  - **`.claude/rules/receiving-review.md` (#40, always-on)** — 6-step pattern for handling code-review feedback: READ → UNDERSTAND → VERIFY → EVALUATE → RESPOND → IMPLEMENT. 6 forbidden phrases (no performative agreement: "You're absolutely right!", "Great point!", "Excellent feedback!", "Let me implement that now"). Source-specific posture table (human=trust-after-understanding, plugin reviewers=skeptical, security=take-seriously). YAGNI check before "implement properly" suggestions.
  - **`skills/write-executable-plan/` skill (#39)** — bite-sized executable-plan format consumed by other skills. Mandatory 5-step structure per Task: write-failing-test → run-to-confirm-failure → implement → verify-pass → commit. Phase 4 placeholder linter rejects `TBD` / `TODO` / `FIXME` / `XXX` / "add appropriate error handling" / "similar to Task N" / `<placeholder>`. Reference dogfood plan at `docs/plans/2026-05-16-superpowers-cluster.md` documents this very session in the format. wave-executor, code-implementer, and session-plan updated to prefer bite-sized plans when present.
- **`/memory-cleanup` command + skill** — Manual memory consolidation (Dream-equivalent). Ports the previously personal `~/.claude/skills/memory-cleanup/` into the plugin so all users get it. Implements the 4-phase Dream process (Orient → Gather Signal → Consolidate → Prune & Index) against `~/.claude/projects/*/memory/`.

- **Clawpatch Borrow cluster (#415–#420)** — six architectural patterns borrowed from the upstream Clawpatch repo. Patterns adopted at hook, skill, agent, and rule levels.

- **Claude Code 2.1.x adoption matrix (#427–#436, #426)** — harness-alignment for Claude Code 2.1.x cohort. Monitor cadence `when=on-skill-invoke` (#427 follow-up), echo-stub detector for skill-output validation, deeper hook signal propagation. Documentation in `docs/research/2026-05-17-clawpatch-cluster.md` + companion notes for prompt-cache pre-warming (#421 follow-on).

- **Pre-commit owner-leakage hook (#494)** — `.husky/pre-commit` now invokes `scripts/lib/validate/check-owner-leakage.mjs` against the staged tree, blocking commits that leak private slugs, home paths, or non-public hosts. Closes the `git add <leak> && git commit` window that CI couldn't catch. `--no-verify` remains available but logs a warning per `.claude/rules/development.md` Git Safety Protocol. Regression test in `tests/husky/pre-commit-owner-leakage.test.mjs`.

- **Privacy/Public-Mirror Epic (#462 #461 #468 #469 #470 #471)** — generic vault-migration scripts via per-user config, deep-1 operator-narrative docs moved to vault, CHANGELOG slug-leak fix (#5d1f241), private-slug template rename to neutral identifier (#ae6d5e9). `scripts/migrate-vault-paths.mjs` + `scripts/run-migrate-v2-cross-repo.mjs` + `scripts/sync-vault-schema.mjs` are now config-driven.

- **GitHub social-preview tooling (`scripts/upload-social-preview.mjs`)** — Playwright-based GitHub social-preview (OG card) upload. NEW `assets/og-card.svg` + `assets/og-card.png` (1280×640) exported source. Companion `chore(launch-readiness): README rewrite + GitHub settings + steering drift + 3 mermaids + OG card` (#701edde).

### Changed

- **`scripts/parse-config.mjs` — preserve `~/`-paths + inline YAML object literals (#497)** — earlier `parse-config.mjs` collapsed `~/path/foo` → empty string and dropped inline `{ … }` YAML object literals (e.g. `memory:\n  banner: { enabled: true }`). Both now round-trip correctly. Fix shipped via `fix/parse-config-tilde-paths-497` MR merged 2026-05-22.
- **Coordinator model — sonnet → opus on Claude Code path** — `skills/wave-executor/SKILL.md` + `commands/go.md` now default to `opus` for the coordinator role on Claude Code (parity with Codex default). Brings the orchestrator within the Anthropic best-practice cohort for orchestration agents. Override remains available via `agent-mapping.coordinator-model`.
- **`/session` slash-command model-invocable (#cfb4f3a)** — `commands/session.md` no longer carries `disable-model-invocation: true`. Slash-command-via-model lookup now succeeds. Companion lint canary in `validate-plugin.mjs` enforces the naming convention.
- **CLAUDE.md lean-root refactor** — top-level CLAUDE.md trimmed; deep narrative moved to `.orchestrator/steering/` + Meta-Vault `01-projects/session-orchestrator/decisions.md`. New `agents/AGENTS.md` (path-scoped) carries sub-agent authoring spec.
- **`.orchestrator/runtime/` gitignored (#20aa844)** — fixes W5 2026-05-22 deviation drift artifact noise.

### Fixed

- **`/evolve` null-subject dedupe collapse (#284, consumer repo)** — `consolidateDuplicates` in Phase 3.5 step 7 and Phase 4.4 step 4 previously keyed on `${type}::${subject}`, which coerced `null` to the string `"null"` and collapsed all null-subject entries of the same type to a single survivor. Fix: entries with null/empty/missing `subject` are now keyed by their always-unique `id`, so each is preserved individually. Named-subject entries continue to dedupe as before (highest confidence wins). Companion regression test: `tests/skills/evolve/dedupe-null-subject.test.mjs` (10 assertions: 7 positive contract + 3 negative proof of old breakage).
- **`scripts/vault-consolidate.mjs` isUtf8() binary detection (#508)** — `vault-consolidate` previously crashed on binary files in vault paths (PNG/PDF). Now uses `Buffer.isUtf8()` to skip non-text files cleanly. Closes #508.
- **Memory-Proposals W2 + W4 regression cluster (#543 #544 #545 #540 #541)** — hardening sweep on F2.1: W2-I1 PID-liveness in `scripts/lib/memory-proposals/store.mjs` + path-utils `canonicalizeRoot` (mirrors `session-lock.mjs`); W2-I2 `SO_WAVE_AGENT=1` env-var guard via prompt-injection (full status dict: queued=0, quota-exceeded=1, rejected-low-confidence=2, rejected-wrong-context=3, error=4); W2-I3 `_parseMemoryProposals` locality move -121 LOC; W2-I4 3-layer ISO-8601 defense (placeholder→programmatic, validator regex, regression test). +44 tests.
- **Memory-Proposals Tail-End Sweep (#546 #547 #548 #549 #495 #509)** — surfaced real audit-hook regex leak (#546) + latent W? waveId contract violation (#547) during W4 review. Both fixed in-session.
- **CI green restoration follow-ons** — owner-leakage CI guard `SELF_EXCLUSIONS` for persona content-lint test (#68e6195), plugin-schema-validate ajv-cli local fetch (#84455b), windows-runner cross-platform `process.execPath` + `path.delimiter` + CRLF normalization (#6d41c71), gitleaks image entrypoint disable (#a8a64a9), test timeout 30s + apt-get guard (#479181c).
- **`scripts/lib/language-mappers/typescript.mjs` ExportAllDeclaration handling (#454)** — TypeScript mapper now correctly parses `export * from 'x'` statements (`ExportAllDeclaration` AST node type). Previously silently dropped re-exports.
- **W5 security-reviewer MEDs (#aebc1df)** — npm argv injection guard + bypass-prefix boundary fix shipped via security-reviewer follow-on.

### Quality verification

- 7360 vitest passing, 12 skipped, 0 failed (was 5001 at v3.6.0 cut, **+2359 tests, ~47% growth**)
- typecheck 230 files OK (was 67 at v3.6.0 cut)
- lint 0 errors
- validate-plugin **94/94** (was 43 at v3.6.0 cut)
- doc-consistency 0 findings
- check-owner-leakage **0 leaks across 995 scanned files**
- gitleaks 0 leaks
- npm audit 0 high-severity vulnerabilities
- GitLab CI pipeline #4713 on `00684df` — all 6 stages green (gitleaks-scan, npm-audit, owner-leakage, test, schema-drift-check, coverage)

### Components (current)

- **37 skills** (+3 since v3.6.0: `persona-panel`, `harness-audit`, `repo-audit`; net unchanged from [Unreleased] mid-point as `gitlab-portfolio`, `convergence-monitoring`, `architecture`, `using-orchestrator` were all added during v3.6.0→v3.7.0 cycle)
- **18 commands** (+6 since v3.6.0: `/brainstorm`, `/debug`, `/memory-cleanup`, `/persona-panel`, `/harness-audit`, `/repo-audit`, `/portfolio`, `/templates-ack`, `/autopilot-multi` — net +6 visible)
- **13 agents** (+2 since v3.6.0: `dialectic-deriver`, `memory-proposal-collector`; `analyst` was added earlier in [Unreleased])
- **14 hook handlers** (+3 since v3.6.0: `pre-bash-memory-propose-audit`, `pre-bash-templates-first`, `cwd-change-restore`, `enforce-commands`, `operator-steer`)
- **20 always-on + path-scoped rules** (+5 since v3.6.0: `verification-before-completion`, `receiving-review`, `loop-and-monitor`, `prompt-caching`, `quality-gates-autofix`)

## [3.6.0] - 2026-05-14

Five deep sessions plus three intermediate fix-clusters since v3.5.0. The headline feature is the agentic `/test` command — a web/macOS end-to-end test orchestrator with a 4-check UX rubric, two test drivers (Playwright + Peekaboo), a `ux-evaluator` reviewer agent, and issue-tracker reconciliation. Tests grew from 4430 to **5001** (+571), validate-plugin 27 → **43** (+16 R5 grep-canaries), zero breaking changes, zero CI regressions.

1. **2026-05-10 deep — ADR-364 thin-slice (#364–#374)** — autopilot `--multi-story` v1 scaffold (`scripts/autopilot-multi.mjs`), `gc-stale-worktrees` defence (#374 realpathSync symlink-escape fix), `validateWorkspacePath`, lazy `zx` import to dodge a CI fork-pool regression (#341).
2. **2026-05-10 deep-2 — CI restoration (#367 #368 #369)** — 8-pipeline silent regression fixed (root cause: `skills/vault-sync/pnpm-lock.yaml` tracked despite gitignore conflict with `engine-strict=true`).
3. **2026-05-14 deep-1 (Track A) — `/test` command Track A (#379 #380 #382)** — `agents/ux-evaluator.md` (4-check rubric: onboarding step-count ≤7, axe critical/serious, console-errors, Apple-Liquid-Glass `.glassEffect()` conformance on SwiftUI 26+), `skills/playwright-driver/SKILL.md` (MCP-wired driver with screenshots / traces / `axe-*.json` / `console.ndjson` artifact layout), `skills/test-runner/` skeleton (phase model: Setup → Drive → Evaluate → Reconcile → Report), 4 NEW helper modules in `scripts/lib/test-runner/`. validate-plugin 28 → 31.
4. **2026-05-14 deep-1 — `/test` command + CI restore + reconcile glab (#383 #384 #388 #389)** — `commands/test.md` + Session Config `test:` block + profile registry schema (web-gate + mac-gate seeds at `.orchestrator/policy/test-profiles.json`), extended `issue-reconcile.mjs` with `listExistingFindings/createFinding/updateFinding/triageDecision` + sentinel-injection hardening + maxBuffer/body-length cap parity with `mr-draft.mjs`. validate-plugin 31/31.
5. **2026-05-14 deep-2 — `/test` Track B + mechanism-proof (#381 #385)** — `skills/peekaboo-driver/SKILL.md` (macOS native UI driver, 3-phase platform + permissions + remediation gate, AX-snapshot pattern), `scripts/lib/playwright-driver/runner.mjs` (260 LOC `spawn` + `AbortSignal` + profile registry integration + axe-core soft-skip + exit-code mapping 0/1/2), mechanism-proof via `--dry-run` against an EspoCRM web target. validate-plugin 31 → 34.
6. **2026-05-14 deep-3 — `/test` live-run + cluster (#385 #390 #391 #393 #394 #387 #392)** — first end-to-end live execution against a containerized EspoCRM web target, runner reporter syntax fix (`html,json` canonical, not `html:<path>` Jest-style), `isPathInside` traversal validation in `config/test.mjs` and `profiles/schema.mjs`, peekaboo SKILL.md polish, `.claude/rules/testing.md` § "Shared-Hardware Runner Contention (Mac shell executors)" subsection added. validate-plugin 34 → 36.
7. **2026-05-14 deep-4 — `/test` pipeline housekeeping (#395 #396 #397 #398 #399 #400 #401)** — Division-of-Responsibility doc-sync (driver writes scaffold + HTML/JSON/traces; test fixture writes `ax-snapshots/` + `axe-*.json` + `console.ndjson`), `shared/profiles` → `profiles/` rename, runDir path-traversal hard-error guard, AbortController test gap closed, two-phase realpath guard in 3 callsites, `@lib/*` vitest alias scaffolded, `RUBRIC_GLASS_V2=1` env-gate for glass-modifiers stub. validate-plugin 36 → 39.
8. **2026-05-14 deep-5 — `validatePathInsideProject` helper + @lib alias rollout + boundary tests (#402 #404 #405 #406; #407 filed)** — NEW `scripts/lib/path-utils.mjs` `validatePathInsideProject(p, root)` (tagged-union `{ ok, realPath, lexicalPath, reason }`, adopted at all 3 callsites with 3-line adapters preserving each callsite's original semantics), 33 test files migrated to `@lib` vitest alias, NEW `tests/lib/playwright-driver/runner-boundary.test.mjs` (3 falsification tests: PATH_MAX-via-traversal, null-byte env-strip, double-abort idempotency), TOCTOU fix in `tcProfilesPath` storage (symmetric in `schema.mjs` rubric), `mkdtempSync` worktree-freshness flake eliminated. validate-plugin 39 → **43**. Tests 4982 → **5001p/0f/12s**.

No breaking changes. The `/test` command and `commands/autopilot.md --multi-story` are opt-in additions; existing `/session`, `/go`, `/close` flows are byte-equivalent.

### Added (Unreleased) — /test command (#378–#407)

- **`/test` command** (commands/test.md, 86 LOC) — agentic end-to-end test orchestrator. Drives web flows (Playwright) and macOS native UI (Peekaboo); evaluates against `skills/test-runner/rubric-v1.md`; reconciles findings with the open issue tracker via `scripts/lib/test-runner/issue-reconcile.mjs`. Wraps upstream tools (no forks). Hard-gates Playwright MCP for browser drive (4× token cost vs CLI per Microsoft's own benchmark).
- **`skills/test-runner/`** — phase model (Setup → Drive → Evaluate → Reconcile → Report), profile registry with web-gate + mac-gate seeds, `rubric-v1.md` (4 checks).
- **`skills/playwright-driver/`** — thin driver wrapper around `playwright@1.60.0`. Captures token-frugal AX-tree snapshots + screenshots + console.ndjson under `.orchestrator/metrics/test-runs/<run-id>/`. `runner.mjs` (260 LOC) with `spawn` + `AbortSignal` + axe-core soft-skip + DI seams.
- **`skills/peekaboo-driver/`** — thin driver wrapper around `@steipete/peekaboo@3.1.2`. Captures native macOS UI snapshots. 3-phase guard (platform + permissions + remediation).
- **`agents/ux-evaluator.md`** — read-only opus agent that applies the 4-check rubric (onboarding step-count ≤7, axe critical/serious, console-errors visible to user, Apple-Liquid-Glass `.glassEffect()` conformance on SwiftUI 26+) against driver-captured artifacts and emits stable-fingerprint findings JSON.
- **`scripts/lib/path-utils.mjs`** — `validatePathInsideProject(p, root)` two-phase lexical+realpath guard with tagged-union return. Adopted at 3 callsites with 3-line adapters preserving silent-skip vs throw vs hard-error semantics.
- **`scripts/lib/test-runner/`** — `fingerprint.mjs`, `artifact-paths.mjs`, `issue-reconcile.mjs`, profile registry+schema. Pure helper modules, DI-friendly.
- **R5 grep-canary validators** — `check-playwright-mcp-canary.mjs`, `check-peekaboo-driver-canary.mjs`, `check-path-utils-canary.mjs` extend `validate-plugin.mjs` from 28 to 43 PASS checks.

### Added (Unreleased) — autopilot multi-story (#364–#374, #341)

- **`scripts/autopilot-multi.mjs`** — `--multi-story` orchestration mode running N parallel issue pipelines in isolated git worktrees with per-loop kill-switches. Built on the ADR-364 substrate (sessions.jsonl optional fields, autopilot.jsonl extensions, `STALL_TIMEOUT` kill-switch, `gc-stale-worktrees`, `validateWorkspacePath`).
- **`gc-stale-worktrees`** — realpathSync symlink-escape defence (#374) prevents removal of worktrees that resolve outside the configured root.

### Changed (Unreleased)

- **`shared/profiles` → `profiles/` rename** (#400) — 6 mechanical refs + 2 `git mv` + 3 new R5 anchor canaries (ARCH-PD-MED-3 closure).
- **`@lib/*` vitest alias** — 33 test files now use `import … from '@lib/…'` instead of `'../../../../scripts/lib/…'` (reduces relocation churn). Remainder (~25 files + 2 dynamic-import files) deferred to #407.
- **CLAUDE.md trim** — 46.3k → 8.9k chars. 5 deep-session narratives moved to vault `decisions.md` as canonical long-form; CLAUDE.md keeps one-line summaries + commit index.
- **README test-count badge** — 4944 → 5001.
- **`.gitignore`** — `.orchestrator/scratch/` added; `.orchestrator/metrics/test-runs/` covered.

### Fixed (Unreleased)

- **CI red on `cb3e942` (#367–#369)** — 8-pipeline silent regression. Root cause: `skills/vault-sync/pnpm-lock.yaml` tracked despite `.gitignore:63` forbidding it — lockfile conflict + `engine-strict=true` → silent `npm install` exit-1. Also: `.github/workflows/test.yml` `fetch-depth: 1 → 0` (gitleaks revision-range was breaking).
- **runner.mjs reporter syntax bug (deep-3)** — Playwright rejected `--reporter html:<path>,json:<path>` (Jest/Vitest-style) with "Cannot find module 'html:<path>'". Fixed inline via canonical `--reporter html,json` + env vars `PLAYWRIGHT_HTML_OUTPUT_DIR` / `PLAYWRIGHT_JSON_OUTPUT_FILE` / `PLAYWRIGHT_HTML_OPEN=never`. 8 regression canaries with `/html:/` + `/json:/` Jest-style substring-rejection lockdown added by Q1 test-writer in deep-3.
- **runDir path-traversal MED (#398)** — `scripts/lib/playwright-driver/runner.mjs:110` lacked traversal check on `path.join(runsRoot, runId)`. Hardened with `isPathInside` guard + Phase 2 realpath upgrade in deep-4 Q-polish.
- **TOCTOU in `tcProfilesPath` storage (#405)** — raw user-supplied path stored before realpath resolution. Now stores `result.realPath || result.lexicalPath`. Symmetric pattern applied to `profiles/schema.mjs` rubric storage as Q2-LOW-2.
- **worktree-freshness flake (#406)** — `mkdtempSync` per-run unique suffix replaces `randomUUID()` suffix (atomicity + cleanup parity with existing `tmpdir()` pattern). 3/3 clean post-fix.
- **AbortController test gap (#399)** — 5 falsification-passing tests cover timer-firing on timeout, AbortSignal propagation, clearTimeout on normal exit, exit-code 2 mapping on SIGTERM, custom `timeout_ms` from profile-registry override.
- **`glabPath` arbitrary-binary injection (Q2 HIGH deep-1)** — removed `glabPath` parameter from `issue-reconcile.mjs`; replaced with `opts.execFile` DI seam mirroring `mr-draft.mjs`. `checkBodyLength` added (Q2 MED-1). Sanitizer regex flag `→ gi` (Q2 MED-2). +11 regression tests.

### Quality verification

- 5001 vitest passing, 12 skipped, 0 failed (was 4430 at v3.5.0 cut, **+571 tests**)
- typecheck 67/67
- lint 0 errors
- validate-plugin 43/43 (was 27/27 at v3.5.0 cut, **+16 R5 grep-canary checks**)
- doc-consistency 0 findings
- gitleaks 0 leaks
- npm audit 0 high-severity vulnerabilities

### Components (current)

- 32 skills (added: `test-runner`, `playwright-driver`, `peekaboo-driver`, `frontmatter-guard` from v3.4.0 onward)
- 12 commands (added: `/test`)
- 11 agents (added: `ux-evaluator`)
- 10 hook event matchers / 10 handlers

### Carryover to v3.7.0 cycle

- **#386** — mac-gate end2end (bootstrap-cost gated)
- **#403** — `RUBRIC_GLASS_V2` profile-config flag (v2 rubric gated)
- **#407** — @lib alias rollout remainder (~25 test files + 2 dynamic-import files)
- **#41** — `feat(gitlab-portfolio)`: cross-repo issue dashboard skill
- **#42** — `bug session-end quality-gate must execute test-command in execution env`
- **#35–#40** — `superpowers-adoption` umbrella + 6 sub-issues (read-only, brainstorm, verification-before-completion, bite-sized plans, receiving-code-review, systematic-debugging)
- **#297 / #298** — data-gated on autopilot RUN-Volumen (need ≥10 runs)

## [3.5.0] - 2026-05-09

Four deep sessions on top of v3.4.0 plus a non-tracked architectural refactor. Twenty issues closed (#344 to #363), tests grew from 3138 to **4430** (+1292), zero CI regressions, zero breaking changes. All sessions on `main`, isolation:none, enforcement:warn, cap=6.

1. **2026-05-08 deep-2** — 6 discovery-derived issues (#344 #345 #346 #347 #348 #349): refactor + test-coverage + validator + doc-drift. Tests 3138 → 3591 (+453). validate-plugin 22 → 27.
2. **2026-05-09 deep-1** — 5 repo-audit cluster (#350 #351 #352 #353 #354): DX + security tooling. CI security gates (gitleaks + npm-audit), git-hooks (Husky + commitlint + lint-staged), Prettier ignore-rules expansion, CLAUDE.md trim + vault long-form archival. Tests stable at 3591 (config-only changes).
3. **2026-05-09 deep-2** — 4-issue parallel-subagent cluster (#355 #356 #357 #358): CI critical fix + 16-module test backfill + 4 complexity-hotspot splits + 9th autopilot kill-switch. **5 waves × 6 parallel subagents** (first non-coord-direct deep session in 14+ session streak — explicit user override). Tests 3591 → 3888 (+297). 5 NEW production submodules + 1 NEW schema-leaf (Q3 follow-up).
4. **2026-05-09 deep-3** — 5-issue Anthropic-canonical agent-authoring alignment cluster (#359 #360 #361 #362 #363): primary-source-grounded refactor of all 10 agent files + validator alignment with [code.claude.com/sub-agents](https://code.claude.com/docs/en/sub-agents). Tests 3888 → 3896 (+8 net; existing color-pin tests rewritten, new validator-form tests added). 4 NEW frontmatter-validator behaviors (tools-array form, full model IDs, expanded color palette, error-message expansion). All 10 agents now Anthropic-reference-compliant for body length (500-3000w) + Output Format + Edge Cases sections.
5. **2026-05-09 deep-4** — 6-hotspot-split cluster (deep-4): 6 file-disjoint hotspots ≥400 LOC split into submodules <300 LOC each. Public APIs preserved via barrel re-exports — zero behavior change. Tests 3896 → 4430 (+534). 26 NEW `*.test.mjs` files. validate-plugin 27/27.

No breaking changes.

### Changed (Unreleased) — 2026-05-09 deep-3 (#359–#363)

- **#359 — `check-agents.mjs` + `agent-frontmatter.mjs` aligned with Anthropic canonical spec.** Three validator behaviors corrected against [code.claude.com/sub-agents](https://code.claude.com/docs/en/sub-agents):
  - **`tools` accepts both forms.** Comma-separated string (`Read, Edit, Write`) AND JSON array (`["Read", "Edit", "Write"]`). Anthropic's own reference agents (`anthropics/claude-code/plugins/plugin-dev/agents/agent-creator.md`, `plugin-validator.md`, `skill-reviewer.md`) all use array form — our previous validator would have rejected them. Malformed arrays (non-string elements, parse failures) still rejected with new rule codes `array-strings-only` and `malformed-array`.
  - **`color` palette expanded to 9.** Canonical Anthropic 8-color palette (`red, blue, green, yellow, purple, orange, pink, cyan`) plus `magenta` from plugin-dev SKILL.md for backward-compat. Was 6 (`blue, cyan, green, yellow, magenta, red`).
  - **`model` accepts full model IDs.** Pattern `^claude-(opus|sonnet|haiku)-\d+-\d+(-\d{8})?$` matches `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` alongside the existing alias set (`inherit, sonnet, opus, haiku`). The canonical doc explicitly accepts both forms.
  - 9 NEW unit tests in `tests/scripts/validate/check-agents.test.mjs` + 5 NEW in `tests/lib/agent-frontmatter.test.mjs`. 1 existing test rewritten (`expect(color).toBe('blue')` → `'cyan'` for docs-writer post-color-fix).
- **#360 — 4 implementer agents normalized to Anthropic-reference body length.** `code-implementer` (187w → 815w), `db-specialist` (226w → 803w), `ui-developer` (236w → 845w), `test-writer` (294w → 996w). Each gained `## Output Format` (concrete report template) and `## Edge Cases` (4-7 bullets of project-relevant unusual scenarios) per the structural pattern from `anthropics/claude-code/plugins/plugin-dev/agents/agent-creator.md`. Existing strengths preserved: code-implementer's "DO NOT" list, db-specialist's data-loss safeguards, ui-developer's WCAG AA standards, test-writer's Falsification-Rule + computed-value prohibition. test-writer also gained an inline worked example for the Falsification-Rule (#363 partial).
- **#361 — `docs-writer` + `qa-strategist` Anthropic-section compliance.** docs-writer Output-Format upgraded from short status-line to full report template; gained `## Edge Cases` section (7 bullets covering missing-git-diff, audience-ambiguity, forbidden-path requests, conflicting sources, etc.). qa-strategist gained `## Edge Cases` section (8 bullets covering coverage-tool-missing, weak-assertion-quality, mock-without-assertion, property-test-opportunity, in-wave test-quality regression).
- **#362 — Color-collision fix across 4 agents.** Three same-color groups resolved (`yellow` ×2, `blue` ×3, `cyan` ×2 → 9 distinct co-dispatchable colors). Changes: `db-specialist` blue→purple, `docs-writer` blue→cyan, `session-reviewer` cyan→pink, `test-writer` yellow→orange. `qa-strategist` (cyan) + `docs-writer` (cyan) is the only remaining shared color but the two never co-dispatch (qa-strategist is opt-in `persona-reviewers`, docs-writer is Impl-Polish sub-slot). Mapping rationale: orange/pink/purple were validated unblocked by #359.
- **#363 — Worked examples for novel rules.** `test-writer` Falsification-Check inline example (VALID `add(2,3)→5` vs WORTHLESS `typeof === 'function'` vs WORTHLESS tautological-computation, ~12 lines). `session-reviewer` Silent-failure differentiation block (6 contrast cases distinguishing *graceful* fallback from *bug*: optional cache lookup vs auth error swallow, optional feature flag vs config load swallow, UI render fallback vs data-pipeline-drops-records). `security-reviewer` fully-filled HIGH SQL-injection finding with all required fields populated (file:line, category, confidence 0.95, exploit payload, impact, remediation citing the project's existing parameterized helper).
- **`CLAUDE.md` "Agent Authoring Rules"** rewritten with primary-source citations and accurate field descriptions. Removed the misleading "MUST be a comma-separated string, NOT a JSON array" claim (was stricter than Anthropic itself). Added body-convention guidance (Anthropic reference structure + 500-3000w range) and read-only-vs-implementer tool-set patterns.

### Fixed (Unreleased) — 2026-05-09 deep-2 (#355–#358)

- **#356 — harness-audit JSON truncation at byte 8188 (10+ failed CI runs since 2026-05-01)** — `scripts/harness-audit.mjs:256` was async-writing the final JSON to stdout, then immediately calling `appendAuditRecord()` + `writeSummary()` + `process.exit(0)`. On CI runners (both GitLab and GitHub Actions, both macOS and Windows), the process exited before the stdout pipe drained, truncating output at the OS pipe-buffer boundary (8 KiB on many Linux kernels = 8188 = 8192 − 4). Local runs were green because pipes drain instantly on dev hardware. **Fix:** Pattern A drain-aware `process.stdout.write(payload, callback)` — `appendAuditRecord` + `writeSummary` + `process.exit(0)` now run inside the drain callback. Q1 follow-up: added explicit `return;` after the error-path `process.exit(2)` to prevent fall-through to success-path side effects on stdout-write failure. NEW regression test in `tests/integration/harness-audit.integration.test.mjs` asserts `stdout.length > 8500` (floor above CI failure boundary, per test-quality.md floor/ceiling rule) AND `JSON.parse(stdout)` does not throw AND `stdout.trim().endsWith('}')`. Local verification: 12,519 bytes ending with `}\n`. Issue closed.

### Added (Unreleased) — 2026-05-09 deep-2 (#355–#358)

- **#355 — autopilot cumulative token-budget kill-switch (cross-repo from baseline#252)** — 9th kill-switch (`TOKEN_BUDGET_EXCEEDED: 'token-budget-exceeded'`). Implemented per the 9-step plan in the issue body: `FLAG_BOUNDS.maxTokens = { min: 0, max: 10_000_000, default: 500_000 }`; new entry in `KILL_SWITCHES`; check in `preIterationKillSwitch` after MAX_HOURS, before RESOURCE_OVERLOAD (cheap check first); accumulator in `runLoop` after `state.iterations_completed += 1` reading `sessionResult.usage.output_tokens` (or `total_tokens` as fallback); `total_tokens_used` field on `AutopilotState`; additive update to `skills/wave-executor/SKILL.md` Return Shape Contract documenting the `usage?` field. **Forward-compat:** when sessionRunner doesn't emit `usage`, `cumulativeTokens` stays 0 and the kill-switch never fires. Q4 follow-up: defaulted `opts.maxTokens` resolution to `0` (off, opt-in) instead of `FLAG_BOUNDS.maxTokens.default` to prevent a silent 500k cap on every existing caller once wave-executor starts populating `usage`. 3 NEW tests in `tests/lib/autopilot.test.mjs` (fires correctly, forward-compat preserved, accumulator monotonic). Issue closed.
- **#357 — backfill 16 untested modules in `scripts/lib/`** — 16 NEW `*.test.mjs` files, ~3,000 LOC of previously per-file-untested production code now covered. Distributed across 5 W2/W3 batches (file-disjoint, parallel-safe per W1 D5 conflict matrix). +297 net tests (3591 → 3888). Coverage:
  - `tests/lib/harness-audit/categories/category{1..7}.test.mjs` (7 NEW, 58 tests) — happy-path + failure + edge per category
  - `tests/lib/resource-probe/{probe-platform,evaluate,parsers}.test.mjs` (3 NEW, 99 tests) — pure functions hardcode-asserted, mocked spawn for branch coverage
  - `tests/lib/{owner-interview,workspace}.test.mjs` (2 NEW, 34 tests) — mocked owner-yaml + zx git
  - `tests/lib/ecosystem-wizard/{config-writer,wizard-prompt}.test.mjs` (2 NEW, 42 tests) — file-I/O + readline answer-injection
  - `tests/lib/vault-backfill/{glab,template}.test.mjs` (2 NEW, 32 tests) — mocked spawnSync + template cache
  - All files follow `.claude/rules/test-quality.md`: hardcoded expected values, floor/ceiling for dynamic counts, no Assert-Nothing / Test-the-Mock / Tautological Computation. Issue closed.
- **#358 — 4 complexity hotspots split into submodules** — 5 NEW production submodules:
  - `scripts/lib/autopilot/kill-switches.mjs` (148 LOC) — `KILL_SWITCHES` enum (now 9 entries) + `preIterationKillSwitch` + `postSessionKillSwitch`. `autopilot.mjs` 535 → 412 LOC.
  - `scripts/lib/state-md/recommendations.mjs` (57 LOC) — `parseRecommendations`. `state-md.mjs` 610 → 563 LOC.
  - `scripts/lib/mode-selector/context-pressure.mjs` (157 LOC) — `computeContextPressure` + 3 inlined helpers. `mode-selector.mjs` 572 → 480 LOC. Per W1 D3 risk warning, full per-signal scorer split (carryover/confidence/bootstrap/learnings) deferred — only the cleanly-separable `computeContextPressure` extracted this session.
  - `scripts/lib/learnings/io.mjs` (120 LOC) + `scripts/lib/learnings/filters.mjs` (43 LOC). `learnings.mjs` 529 → 39 LOC barrel after Q3 follow-up.
  - **Q3 follow-up:** NEW `scripts/lib/learnings/schema.mjs` leaf (~330 LOC) — extracts the schema/validator layer to break the circular-import topology that the original split produced (`learnings.mjs` re-exporting children that imported back from parent). Both children now import from sibling `./schema.mjs`; `learnings.mjs` is a thin barrel. Unidirectional dependency graph: `schema → io → filters → barrel` (no cycle).
  - All 4 hotspots now < 500 LOC. All public APIs preserved via barrel re-exports — verified by NEW `tests/lib/refactor-stability.test.mjs` (24 adapter tests asserting symbol presence + 1 smoke call per re-export). Issue closed.

### Quality verification

- 184 test files / **3888 pass** / 11 skip / 0 fail (baseline 3591 → +297). typecheck 66/66. lint 0 errors. validate-plugin 27/27. check-doc-consistency 0 findings. harness-audit emits 12,519 bytes ending with `}\n` locally — root cause of the 10+ run CI streak fixed.

### Carry-forward (next session)

- W4 Q2 MEDIUM: `tests/lib/resource-probe/probe-platform.test.mjs` overly-generous predicate for `processCounts` null-output branch; `tests/lib/workspace.test.mjs` runtime branching in test body. Both work correctly today; tighten in next session.
- W4 Q3 MEDIUM: `state-md/recommendations.mjs` and `learnings/filters.mjs` are shallow per LANGUAGE.md. Justification today is the LOC budget; future split should target contract-boundary seams instead.
- W4 Q3 MEDIUM: `clamp` / `round2` / `safeArray` duplicated between `mode-selector.mjs` and `mode-selector/context-pressure.mjs` (4 lines each). Extract to a private `mode-selector/_helpers.mjs` when the deferred scorer split lands.
- W4 Q5 MEDIUM: pre-existing silent-drop of `malformed` in `scripts/export-hw-learnings.mjs:343` — the `readLearnings` extraction surfaced the contract; surface it in stderr in a follow-up.
- W4 Q4: plumb `--max-tokens` through `parseFlags()` + `commands/autopilot.md` so the CLI surface matches the runtime opt.

### Added (Unreleased) — 2026-05-09 deep-1 (#350–#354)

- **#350 gitleaks pre-commit + CI step** — `.gitleaks.toml` (already tracked from prior baseline-vendor work) extended with plugin-specific allowlist patterns (`.test.mjs` / `.spec.mjs` / `tests/` / skill+rule+command+agent Markdown / `AGENTS.md` / `README.md` / `CHANGELOG.md`). NEW `gitleaks-scan` job in `.gitlab-ci.yml` (new `security` stage, runs first, fails on findings). NEW `security` job in `.github/workflows/test.yml` (gates `test` job via `needs:`, uses `gitleaks/gitleaks-action@v2.3.7` pinned by SHA). NEW `.husky/pre-commit` invocation `gitleaks protect --staged --redact --no-banner` with graceful skip when binary absent. Local dry-run: 0 leaks across 258 commits. Issue closed.
- **#351 npm audit step in CI pipelines** — NEW `npm-audit` job in `.gitlab-ci.yml` (`security` stage, runs `npm audit --audit-level=high --omit=dev`, configurable via `AUDIT_LEVEL` CI variable for false-positive triage). Mirrored as a step in the GitHub `security` job. Local dry-run: 0 vulnerabilities. Bypass mechanism documented in yaml comment. Issue closed.
- **#352 Husky + commitlint + lint-staged** — NEW `.husky/pre-commit` (gitleaks + lint-staged) + `.husky/commit-msg` (commitlint). NEW `commitlint.config.mjs` (extends `@commitlint/config-conventional`, type-enum matches `.claude/rules/development.md`, `header-max-length: 120`). NEW `.lintstagedrc.mjs` (`*.mjs → eslint --fix`). `package.json` adds 4 devDeps (husky 9.1.7, @commitlint/cli + config-conventional 19.6.0, lint-staged 15.2.10) + `prepare: husky` + `format` / `format:check` scripts. README `## Development` section gains "Pre-commit hooks" subsection documenting the `npx husky` post-install requirement (because `.npmrc` ships `ignore-scripts=true` for SEC-020 supply-chain defence). Issue closed.

### Changed (Unreleased) — 2026-05-09 deep-1 (#350–#354)

- **#353 Prettier configs** — `.prettierrc` already existed (committed 2026-04-19); `.prettierignore` extended from 5 to 24 lines (added `coverage/`, `dist/`, `build/`, lock-file siblings, `.husky/_/`, backup patterns; preserved existing `*.md` + `docs/` + `.orchestrator/` ignores). `package.json` adds `format` / `format:check` scripts (prettier already devDep). Repo-audit's `quality.prettier-config: fail` was a glob false-negative — file is committed and content is canonical. Issue closed.
- **#354 CLAUDE.md trim** — Working-tree compaction completed: HEAD CLAUDE.md (110L) → working tree (88L), within ≤100L lean target. Two verbose multi-paragraph session bullets (2026-05-08 deep-2 + 2026-05-08 PM v3.4.0) extracted from HEAD and prepended to `~/Projects/vault/01-projects/session-orchestrator/decisions.md` (191L → 260L, +69L). Migration disclaimer in vault note updated with `**Update 2026-05-09:**` annotation. Information-loss check: every removed bullet now in vault. Issue closed.

### Added (Unreleased) — 2026-05-08 deep-2 (#344, #347)

- **#344 crypto-digest-utils.mjs** — DRY 6 sha256-hash sites. NEW `scripts/lib/crypto-digest-utils.mjs` (~90L, 4 named exports: `digestSha256Short` (default 8-char hex prefix), `digestSha256` (full digest), `digestSha256WithSalt` (salt+\\x00+value pattern with required salt + TypeError validation), `digestMultiBufferSha256` (sequential multi-buffer update, array-required)). Migrated 6 callers byte-equivalent: `spiral-carryover.mjs` (computeTaskHash), `host-identity.mjs` (hashHostname — preserves salt+NUL+hostname order invariant), `quality-gates-cache.mjs` (computeDependencyHash multi-buffer), `frontmatter-guard.mjs` (computeSchemaHash), `session-registry.mjs` (repoPathHash — NOTE: keeps `crypto` import for `randomBytes`), `vault-sync-baseline.mjs` (computeSchemaHash). 29 vitest cases with hardcoded hex literals (no tautological computation). Issue closed.
- **#347 check-hooks-symmetry validator** — NEW `scripts/lib/validate/check-hooks-symmetry.mjs` (127L after simplifier) with 4 sequential checks: (1) hooks.json↔hooks-codex.json event-key parity (must match exactly); (2) hooks-cursor.json documented-asymmetry policy via `DOCUMENTED_ASYMMETRIES` constant (9 cursor-missing-from-main + 2 cursor-only); (3) handler files exist on disk for all referenced .mjs (skips `_lib/*` library modules); (4) orphan-detection (informational PASS for unreferenced hooks/*.mjs). Wired into `scripts/validate-plugin.mjs` after L123 (2 lines added). Simplifier extracted `loadJson(filePath, required)` helper (-9L). 30 vitest cases via synthetic temp-dir fixtures + 3 real-plugin happy-path cases. Issue closed.

### Tests (Unreleased)

- **#345 scripts/lib/config/ unit-test cluster** — 8 NEW test files in `tests/lib/config/`, **221 cases** (target ~112, +97%). Modules: coercers (77 cases — every throw exercised, override-syntax `"6 (deep: 18, fast: 4)"` parser covered, all 11 exported coercers covered), drift-check (21), section-extractor (18), vault-sync (19), docs-orchestrator (19), vault-staleness (17), config/events-rotation (22 — for the CONFIG parser), vault-integration (28). Test-quality compliant: hardcoded expected values, no tautological computation, error-paths covered. Issue closed.
- **#346 scripts/lib/vault-mirror/ unit-test cluster** — 5 NEW test files in `tests/lib/vault-mirror/`, **148 cases** (target ~78, +89%). Modules: utils (48 — all 7 utility functions), render-learnings (32 — schema detection + 8 v1/6 v2 throw paths + confidence boundary 0.8 + title truncation), render-sessions (36 — schema detection + 9 v1 + 7 v2 throw paths + completion-rate rounding + platform-skipped regression #343), auto-commit (11 — all 8 action paths: no-mirror-dirs, not-a-git-repo, git-add-failed, git-diff-failed, no-staged-changes, non-mirror-staged-changes, git-commit-failed, auto-commit-created), process (21 — deriveRepo regex parsing + caching, processLearning state machine, processSession sanitisation). Issue closed.
- **#349 events-rotation.mjs unit tests** — NEW `tests/lib/events-rotation.test.mjs`, **25 cases** (target 16-18, +56%). Coverage: 9 input-validation throws (logPath/maxSizeMb/maxBackups including range boundaries), 6 early-return reasons, 4 happy-path rotations including exact-1-MiB threshold, 3 ring-buffer shifts with maxBackups=3, 3 error-handling tests via real read-only-dir injection (vi.spyOn blocked on ESM named exports — used `chmodSync(dir, 0o555)` instead). Issue closed.

### Changed (Unreleased)

- **#348 doc-drift sweep** — README test-count line refreshed (`2623+ tests` → `3138+ tests` in W2; bumped to `3591+ tests` in W5 to reflect post-session count) + NEW `### Cursor IDE Support` section after Platform Support documenting `hooks/hooks-cursor.json`'s 2 events and Cursor IDE limitations (no SessionStart equivalent + post-hoc afterFileEdit). PRD `2026-04-21-vault-docs-orchestration.md` Status header updated `Draft` → `Complete (2026-05-01, Epic #229 closed)` (line 360 already confirmed completion). CLAUDE.md `2026-04-30 main-2026-04-30-1635` narrative bullet stale doc-drift parenthetical replaced with `[RESOLVED 2026-05-08 in v3.4.0: ...]` historical marker. Issue closed.

### Refactor (Unreleased) — 2026-05-09 deep-4

- **Hotspot-splits cluster (deep-4, 2026-05-09)**: 6 file-disjoint hotspots ≥400 LOC split into submodules <300 LOC each. Public APIs preserved via barrel re-exports — zero behavior change.
  - `scripts/lib/state-md.mjs` (563→31 LOC barrel) — split into `state-md/{yaml-parser, frontmatter-mutators, body-sections, mission-status, recommendations}.mjs`
  - `scripts/lib/mode-selector.mjs` (480→149 LOC orchestrator) — split into `mode-selector/{constants, scoring, alternatives, rationale, context-pressure}.mjs`
  - `scripts/lib/session-schema.mjs` (462→70 LOC barrel) — split into `session-schema/{constants, validator, normalizer, timestamps, aliases}.mjs`
  - `scripts/lib/owner-config.mjs` (459→28 LOC wrapper) — split into `owner-config/{constants, error, defaults, coerce, validate, merge, index}.mjs`
  - `scripts/lib/worktree.mjs` (418→15 LOC barrel) — split into `worktree/{constants, meta, listing, lifecycle, index}.mjs`
  - `scripts/lib/autopilot.mjs` (418→39 LOC barrel) — split into `autopilot/{kill-switches, flags, telemetry, loop}.mjs`. The legacy `scripts/lib/autopilot-telemetry.mjs` is retained as a one-line backward-compat re-export.
- **Test coverage**: +534 net tests (3896→4430), 26 new `*.test.mjs` files under `tests/lib/{state-md,mode-selector,session-schema,owner-config,worktree,autopilot}/**`. The `tests/lib/refactor-stability.test.mjs` adapter extended 24→46 tests pinning all 6 hotspot public APIs.
- **Quality gates**: typecheck 66/66 OK · lint 0 errors · validate-plugin 27/27 · doc-consistency 0 findings · test-quality audit 0 anti-pattern violations.
- **Pattern**: 5W×6A coordinator-direct parallel dispatch with file-disjoint allowedPaths per agent. Continues the deep-2 (2026-05-09) hotspot-split pattern.

### Quality (Unreleased)

- typecheck: 66/66 OK (was 65 at v3.4.0; +1 NEW module crypto-digest-utils.mjs in deep-2)
- lint: 0 errors
- tests: **4430 passed / 12 skipped / 0 failed** (was 3138 at v3.4.0, **+453 in deep-2**, stable in deep-1, **+297 in deep-2** [#355–#358], **+8 in deep-3** [#359–#363], **+534 in deep-4**)
- validate-plugin: **27 passed, 0 failed** (was 22 at v3.4.0; +5 from check-hooks-symmetry validator in deep-2)
- CI security gates pre-validated locally: gitleaks 0 leaks (258 commits), npm audit 0 vulnerabilities (production deps, audit-level=high)

## [3.4.0] - 2026-05-08

Deep session shipping 7 issues (#327 #328 #330 #342 #332 #325 #326) on top of the prior consolidated `[Unreleased]` work since v3.3.0 (Benchmark P1-P5, convergence-monitoring, baseline propagation, doc-drift sweep, #321/#323/#343/#329/#322/#324, #320 Express Path persistence). 5W×6A coordinator-direct on `main`, isolation:none enforcement:warn cap=6. Tests grew 2942 → 3138 (+196). No breaking changes.

### Added (v3.4.0)

- **#327 vault-sync baseline-diff reporting** — `scripts/lib/vault-sync-baseline.mjs` (NEW, 152L) exports `computeSchemaHash` (8-char SHA-256 prefix), `writeBaseline` (atomic with header), `readBaseline` (null on missing/invalid, no-throw), `diffBaseline` (set-difference by `(file, path, message)` triple). `skills/vault-sync/validator.mjs` extended `--mode` to accept `baseline|diff|full` (legacy `hard|warn|off` unchanged). Default mode `hard` preserved (zero behavior change for existing callers). Schema-hash mismatch falls back to full enforcement with stderr WARN. 25 vitest cases (16 unit + 9 integration). Issue closed.
- **#328 Frontmatter-Guard skill** — NEW `skills/frontmatter-guard/SKILL.md` (126L) + `scripts/lib/frontmatter-guard.mjs` (240L). Reads canonical zod schema from `~/Projects/projects-baseline/packages/zod-schemas/src/vault-frontmatter.ts` (8 type values, 7 status values, 4 required fields), generates deterministic Markdown snippet with per-type YAML examples. `wave-executor/wave-loop.md` adds Pre-Dispatch injection step gated on `detectVaultTaskScope()` (vault path or write-intent in task description). 31 vitest cases. Issue closed.
- **#330 distributed session-lock with TTL** — NEW `scripts/lib/session-lock.mjs` (215L) exports `acquire`/`forceAcquire`/`release`/`checkStale`/`readLock`. JSON payload `{session_id, started_at, mode, pid, host, ttl_hours}` at `.orchestrator/session.lock` (added to `.gitignore`). `DEFAULT_TTL_HOURS=4` (derived from sessions.jsonl p95=2.62h). `session-start` Phase 1.2 wires acquire+AUQ recovery (active/stale-pid-dead/stale-pid-alive branches; cross-host PID check returns `pidAlive: null` and recommends Abort). `session-end` Phase 3.8 wires release. `commands/close.md` notes the release. 16 vitest cases. Issue closed.
- **#342 4 hook events adoption** — 4 NEW handlers in `hooks/`: `post-tool-failure-corrective-context.mjs` (PostToolUseFailure, appends to `.orchestrator/current-session.json` corrective_context array, capped 20), `post-tool-batch-wave-signal.mjs` (PostToolBatch, deterministic batch-resolved signal), `subagent-telemetry.mjs` (SubagentStart+SubagentStop, writes to NEW `.orchestrator/metrics/subagents.jsonl`), `cwd-change-restore.mjs` (CwdChanged, records cwd_changes capped 20). NEW `scripts/lib/subagents-schema.mjs` (Zod-free schema mirroring `learnings.mjs` style; 8 exports incl. ValidationError, validateSubagent, normalizeSubagent, migrateLegacySubagent, appendSubagent, readSubagents). NEW `scripts/migrate-subagents-jsonl.mjs` (v3 migrate-CLI clause). `hooks/hooks.json` + `hooks/hooks-codex.json` register all 4 new event keys (SubagentStop extended additively, on-stop.mjs preserved). CLAUDE.md `## Structure` updated 6→10 hook event matchers / 6→10 handlers. 41 vitest cases (29 schema + 12 hook). Issue closed.
- **#332 mode-selector context-pressure signal** — `scripts/lib/mode-selector.mjs` exports new `computeContextPressure(signals)` returning `{score, components: {scope, keywords, carryover}, level: 'low'|'medium'|'high'}`. Components: scope=`min(0.5, max(0, (priorityCount-3)/10))`, keywords=`+0.25` if cross-cutting regex matches `taskDescriptionText`, carryover=`min(0.25, max(0, ratio-0.3))`. Integrated into `computeDelta()` as additive penalty: high level → feature −0.15 / housekeeping −0.10; low → feature +0.05. `selectMode()` output now includes `context_pressure: {score, level}`. `skills/mode-selector/SKILL.md` documents the heuristic; `skills/session-start/phase-7-5-mode-selector.md` Step 4.5 wires AUQ annotation when level is medium/high. 13 vitest cases. Issue closed.

### Changed (v3.4.0)

- **#325 ecosystem-wizard 5-way modularization** — `scripts/lib/ecosystem-wizard.mjs` (was 636L) split into `scripts/lib/ecosystem-wizard/{ci-detector,package-manager-detector,config-parser,config-writer,wizard-prompt}.mjs` (5 sub-modules); root file becomes a re-export barrel preserving all 12 public symbols. Behaviour-preserving: 56 existing ecosystem-wizard tests still pass byte-equivalent. Zero cyclic imports. 68 new vitest cases for sub-module isolation + barrel re-export count (floor/ceiling assertion ≥10, ≤50). Issue closed.
- **#326 autopilot.mjs telemetry split** — NEW `scripts/lib/autopilot-telemetry.mjs` extracts `writeAutopilotJsonl`, `defaultRunId`, `readHostClass`, `finalizeState` from `scripts/lib/autopilot.mjs` (was 575L → 507L, ~12% reduction). Root file re-exports for backward compat; existing 73 autopilot tests pass unchanged. 27 new vitest cases for telemetry module. Issue closed.

### Quality (v3.4.0)

- typecheck: 65/65 OK (was 56 before W2; +9 NEW modules: vault-sync-baseline, frontmatter-guard, session-lock, subagents-schema, autopilot-telemetry, 4× ecosystem-wizard sub-modules)
- lint: 0 errors, 0 warnings (4 inline coordinator fixes during W4: 2 eqeqeq in post-tool-failure hook, 1 unused destructured var in frontmatter-guard, 1 unused-import in autopilot-telemetry test)
- tests: **3138 passed / 12 skipped / 0 failed** (was 2942 entering W4; **+196 tests** across W2/W3/W4)
- validate-plugin: 22 passed / 0 failed
- Simplifier pass (W4-D5): 4 production files simplified — hoisted dynamic import in post-tool-failure hook, replaced `pad2` with `String.padStart` in autopilot-telemetry, extracted `safeBootstrapLock` helper + collapsed nested ternary to if/else chain in mode-selector, replaced 3 nested ternary `firstNonEmptyString` blocks in subagent-telemetry hook
- 2 production bugs caught by W4 Full Gate D6 + fixed coord-direct in `frontmatter-guard.mjs`: regex stem boundary issue (`generat` → `generat[a-z]*` for `WRITE_INTENT_RE`; same fix applied to write/creat/emit/mirror/updat/add/insert), trailing-newline cosmetic patch on snippet generator

### Added

- **Benchmark P1-P5 adoption epic (#336 #337 #338 #339 #340)** — five area-orthogonal features adopted from the 2026-05-07 benchmark synthesis (Cursor / obra-superpowers / Pimzino / BMAD / ab-method). All opt-in, default-off, zero-behavior-change for existing call sites. **#336 (P1, Cursor)** — glob-scoped rules: `scripts/lib/rule-loader.mjs` exports `loadApplicableRules({rulesDir, scopePaths})` filtering `.claude/rules/*.md` by optional `globs:` frontmatter intersected with the wave's `allowedPaths`; rules without `globs:` stay always-on (backward compat); parse errors fall back to always-on (never silently dropped). 6 rules renamed `paths:` → `globs:` (`backend.md`, `backend-data.md`, `cli-design.md`, `security-web.md`, `testing.md`, `test-quality.md`); 7 cross-cutting rules remain always-on. **#337 (P2, obra/superpowers)** — `skills/using-orchestrator/SKILL.md` (140L meta-skill) with 23-entry de+en phrase map (covers /plan {new,feature,retro}, /session {housekeeping,feature,deep}, /discovery, /evolve, /close, /bootstrap), 4-tier confidence scoring (0.95 exact-slash / 0.90 exact-natural / 0.60 partial / 0.40 semantic), 0.85 dispatch threshold, AUQ-disambiguation when delta < 0.15. Gated on `auto-skill-dispatch: true` (default false = silent no-op). **#338 (P3, Pimzino)** — `.orchestrator/steering/{product,tech,structure}.md` (3 stable repo-fact docs, ~50L each) loaded by new session-start Phase 2.6 (silent no-op when dir absent); `/plan new` Step 7 scaffolds the docs from planning answers; CLAUDE.md narrative kept as historical record. **#339 (P4, BMAD/superpowers)** — `agents/{architect-reviewer,qa-strategist,analyst}.md` (3 read-only persona-reviewer agents); new wave-loop.md step 5a dispatches enabled reviewers in parallel between Quality-Lite and session-reviewer. Gated on `persona-reviewers.enabled: true` + non-empty `reviewers:` array (default empty = no-op). Reviewer findings written to `.orchestrator/audits/wave-reviewer-<wave>-<reviewer>.md` (already gitignored). **#340 (P5, ab-method partial)** — `scripts/lib/mission-status-schema.mjs` exports the 5-value enum `brainstormed | validated | in-dev | testing | completed` + transition validator (forward + idempotent same-state + rollback-to-brainstormed allowed); `state-md.mjs` adds `parseMissionStatus`/`writeMissionStatus`; session-plan emits `### Wave-Plan Mission Status (machine-readable)` block (parallel to docs-tasks pattern); session-end Phase 1.9 classifies items by enum (completed→Done, testing/in-dev→Carryover, brainstormed/validated→Not Started). Backward-compat: absent `mission-status:` field → behave exactly as pre-#340. New Session Config fields: `auto-skill-dispatch: false`, `persona-reviewers: { enabled, reviewers, mode }`. CLAUDE.md `## Structure` line updated (27 skills, 10 agents, +steering/ pointer). 149 new vitest cases across 8 test files; total **2875 passed / 11 skipped / 0 failed** (was 2727, +148). Typecheck 56/56, lint 0, validate-plugin 22/22 (10 agents).
- **convergence-monitoring skill (#223)** — Iterative-loop convergence detector. Three signals (shrinking diff, pass-rate plateau, velocity) drive a Stop/Continue/Investigate decision at each inter-wave checkpoint. Distinct from /evolve (retrospective) and session-reviewer (correctness review): convergence-monitoring answers "are we making progress?". Primary consumer: /autoresearch loops and wave-executor inter-wave checkpoints.
- **Baseline propagation MR (#314 #315 #318 #240)** — Cross-repo MR to `projects-baseline` vendoring `.claude/rules/architecture.md` (5 editorial patches), `.claude/rules/owner-persona.md` (new file + setup-project.sh wiring + CLAUDE.md.template bullet), `docs/adr/000-template.md` (3-criteria gate `### What qualifies` + `### What does not qualify` sub-sections), and `tests/setup-project.bats` (3 vault-provisioning test cases for #240).
- **Plugin doc-drift sweep** — README.md skills count 25→26 (added convergence-monitoring), hook handler count 7→6 (corrected), test count 2160+→2623+ (refreshed). CLAUDE.md `## Structure` line synced.

### Fixed

- **#321** sessions.jsonl writer hardening — recurring timestamp-inversion bug fixed at the writer boundary. New exports `clampTimestampsMonotonic(entry)` + `aliasLegacyEndedAt(entry)` in `scripts/lib/session-schema.mjs` (pure, never throw, never mutate input). `scripts/emit-session.mjs` calls both before `validateSession`: monotonicity violations are clamped (`completed_at = started_at`) with `_clamped: true` + `_original_completed_at: <iso>` forensic markers and a STDERR `WARN session_id=...; clamped` line; STDOUT remains pure JSON. Legacy `ended_at` records get aliased to canonical `completed_at` and `duration_ms` is dropped once both timestamps are present. 4 invalid rows in `.orchestrator/metrics/sessions.jsonl` (lines 69, 71, 75, 76 — including the 2026-05-07 deep session that re-triggered the bug) patched in-place; dry-run unmappable: 4 → 0. No rogue writers detected — every JSONL write site already funnels through `emit-session.mjs`. 22 new vitest cases for clamp + alias unit behaviour, 6 integration cases for emit-session.
- **#323** learnings.jsonl `expires_at` TTL pruning gap — `scripts/lib/learnings.mjs` exports `LEARNING_TTL_DAYS` (frozen 9-entry per-type policy: 30d for `mode-selector-accuracy`, 60d for `hardware-pattern` / unknown types, 45d for `fragile-file` / `effective-sizing` / `recurring-issue`, 90d for `workflow-pattern` / `proven-pattern` / `anti-pattern` / `autopilot-effectiveness`) and `deriveExpiresAt(createdAt, type)`. `appendLearning()` auto-stamps `expires_at` (and `created_at` if absent) when caller omits it; respects caller-supplied values for idempotency. New `scripts/backfill-learnings-expires.mjs` CLI (dry-run safe by default; `--apply` patches missing `expires_at` + writes `<file>.bak.<isoDate>` backup; `_backfilled_expires_at: true` forensic tag; idempotent on re-run). 1/129 records in live `learnings.jsonl` backfilled. 11 new unit tests (deriveExpiresAt + appendLearning auto-stamp) + 7 backfill integration tests.
- **#343** vault-mirror frontmatter quality drift — V1 `generateSessionNote` no longer emits literal `"undefined"` from template-literal coercion; new `fmLine(key, value)` skip-emit helper handles null/undefined/empty. Both V1 and V2 generators now emit a `repo:` frontmatter field for cross-repo aggregation; new `deriveRepo()` in `scripts/lib/vault-mirror/process.mjs` parses `git config --get remote.origin.url` (ssh + https forms) with `path.basename(cwd)` fallback, cached across calls. JSDoc note codifies canonical filename pattern (`<session_id>.md`). 11 V1/V2 frontmatter tests + 4 deriveRepo tests.
- **#329** vault-sync exclude-list parser ignored on bare invocation — `skills/vault-sync/validator.mjs` now reads `vault-sync.exclude:` from `<VAULT_DIR>/CLAUDE.md` (or `AGENTS.md` via `resolveInstructionFile()`) unconditionally on every invocation, BEFORE argv parsing. CLI `--exclude` flags remain additive. try/catch silent fallback on missing/unparseable config. Dynamic-imports `_parseVaultSync` from `scripts/lib/config/vault-sync.mjs` so the existing parser stays the SSOT. SKILL.md docs the new behaviour. 7 new integration tests (bare-invocation, additive CLI, missing/unparseable fallback, AGENTS.md alias, VAULT_DIR env precedence, non-array safety).
- **#322** circular import between `scripts/lib/workspace.mjs` ↔ `worktree.mjs` removed — re-export shim at `worktree.mjs:421` deleted; the single test caller (`tests/lib/worktree.test.mjs:423`) split into two cache-busted dynamic imports (`workspace.mjs?hardening` for `resolveWorkspaceRoot`/`restoreCoordinatorCwd`/`validatePathInWorkspace`; `worktree.mjs?hardening` for `createWorktree`/`removeWorktree`). Cycle now uni-directional (workspace.mjs → worktree.mjs only). All 36 `worktree.test.mjs` cases still pass.

### Changed

- **#324** decompose 3 long validator functions (behaviour-preserving refactor, no public API change). `scripts/lib/wave-resource-gate.mjs::evaluateWaveResourceGate` (109L) → thin orchestrator + `extractMeasurements` + `applyDecisionRules` private helpers. `scripts/lib/session-schema.mjs::validateSession` (181L) → 8 module-private section validators (`_validateSchemaVersion` / `_validateRequiredFields` / `_validateSessionId` / `_validateSessionType` / `_validateTimestamps` / `_validateWaves` / `_validateAgentSummary` / `_validateOptionalFields`); the W2 #321 additions (`clampTimestampsMonotonic` / `aliasLegacyEndedAt`) preserved. `scripts/lib/owner-config.mjs::validate` (212L) → 7 per-section private validators (schema-version / owner / tone / efficiency / hardware-sharing / defaults / metadata). All error messages, throw semantics, and aggregate ordering byte-equivalent. 154 existing tests (107 + 47 consumers) still pass without modification.
- `.gitignore` extended for `.orchestrator/metrics/*.jsonl.bak.*` (dot-separated date suffix from new backfill script) and `.orchestrator/metrics/*.jsonl.archive-*`.

### Fixed (continued)

- **`evaluate.mjs` macOS pressure-first verdict** (commit `afcdf12`, branch `fix/macos-ram-pressure-aware-probe`) — `os.freemem()` on macOS reports only `vm_statistics.free_count` (Pages free), excluding the `inactive` pool that the OS reclaims on demand. Real-world Mac sessions with 11+ GB inactive routinely showed <1 GB "free", triggering `critical` verdict + `cap=0` (coordinator-direct) even when `memory_pressure` reported 60-80% free. Same pattern for swap: macOS accumulates swap over multi-day sessions even after pressure normalises. Fix: when `memory_pressure_pct_free >= 30%` (Activity Monitor's green/yellow boundary, `MACOS_HEALTHY_PRESSURE_PCT`), suppress free-RAM and swap signals; CPU + claude-process-count + zombie signals continue to fire. Backwards-compatible (Linux/Windows untouched). Verified live: `5219 MB swap + 0.5 GB ram_free + 81% pressure` previously → `critical / cap=0`, now → `warn / cap=null`. Aligned with new `AAG-006 Resource-Aware Throttling` rule. 72 unit tests (was 70); full suite 2629 pass. Sources: Apple "Viewing Virtual Memory Usage", OSXDaily 2026-04, psutil/psutil#1277, Cordum 2026 circuit-breaker DEGRADED-state.
- **#320** Express Path persistence — `commands/go.md` now detects the Express Path activation banner and (a) appends the express-path deviation to STATE.md `## Deviations` via `appendDeviation()`, (b) auto-invokes `session-orchestrator:session-end` skill, (c) verifies `status: completed` after close. Adds 2 new exports in `scripts/lib/state-md.mjs` (`appendDeviation`, `markExpressPathComplete`) + 17 vitest cases. Closes the audit-trail gap where every Express Path housekeeping run silently dropped its sessions.jsonl record.

## [3.3.0] - 2026-04-30

Iterative release covering the work since v3.2.0 (2026-04-27): Owner Persona Layer (D-axis complete), bash-free milestone, AGENTS.md alias parity, vault-staleness banner, autopilot-effectiveness skeleton, two epic closures (#309 Architecture-DDD-Trio, #271 v3.2 Autopilot), 50+ closed sub-issues, and a major refactor pass (vault-mirror / config / categories / worktree / resource-probe splits). Tests grew 1871 → 2623 (+752). No breaking changes.

### Added

#### Owner Persona Layer (#161 epic — D-axis complete)
- `scripts/lib/owner-yaml.mjs` (184L, 5 exports) — schema, validator, loader, writer, defaults; plain-JS validation (no Zod dep). 36 tests.
- `scripts/lib/owner-interview.mjs` (130L) — 5-question interview (language, tone, output level, preamble, hardware-sharing consent). C4 hardware-sharing consent (#173) merged into question 5; generates 64-char hex `hash-salt` via `crypto.randomBytes`. Idempotent (`force: true` archives to `owner.yaml.bak-<timestamp>`).
- `scripts/lib/soul-resolve.mjs` (98L) — mustache-style `{{slot}}` resolver. Pure `resolveSoul()` + `loadAndResolveSoul()`. Falls back to defaults silently for missing slots. 10 tests.
- `scripts/lib/owner-config{,-loader}.mjs` (313L + 113L) — earlier config foundation (#174) + 41 tests + `docs/owner-config-schema.md`.
- `skills/session-start/soul.md` + `skills/plan/soul.md` — both contain `{{owner.language}}`, `{{tone.style}}`, `{{efficiency.output-level}}`, `{{efficiency.preamble}}` slots.
- `skills/bootstrap/SKILL.md` — Phase 3.5 owner-interview integration; Phase 3.6 = (former 3.5) Rules-Fetch Bridge.
- `.claude/rules/owner-persona.md` (79L, 7 sections) — owner.yaml location, slot system, `--owner-reset` re-trigger, privacy guarantee (path-only, never content).
- `tests/integration/owner-persona-flow.test.mjs` (15 tests) — interview → write → load → soul resolve.

#### AGENTS.md alias parity (#33 + #30)
- `skills/_shared/instruction-file-resolution.md` — alias-rule SSOT (CLAUDE.md → AGENTS.md → null).
- `scripts/lib/common.mjs` adds `resolveInstructionFile()` helper.
- 30 sites updated: 16 skills, 11 scripts, 1 command, 1 example.yaml — transparent alias everywhere.
- `skills/claude-md-drift-check/checker.mjs` alias-resolves at runtime; JSON now emits `resolved_path` / `resolved_kind`.
- `tests/skills/instruction-file-alias-coverage.test.mjs` — sweep test prevents regression.
- `docs/session-config-template.md` — ~70-field baseline template for adopters.
- `scripts/check-doc-consistency.sh` — POSIX H2-parity, count-parity, alias-phrasing CI gate (exit 0/1/2).
- `skills/claude-md-drift-check` gains session-config-parity check (template-vs-local key diff, 2 new CLI flags) and a fifth command-count probe (#269).

#### Architecture-DDD-Trio (#309 epic, closed)
- 3 skills + `skills/discovery/probes-arch.md` (235L, 4 probes incl. architectural-friction) + 20 tests adopted from `mattpocock/skills@90ea8ee` (MIT). Plugin-scope items complete; cross-repo work (#314, #315) deferred to projects-baseline MR.

#### Vault & Discovery Infrastructure
- `scripts/vault-integration-watcher.mjs` (260L, #306) — vault staleness watcher + 12 tests + GitLab Scheduled Pipeline.
- `scripts/lib/vault-staleness-banner.mjs` (#319) — 2-tier severity banner (`warn`/`alert`) wired into `session-start` Phase 4. Reads last line of `.orchestrator/metrics/vault-staleness.jsonl`. Silent no-op on absent/malformed file or `stale_count === 0`.
- `docs/vault-docs-architecture.md` (#237, 297L, 31 source citations, 9 sections).

#### Autopilot Foundation (#271 epic, closed)
- `scripts/lib/evolve/autopilot-effectiveness.mjs` (#298) — `/evolve` learning type 8 skeleton; data-gated on ≥20 paired manual+autopilot runs per mode (returns `[]` until threshold).
- All v3.2 Autopilot phases (A/B/C-1/C-1.b/C-1.c/C-2/C-5) confirmed shipped at v3.2.0; epic closed in this cycle. Sub-issues `#297` (cap calibration) and `#298` (effectiveness data) remain open, blocked on real RUNS.

#### Repository tooling
- `skills/repo-audit/SKILL.md` (#215, 258L) + `commands/repo-audit.md` + 32 tests; Clank section opt-in; config-driven.
- `skills/_shared/instruction-file-resolution.md` baseline-fetch in `skills/bootstrap/standard-template.md` S99 manifest.

#### Express Path (#214)
- `session-start` Phase 8.5 + `session-plan` Express Path Short-Circuit + docs section. Codifies the 13× consecutive coord-direct pattern observed in 2026-04 deep sessions. Activates for housekeeping ≤3 sequential issues. +20 tests.

#### Marketplace prep (#213)
- `docs/marketplace/composio-submission.md` (114L) — submission draft for ComposioHQ/awesome-claude-plugins (entry text, 9-row comparison vs maestro-orchestrate, PR mechanics, risk/fallback path).

#### Cross-repo baseline propagation prep
- `docs/baseline-diffs/` — three MR-ready preview documents for #318 (owner-persona), #314 (architecture rule), #315 (ADR template gate). Plugin-side only; baseline MR is a separate session.

### Changed

#### Refactor pass (lower complexity, preserved public APIs)
- `vault-mirror.mjs` (#283) — 679L → 152L CLI orchestrator + 6 modules under `scripts/lib/vault-mirror/`. CLI flags byte-identical; 51/51 existing tests unchanged.
- `config.mjs` (#284) — 1075L → 294L orchestrator + 8 per-section parsers under `scripts/lib/config/`. Public API frozen; 152/152 tests pass.
- `categories.mjs` (#285) — 956L → 17L re-export barrel + 7 per-category files; `RUBRIC_VERSION='2026-05'` unchanged; audit JSON output identical.
- `worktree.mjs` (#287) — 589L → 420L; new `workspace.mjs` 198L re-export shim.
- `resource-probe.mjs` (#287) — 564L → 89L + new `resource-probe/{parsers,probe-platform,evaluate}.mjs`.
- `validate-plugin.sh` (#122) — 364L → 79L orchestrator + 5 helpers under `scripts/lib/validate/`.
- `run-quality-gate.sh` (#121) — 412L → 132L dispatcher + 4 gate handlers + helpers under `scripts/lib/gates/`.
- `bootstrap` templates (#288 batch 1+2) — `_shared-template.md` partial extraction; `session-start` 862→486L (4 phase siblings); `session-end` 636→446L (2 phase siblings).
- `harness-audit` pass()/fail() (#227) — options-object signature with backward-compat positional shim (warn-once + forward); +19 tests.
- `ecosystem-wizard` + `worktree-freshness` (#208) — 9 helpers extracted; all functions ≤57 lines; #289 idempotent merge fully preserved.

#### Bash-free milestone (#218 / #317)
- 16 .sh scripts ported to .mjs (10 nested under `scripts/lib/gates/` + `scripts/lib/validate/`, 6 top-level); `find scripts/lib -name '*.sh'` returns zero.
- New pure-ESM modules: `scripts/lib/gates/gate-{baseline,incremental,full,per-file,helpers}.mjs` (475L), `scripts/lib/validate/check-{plugin-json,component-paths,json-files,agents,commands}.mjs` (447L). Exact JSON-on-stdout contracts and exit codes preserved.
- `scripts/run-quality-gate.mjs` and `scripts/validate-plugin.mjs` switched from `bash` → `node` spawn. Public CLI/env API unchanged.
- `.claude/rules/cli-design.md` — "Shared Shell Library" section rewritten as "Shared Module Library (common.mjs)" reflecting bash-free state.
- `CONTRIBUTING.md` updated: `platform.sh` → `scripts/lib/platform.mjs (detectPlatform)`, `common.sh` → `common.mjs`.
- 12 doc/skill/rule files updated to reference .mjs paths instead of .sh.

#### Hooks profile gate (#211)
- `hooks/_lib/profile-gate.mjs` (`shouldRunHook`) imported by all 6 handlers. `SO_HOOK_PROFILE` (full/minimal/off) + `SO_DISABLED_HOOKS` per-name override. Backward compatible (unset env = full). +10 tests.

#### Webhook URL centralization (#228)
- `scripts/lib/webhook-url.mjs` (`resolveWebhookUrl` + `WebhookConfigError`) — env > Session Config > error precedence. Personal-domain default removed from `scripts/lib/events.mjs` + `hooks/on-stop.mjs`. +22 tests.

#### Plugin root resolution (#212)
- `scripts/lib/plugin-root.mjs` — robust 4-level fallback (env CLAUDE_PLUGIN_ROOT > CODEX_PLUGIN_ROOT > walk-from-import-meta > walk-from-cwd > `PluginRootResolutionError`). `platform.mjs` delegates. Backward compat preserved. +10 tests.

#### Schema enforcement
- `learnings.jsonl` writer (#303) — Zod-equivalent validation; `evolve` SKILL.md Step 3.5 writer prompt now mandates `schema_version:1` + UUID `id` + `insight` (not `description`/`recommendation`). `scripts/migrate-learnings-jsonl.mjs` (--dry-run/--apply, idempotent). +14 tests.
- `sessions.jsonl` writer (#304) — canonical schema header doc; `scripts/migrate-sessions-jsonl.mjs` maps OLD scalar shape → NEW `agent_summary`/`waves[]`/`total_agents`/`total_files_changed`. +19 tests.
- `bootstrap.lock plugin_version` (#290 + #203) — `readPluginVersionFromPackageJson` + `classifyVersionMismatch` (major=alert, minor/patch=info, legacy=soft). `MS_PER_DAY` constant. Live lock backfilled with `plugin-version`.

#### Discovery & ecosystem
- `discovery-on-close` session-type-aware default (#264) — `housekeeping=false`, `feature/deep=true`; user override always wins.
- `ecosystem-wizard` idempotent re-runs (#289) — diff-aware merge (JSON.stringify equality gate), `overwrite` param on `writeSessionConfigBlock`. +11 tests.
- `zombie-threshold-min` end-to-end wiring (#178) — config schema (default 30 min), `parseEtimeToMinutes` + `countZombieProcesses`. Verdict escalates when `zombie>=1 AND claude_processes_count>0`. +21 tests.
- `close` skill auto-strip `status:*` labels (#308) — `scripts/lib/issue-close-strip-labels.mjs` (glab + gh paths, idempotent, fail-open). +10 tests.
- `skills/evolve/SKILL.md` — Type 8 entry added; counter 6→8 sync (also picked up pre-existing missing `hardware-pattern` #7 in Step 3.5 enum).
- PSA-001 vs PSA-002 refinement (#156) — decision-tree, scope-overlap examples, separate behavior blocks; PSA-003/004 untouched. +8 tests.

#### Tooling upgrades
- ESLint 9 → 10 (#286) + `@eslint/js` 10 + `jiti` 2.6.1; 4 breaking-change rule fixes.
- `js-yaml` devDep added — fixes pre-existing `architecture-ddd-trio` test (20 tests unblocked).

#### Documentation
- `README.md` expanded as single source (live counts: 25 skills / 10 commands / 7 agents / 6 hooks).
- `CLAUDE.md` stripped 127 → 81 lines (pointer + runtime-critical: Session Config block byte-preserved, Destructive-Command Guard, Agent Authoring Rules, Current State).

### Fixed

- **#382** ecosystem-health body-status precedence — drop `curl -f` so 4xx/5xx still deliver body; add `-w 'HTTP_STATUS:%{http_code}'`; body-first JSON parse: `{status: degraded}` → DEGRADED on any 200-599. Report Format updated to list DEGRADED + DOWN as flag-worthy.
- **#400** `sessions.jsonl` writer alias — `scripts/lib/session-schema.mjs` adds `waves_completed → total_waves` to `SESSION_KEY_ALIASES` so legacy coord-direct entries normalize cleanly. `skills/session-end/session-metrics-write.md` gains MANDATORY WRITE PATH callout forbidding hand-composed JSONL writes; `emit-session.mjs` documented as the only sanctioned writer.
- **#32** events.jsonl `agent:"unknown"` 100%-of-the-time bug — `hooks/on-stop.mjs` `agent_name` (invented) → `agent_type` (Claude Code contract). 11 fixture rewrites; 3 new tests including a contract-pin guarding against `agent_name` reintroduction.
- **#222** harness-audit integration JSON truncation — root cause: `spawnSync` default `maxBuffer` <12KB on some CI; fixture pollution from prior dev runs. Fix: explicit `maxBuffer=16MB`, `unlinkSync` guard in `copyFixtureToTmpdir`. 10/10 pass.
- **#279** schema-drift CI 403 — `.gitlab-ci.yml` uses `SCHEMA_DRIFT_TOKEN` (deploy token / PAT) instead of `CI_JOB_TOKEN`; missing-token fallback skips gracefully. `docs/ci-setup.md` documents creation steps.

### Removed

- `scripts/lib/common.sh` — superseded by `common.mjs` (`die`, `warn`, `requireJq`, `findProjectRoot`, `resolvePluginRoot`).
- `scripts/lib/platform.sh` — superseded by `platform.mjs`.
- `scripts/lib/gates/gate-{baseline,incremental,full,per-file,helpers}.sh` (5 files, 365L).
- `scripts/lib/validate/check-{plugin-json,component-paths,json-files,agents,commands}.sh` (5 files, 458L).
- 5 top-level .sh scripts: `codex-install.sh`, `cursor-install.sh`, `run-quality-gate.sh`, `validate-plugin.sh`, `lib/fetch-baseline.sh`.

### Security

- **#247** vault-backfill YAML injection (CWE-1336) — `yamlScalar(JSON.stringify)` helper applied to user-supplied `owner` and `gitlabPath`. Newline-injection regression test proves no extra YAML keys emitted. +14 tests.
- **#108** bootstrap security — atomic lock-write, claude-init guard, cp-rP symlink fix. +7 regression tests.

### Closed Issues

- **Epics:** #309 (Architecture-DDD-Trio adoption), #271 (v3.2 Autopilot), #181 (harness-retro), #265 (META-AUDIT triage), #161 (Owner Persona D-axis).
- **Owner Persona D-axis:** #173 (consent merged), #175, #176, #177 (D2/D3/D4).
- **Refactor splits:** #283, #284, #285, #287, #288, #122, #121, #208.
- **Bash-free milestone:** #218, #317, #124 (Windows native superseded by v3.2.0).
- **Bug fixes / hardening:** #303, #304, #290, #203, #289, #178, #211, #227, #228, #308, #269, #212, #214, #247, #156, #266, #264, #279, #113, #112, #222, #382, #400.
- **AGENTS.md alias parity:** #33, #32, #30.
- **Vault & docs:** #232, #230, #237, #223, #144, #319.
- **Tracking & verification:** #143, #152, #153, #154, #119, #86, #174, #215, #286, #306, #108.
- **Spawned during this cycle:** #317 (closed same cycle), #318 (G-axis tracker, kept open).

### Quality

- Tests: 1871 (post-v3.2.0) → **2623** (+752), 12 skipped.
- Typecheck: 54 files OK.
- Lint: 0 errors / 0 warnings.
- Coverage above thresholds 70 / 65 / 70 / 60.
- Banner-version-sync regression test (`tests/hooks/banner-version-sync.test.mjs`) keeps `hooks/{hooks,hooks-codex}.json` echo banners aligned with `package.json`.

### Migration

- **No breaking changes.** All public APIs (config keys, CLI flags, JSON outputs) preserved.
- The `learnings.jsonl` and `sessions.jsonl` schema evolutions ship with idempotent migrate-* CLIs (`scripts/migrate-learnings-jsonl.mjs`, `scripts/migrate-sessions-jsonl.mjs`); existing legacy entries are normalized on next read via `SESSION_KEY_ALIASES` (read-time backwards compat).
- `bootstrap.lock` v1 entries gain a new optional `plugin-version` field; absence triggers a `soft` info banner only.
- The bash-free refactor is internal — `node_modules`-managed `node` is the only runtime; no `bash` is invoked from any plugin script after upgrade.


## [3.2.0] - 2026-04-27

Consolidated stable release covering the v3.0.0 (Windows native), v3.1.0 (environment-aware sessions), and v3.2.0 (Mode-Selector + Autopilot) work since v2.0.0. Supersedes the `v3.0.0-rc.1` pre-release.

### ⚠ BREAKING CHANGES (carried from v3.0.0)

- **Node.js 20+ is required.** The plugin runs as ES modules (`.mjs`) and uses native `fs.promises`, `fetch`, and `AbortSignal.timeout`. Node 18 and earlier are unsupported.
- **`npm install` is required once in the plugin directory** before hooks fire. `zx` is a runtime dependency; without it, hooks fail at load time.
- **Hooks are now `.mjs` files instead of `.sh`.** `hooks/hooks.json` points to the Node runtime. Custom consumer configs that referenced `.sh` hook paths must be updated.
- **`jq` and Bash are no longer hard dependencies for hooks.** Scope/command enforcement and session state reads use native Node JSON parsing. `jq` remains a soft recommendation for policy-editing workflows.
- **`bats` test suite retired.** Development and CI use [vitest](https://vitest.dev/) exclusively.

See [`docs/migration-v3.md`](docs/migration-v3.md) for the upgrade path from v2.x.

### Added — Windows native + Node.js migration (v3.0.0 surface)

- **Native Windows support** — no WSL or Git-Bash required. All file paths use `path.join`, tmp paths use `os.tmpdir()`, filesystem walks terminate at drive roots, glob matching normalizes backslashes. CRLF-tolerant config parsing and `.gitattributes` EOL rules prevent autocrlf breakage.
- **GitHub Actions CI matrix** across `ubuntu-latest`, `macos-latest`, and `windows-latest` with `fail-fast: false`, concurrency grouping, and per-OS `jq` install steps.
- **Vitest test framework** (`npm test`) replacing the `bats` shell harness. 1871 passing tests with byte-exact parity checks against the retired Bash implementations.
- **`package.json` at plugin root** with `type: "module"`, `engines.node >= 20`, `zx ^8.1.0` runtime dep, ESLint v9 + Prettier v3 + Vitest dev deps. `npm ci` bootstraps a reproducible tree.
- **Pre-bash destructive-command guard** — `hooks/pre-bash-destructive-guard.mjs` blocks `git reset --hard`, `rm -rf`, `git push --force`, and related destructive operations in the main session, with a 13-rule policy at `.orchestrator/policy/blocked-commands.json`. Opt-out via `allow-destructive-ops: true` in Session Config.
- **Canonical `parallel-sessions.md` rule** vendored via bootstrap. Documents PSA-001 through PSA-004 (detect before acting, ask before assuming, never destroy what you didn't create, isolate your changes).
- **ESLint v9 flat config + Prettier** with Node 20 globals, `_`-prefix allowlist for unused vars, markdown excluded.

### Added — Environment-aware sessions (v3.1.0 surface)

- **Resource-gate dispatch** — `scripts/lib/wave-resource-gate.mjs` reads live RAM/CPU/concurrent-session metrics before dispatching each wave. Eight-rule decision chain returns `proceed`, `reduce` (halve agent count), or `coordinator-direct` (0 agents). Configurable via `resource-thresholds` in Session Config; failures degrade to `proceed` so the gate never blocks.
- **`worktree-exclude` Session Config field** — string array of top-level directories skipped when creating agent worktrees. Default 10-pattern list (`node_modules`, `dist`, `build`, `.next`, `.nuxt`, `coverage`, `.cache`, `.turbo`, `.vercel`, `out`). Empty array disables. Cuts worktree clone size dramatically on large repos.
- **Multi-session registry** — `scripts/lib/session-registry.mjs` tracks active sessions across the host with heartbeat + sweep semantics. `on-session-start` hook registers the session and detects peers; `on-stop` deregisters cleanly. Enables resource-gate to factor in concurrent Claude/Codex sessions.
- **Anonymized hardware learnings** — `scripts/export-hw-learnings.mjs` exports anonymized hardware-pattern learnings for sharing. Promotion pipeline + anonymization regex tuning (no machine names, no usernames, no absolute paths).
- **CWD-drift guard** — `restoreCoordinatorCwd` runs after every worktree-isolated `Agent` dispatch so subsequent coordinator Edit/Write/Bash calls cannot silently route to a worktree branch.
- **Coordinator snapshots** — pre-dispatch `git stash create` refs under `refs/so-snapshots/` provide crash recovery for unfinished sessions; surfaced to the user via `AskUserQuestion` on session-start when the prior session was `active` or `paused`.

### Added — Mode-Selector + Autopilot (v3.2.0 surface)

- **Mode-Selector** — pure-function recommendation engine that suggests the next session mode (`housekeeping` | `feature` | `deep`) based on live signals: prior STATE.md recommendations, recent `sessions.jsonl` trend, surfaced learnings, bootstrap tier, and live VCS backlog scan. Renders a `📊` banner at session-start when confidence ≥ 0.5; modifies `AskUserQuestion` option ordering to put the recommendation first.
- **STATE.md Recommendations Contract** — five forward-looking frontmatter fields (`recommended-mode`, `top-priorities`, `carryover-ratio`, `completion-rate`, `rationale`) written by `session-end` and read by the next session-start as a `📋` banner. Backwards-compatible: pre-v1.1 STATE.md files are silently no-op.
- **Autopilot loop** — `/autopilot` runs `session-start → session-plan → wave-executor → session-end` chained for N iterations with kill-switches: SPIRAL detection, FAILED-wave gate, carryover > 50%, max-hours, sub-threshold confidence, etc. Eight kill-switches total.
- **Autopilot headless CLI** — `scripts/autopilot.mjs` is a walk-away driver. `--headless` required flag, `--verbose` pipes child stdio, `--dry-run` round-trips without spawning. Spawns `claude -p '/session <mode>'` per iteration and propagates `AUTOPILOT_RUN_ID` for retro joinability across `autopilot.jsonl` ↔ `sessions.jsonl`.
- **Vault-mirror auto-commit** — opt-in via `--session-id <id>`. After mirroring artifacts, stages `40-learnings/` + `50-sessions/`, validates `_generator: session-orchestrator-vault-mirror@1` frontmatter on every staged file, commits as `chore(vault): mirror <id> — N learnings + M sessions` when staged set is all-mirror, or unstages + warns on mismatch.
- **Docs-orchestrator** — opt-in audience-aware doc generation (User / Dev / Vault). Three hook points: session-start Phase 2.5 (audience detection + AskUserQuestion), session-plan Step 1.5/1.8 (Docs role classification + docs-writer auto-match), session-end Phase 3.2 (per-task ok/partial/gap verification).
- **Harness-audit scorecard** — deterministic 7-category rubric (`RUBRIC_VERSION` pinned), JSON to stdout + JSONL trend in `.orchestrator/metrics/audit.jsonl`. Available via `/discovery audit` probe and standalone `/harness-audit` command.
- **Plan modes** — `/plan new` (project kickoff with repo scaffolding), `/plan feature` (compact feature PRD), `/plan retro` (data-driven retrospective with vault-backfill sub-mode). All modes share a researched Q&A engine that dispatches parallel Explore agents before each question wave.
- **Discovery probes** — modular probes adapted to the project's tech stack, including `vault-staleness`, `vault-narrative-staleness`, `state-md-staleness`, and `bootstrap-lock-freshness`.
- **Adaptive wave sizing** — complexity scoring (files × directories × issues) maps to agent counts per role. Cross-session learnings can override the formula based on historical data.
- **Intelligent agent dispatch** — project agents > plugin agents > general-purpose. Optional `agent-mapping` Session Config for explicit role-to-agent binding. Model selection matrix (haiku / sonnet / opus per task type).
- **`isolation: 'none'` default for new-directory waves** — Pre-Dispatch New-Directory Detection forces `isolation: 'none'` when any agent's target parent directory doesn't exist and `configIsolation: 'auto'`. Avoids the Claude Code merge-back regression where new-dir writes silently fail to sync back from worktrees. Explicit `isolation: 'worktree'` overrides are honored with a warning.

### Changed

- **All hooks and `scripts/lib/` helpers migrated from Bash to Node.js.** Security-critical hooks (`enforce-scope.mjs`, `enforce-commands.mjs`) include symlink-escape protection, shell-operator + quote-boundary parsing, and Windows backslash normalization.
- **Cross-platform path handling** — `os.tmpdir()` replaces `${TMPDIR:-/tmp}`, `path.join`/`path.sep` throughout, `path.parse(dir).root` for filesystem-walk termination.
- **Native JSON parsing** replaces all `jq` shell-outs inside hooks.
- **Vitest 4.1.5** — upgraded from vitest 2.1.9. Includes the GitHub Actions CI tinypool timeout wrapper for Windows.

### Removed

- `bats` test suite — retired in favor of vitest.
- Hard runtime dependency on `jq` and `bash` for hooks.

### Security

- Pre-bash destructive-command guard active alongside subagent waves.
- Symlink-escape protection in scope-enforcement (`fs.realpath` + ancestor-walk fallback for non-existent targets).
- Shell-operator + quote-boundary parsing in command-enforcement (catches `ls;rm -rf /`, `psql -c "DROP TABLE …"`, and similar bypass patterns).
- `CLAUDE_PROJECT_DIR` validated against the platform's state directory before being trusted by enforcement hooks.
- Coordinator-snapshot refs (`refs/so-snapshots/`) garbage-collected at session-end for completed sessions.

### Quality

- 1871 tests passing / 10 skipped across vitest suites.
- Coverage thresholds: 70 / 65 / 70 / 60 (lines / functions / statements / branches).
- ESLint v9 flat config, Prettier v3 — `lint:fix` idempotent on the full tree.
- TypeScript discipline via `node scripts/typecheck.mjs` (43 file(s) OK).

### Migration

Short version:

```bash
cd /path/to/session-orchestrator
git pull
npm install           # installs zx + vitest + ESLint + Prettier
# Restart Claude Code / Codex / Cursor so hooks.json is re-read.
```

For details, see [`docs/migration-v3.md`](docs/migration-v3.md). Rollback: `git checkout v2.0.0 && rm -rf node_modules` and restart the editor.

---

## Internal Development Trail (pre-v3.2.0)

Detailed per-session entries captured during the v3.0.0 / v3.1.0 / v3.2.0 development cycles. Retained for traceability; content is consolidated in the [3.2.0] release block above.

### Added — harness-retro Wave 1 (2026-04-19, Epic #181)

Promotes validated patterns from advanced consumer repos into bootstrap defaults.

- `scripts/lib/config-schema.mjs` + `scripts/validate-config.mjs` (#182): plain-JS Session Config validator (no zod dep). Enforces 7 mandatory fields (`test-command`, `typecheck-command`, `lint-command`, `agents-per-wave`, `waves`, `persistence`, `enforcement`). Wired into `scripts/parse-config.sh` with enforcement-aware behavior (off|warn|strict). Bypass via `SO_SKIP_CONFIG_VALIDATION=1`.
- Bootstrap canonical config block: `_minimal/CLAUDE.md.tmpl` + `fast-template.md` + `public-fallback.md` now emit all 7 mandatory fields on every tier.
- Bootstrap `--retroactive` config-field patcher (#182): fills missing mandatory fields with package-manager-aware defaults during retroactive adoption.
- `.orchestrator/policy/quality-gates.schema.json` + `quality-gates.example.json` + `scripts/lib/quality-gates-policy.mjs` (#183): JSON-Schema policy for canonical test/typecheck/lint commands. Readable from Node (`loadQualityGatesPolicy`, `resolveCommand`) and Bash (`scripts/run-quality-gate.sh` policy-first `extract_command`).
- `scripts/lib/package-manager.mjs` (#183): lockfile-based detection (`pnpm-lock.yaml` / `yarn.lock` / `bun.lockb` / `package-lock.json`) + per-PM default command triads. Null falls back to npm (most portable).
- `skills/bootstrap/standard-template.md` Step 6.5 (#183): bootstrap writes `.orchestrator/policy/quality-gates.json` with package-manager-aware defaults. Idempotent — never overwrites user edits.
- `skills/bootstrap/standard-template.md` Step 6.6 + `skills/bootstrap/STATE.md.template` (#184): bootstrap scaffolds an idle STATE.md placeholder.
- `scripts/lib/state-md.mjs` (#184): hand-rolled YAML-subset frontmatter helpers (`parseStateMd`, `serializeStateMd`, `touchUpdatedField`, `readCurrentTask`). Never throws.
- STATE.md schema v1 extended with 3 optional fields: `updated`, `session`, `session-start-ref`. Backward-compat for files that omit them.
- `skills/session-start/SKILL.md` Phase 1.5: current-task banner from STATE.md. Phase 4: command-availability check before quality baseline.
- `skills/session-end/SKILL.md` Phase 3.4: touches `updated: <ISO>` on session close.
- `skills/discovery/probes-session.md`: new `state-md-staleness` probe (warn >7d, info 2-7d) reading optional `updated` frontmatter with file-mtime fallback.
- vitest coverage: +68 tests across `tests/lib/{config-schema,quality-gates-policy,package-manager,state-md}.test.mjs` and `tests/integration/parse-config-validator.test.mjs`. Total suite: 546 pass, 10 skipped.

### Added — v3.1.0 sub-epic B resource-gate session (2026-04-19)
- `scripts/lib/wave-resource-gate.mjs` (#193): pre-dispatch gate consumed by wave-executor. Reads `resource-thresholds` from Session Config and live RAM/CPU/concurrent-session metrics from `resource-probe.mjs`. 8-rule decision chain returns `proceed`, `reduce` (halve agent count, min 1), or `coordinator-direct` (0 agents). Probe failures and missing-thresholds configs degrade to `proceed` — gate never blocks the dispatch loop. Exported `formatGateReport(result)` helper for coordinator progress updates.
- `skills/wave-executor/wave-loop.md` § 0.5 (#193): pre-dispatch resource-gate playbook + STATE.md deviation contract — `reduce` and `coordinator-direct` decisions append a single timestamped line to `## Deviations` with measurements, so future sessions and `/evolve` can mine for hardware-pattern learnings.
- `worktree-exclude` Session Config field (#192): string array of top-level directories to skip when creating agent worktrees. Default 10-pattern list (`node_modules`, `dist`, `build`, `.next`, `.nuxt`, `coverage`, `.cache`, `.turbo`, `.vercel`, `out`). Empty array disables the feature. Mirrored across `scripts/lib/config.mjs`, `scripts/parse-config.sh`, and the validator.
- `scripts/lib/worktree.mjs` `applyWorktreeExcludes(wtPath, patterns)` (#192): pure-fs helper extracted from `createWorktree` for unit-testability (dodges a vitest worker-thread + zx AsyncLocalStorage interaction). Best-effort `fs.rm` per pattern, stderr-logs each removal. `createWorktree` now reads the configured exclude list (or accepts `options.excludePatterns`) and applies the helper after `git worktree add` succeeds. Bash parity in `scripts/lib/worktree.sh`.
- vitest coverage: 12 cases for `wave-resource-gate` (each decision branch + `plannedAgents=0/1` edges + probe-failure mock + missing-thresholds defensive path), 5 cases for `applyWorktreeExcludes` (default list, custom override, empty disables, non-existent pattern, top-level-only nesting), 2 cases for `worktree-exclude` config parsing. Suite total: 533/543 pass, 10 pre-existing skipped, 0 failed.

### Context — sub-epic B
Issues #192 and #193 were filed in response to an OOM incident in a consumer repo (2026-04-19) where parallel sessions saturated host RAM. The exclude list keeps worktree clones lean; the resource-gate halves or escalates dispatches when free RAM drops below configured thresholds. Both ship on `feat/v3.1-resource-gate-192-193 → feat/env-aware-v3.1` (Sub-Epic A+B will land via MR !9 once env-aware reaches main).

### Added — libs + hooks session (2026-04-19)
- `scripts/lib/io.mjs` (#131): hook stdin/stdout helpers. `readStdin()` with 5 s AbortController timeout + 1 MB byte guard, `emitAllow`/`emitDeny`/`emitWarn`/`emitSystemMessage` matching the Claude Code hook I/O contract (exit 2 for deny, 0 for allow, single-line JSON on stdout). Pure Node stdlib, no external deps.
- `scripts/lib/events.mjs` (#133): JSONL append to `.orchestrator/metrics/events.jsonl` via `fs.promises.appendFile` + optional fire-and-forget webhook POST via native `fetch` with `AbortSignal.timeout(3000)` when `CLANK_EVENT_SECRET` is set. Network errors swallowed; graceful skip when env var unset.
- `scripts/lib/worktree.mjs` (#134): zx-based cross-platform git worktree helpers. `os.tmpdir()` replaces `${TMPDIR:-/tmp}`, `path.join` throughout for Windows separator safety, retry-once pattern in `createWorktree`, best-effort `removeWorktree` (always resolves, warns on uncommitted changes), `listWorktrees`, `cleanupAllWorktrees`.
- `scripts/lib/hardening.mjs` (#135): env/runtime checks (`assertNodeVersion`, `assertDepInstalled`, `checkEnvironment`) plus scope/pattern primitives used by the Wave 3 hooks (`findScopeFile`, `getEnforcementLevel`, `gateEnabled`, `pathMatchesPattern`, `commandMatchesBlocked`, `suggestForScopeViolation`, `suggestForCommandBlock`). Scope expanded beyond the original issue to absorb hook-primitive helpers — documented in the commit trailer.
- `scripts/lib/common.mjs` (#136): shared utilities (`makeTmpPath`, `utcTimestamp`, `epochMs`, `readJson`, `writeJson`, `appendJsonl`). Async `fs.promises`, auto-creates parent directories via recursive `mkdir`.
- `hooks/enforce-scope.mjs` (#137): PreToolUse hook blocking Edit/Write outside `wave-scope.json` `allowedPaths`. Node port of `hooks/enforce-scope.sh` with SECURITY-REQ-01..08 from security pre-review addressed: top-level try/catch emits `emitDeny` on any unhandled error (never exit 1), `fs.realpath` on file + ancestor-walk fallback for non-existent targets prevents symlink-escape, Windows backslash normalization before glob matching, relative `file_path` resolved against project root (not CWD), scope file read once per invocation.
- `hooks/enforce-commands.mjs` (#138): PreToolUse hook blocking dangerous Bash commands. Shell-operator-aware word boundary (catches `ls;rm -rf /`, `ls&&rm -rf /`, `(rm -rf /)`, `` `rm -rf /` ``, `$(rm -rf /)`) plus quote-boundary (catches `psql -c "DROP TABLE …"`). Fallback blocklist expanded: adds `git push -f` short form and `drop table` lowercase variant that the Bash predecessor missed.
- vitest coverage for Wave 2–3 artifacts: 179 tests across `tests/lib/{io,events,worktree,hardening,common}.test.mjs` and `tests/hooks/{enforce-scope,enforce-commands}.test.mjs`. Includes F-01 shell-operator-bypass regression block, F-02 symlink-escape regression (skipIf win32), 10-row `pathMatchesPattern` parity table, and 8-row `commandMatchesBlocked` parity table from the migration baseline spec. Total suite: 343 tests pass, 10 pre-existing skipped, 0 failed.

### Fixed — libs + hooks session
- `scripts/lib/worktree.mjs`: replaced 5 `$.nothrow($\`…\`)` call sites with the `nothrow` named export — in zx v8 `$.nothrow` is a boolean property, not callable; the original code threw `TypeError` on every cleanup path.
- `scripts/lib/hardening.mjs:commandMatchesBlocked`: extended boundary class from `\s` to `[\s;|&(){}`'"]`. Previously `ls;rm -rf /` bypassed the blocklist because the semicolon wasn't a boundary char; `psql -c "DROP TABLE …"` bypassed because the quote wasn't either. Both are now caught (7 regression tests).

### Also on this branch (parallel non-session commits)
Three vault-sync commits (`a76e180`, `e3c8e47`, `82be589`) landed alongside the v3 libs/hooks session. Scope: managed-mirror Zod schema sync with a drift gate, BEGIN/END sentinels on vendored schema, GitLab CI pipeline (`test` + `schema-drift-check` stages), and learning-provenance decoupling from session-file lifecycle. Not part of the `[131,133,134,135,136,137,138]` session plan — documented here for traceability. Requires a one-time `projects-baseline` CI/CD Token Access allowlist for `infrastructure/session-orchestrator` before the first pipeline run.

### Added — foundation wave (2026-04-18)
- `.gitattributes` (#125): cross-platform EOL rules. LF for `.sh`, `.md`, `.json`, `.yaml`, `.mjs`; CRLF for `.ps1`; `* text=auto` fallback. Prevents autocrlf breakage on Windows checkouts.
- `package.json` + `package-lock.json` (#126): plugin-root Node 20+ manifest with `type: "module"`, zx ^8.1.0 dep, ESLint v9, Prettier v3, and vitest ^2 devDeps. `npm ci`-installable. Version bumped to `3.0.0-dev`.
- ESLint v9 flat config + Prettier (#127): `eslint.config.js` with @eslint/js recommended, Node 20 globals, project rules (`no-unused-vars` with `_`-prefix allowlist, `prefer-const`, `no-var`, `eqeqeq`). `.prettierrc` uses single quotes, 100 columns, LF. `.prettierignore` excludes `*.md` because skill files have intentional formatting. Baseline green, `lint:fix` idempotent.
- CI matrix for ubuntu, macos, and windows-latest (#128): `.github/workflows/test.yml` extends to a 3-OS matrix with `fail-fast: false`. Preserves v2.0 hardenings (least-privilege `permissions`, `timeout-minutes`, SHA-pinned actions). Adds concurrency group, conditional typecheck (gated on `.mjs` existence), jq install per-OS, vitest placeholder for Wave 4.
- `scripts/lib/platform.mjs` (#129): Node port of `platform.sh` with Windows-safe filesystem walk (`path.parse(dir).root` replaces the Bash `/`-terminator that breaks on `C:\`). New exports: `SO_OS`, `SO_IS_WINDOWS`, `SO_IS_WSL`, `SO_PATH_SEP` alongside the six existing IDE/project constants. Five named helper functions for callers that need to re-detect.
- `scripts/lib/path-utils.mjs` (#130): CWE-23-safe pure path helpers backing the forthcoming `enforce-scope.mjs`. Rejects null bytes, empty strings, UNC paths (Windows), prefix-match confusion, cross-drive escapes. Locale-stable case normalization via `toLocaleLowerCase('en-US')` to avoid Turkish-I-style regressions. Exports a documented `CWE_23_ATTACK_PATTERNS` taxonomy for test self-check.
- `scripts/lib/config.mjs` (#132): Node port of `parse-config.sh` + `config-yaml-parser.sh` + `config-json-coercion.sh` combined into one module with private coercion helpers. CRLF-tolerant input, native JSON (no jq shellout). Byte-exact parity against the `.sh` version on the project's own `CLAUDE.md`.
- vitest coverage for foundation libs: 142 tests across `tests/lib/{platform,path-utils,config}.test.mjs` plus 5 fixtures under `tests/fixtures/`. `path-utils` tests cover every documented CWE-23 vector and are falsification-verified. `config` tests include a subprocess-bash parity diff gated on non-Windows.

### Fixed — foundation wave
- session-start: reset STATE.md to idle when previous session completed. Clears `current-wave`, sets `status: idle`, demotes `## Wave History` into `## Previous Session`, and empties `## Deviations`. Only triggers on the `completed` branch; `active` and `paused` paths remain user-interactive via AskUserQuestion. Prevents a fresh session from appearing "already completed". (closes infrastructure/projects-baseline#159)
- Pre-v3 `.mjs` lint baseline: removed an unused `fileURLToPath` import, replaced `== null` with explicit `=== null || === undefined`, prefixed intentionally-unused destructures and params with `_`, cleaned a `no-useless-escape`. `npm run lint` is now idempotent on the full tree.

### Migration — still pending
- Hook wiring (`hooks.json` → `.mjs`) is still on the bash files. `enforce-scope.mjs` + `enforce-commands.mjs` are implemented and tested but not yet activated — that lands with #142 in a later session.
- 3 lower-priority hook migrations remain (`post-edit-validate`, `on-session-start`, `on-stop`) — issues #139–#141.

### Migration
- Developer prerequisite: Node 20+ and `npm ci` after clone. Existing bash test suite (`scripts/test/run-all.sh`) continues to work on Unix while the foundation stabilizes; Windows users run `npm test` only.
- No user-visible breakage yet. Hook migrations in later waves will require `npm install` in the plugin directory before hooks fire.

## [2.0.0] - 2026-04-17

First stable release of the 2.x line. Bundles six betas worth of work into a single stable cut.

### Added
- **Bootstrap Gate** (beta.6): non-bypassable Phase-0 check that prevents orchestrator skills from running against unstructured repos. Three tiers (Fast/Standard/Deep), committed `.orchestrator/bootstrap.lock`, new `/bootstrap` command with `--fast`/`--standard`/`--deep`/`--upgrade`/`--retroactive` flags.
- **Pre-dispatch grounding injection** (beta.5): prepends line-numbered GROUNDING blocks to agent prompts for files with recent `edit-format-friction` stagnation history, reducing Edit-tool retry loops. Per-agent scope, capped at `grounding-injection-max-files` (default 3), gated on `persistence: true`.
- **Learnings-system efficiency** (beta.4): ranked cap on surfaced learnings (`learnings-surface-top-n`, default 15), passive confidence decay for untouched entries, surface-health telemetry in session-start, and retirement of the legacy split-brain `metrics/learnings.jsonl` path.
- **Scope and command enforcement hardening** (beta.2): shared `scripts/lib/hardening.sh` module with per-gate toggles (`enforcement-gates`), actionable denial suggestions, stagnation pattern detection (Pagination Spiral, Turn-Key Repetition, Error Echo), and file-level grounding verification (`grounding-check`).
- **Stagnation telemetry** (beta.2): session-end emits per-agent stagnation events with `pattern` and `error_class` fields; evolve accumulates these into `stagnation-class-frequency` learnings. Error-Class Taxonomy covers six classes.
- **Clank Event Bus integration** (beta.1): async event emission for session start, stop, and agent stop events via `scripts/lib/events.sh`. Graceful degradation when unconfigured.
- **Wave execution foundation** (alpha series): role-based wave assignment, adaptive sizing from complexity scoring, cross-session learning system, worktree isolation, circuit breaker with maxTurns and spiral detection, session persistence via STATE.md, PreToolUse enforcement hooks, and deterministic config parsing in `scripts/parse-config.sh`.

### Changed
- Marketplace install identifier is `session-orchestrator@kanevry` (renamed from the redundant `session-orchestrator@session-orchestrator` in beta.3).
- Phase 0 of every orchestrator skill (`/plan`, `/session`, `/go`, `/close`, `/discovery`, `/evolve`) now runs the Bootstrap Gate before any other work.
- Cross-session learnings are now ranked by confidence and capped before injection; entries that go untouched across sessions decay gradually rather than staying at full weight indefinitely.

### Security
- Placeholder substitution in bootstrap public-fallback templates uses Python `argv`, not `sed` string interpolation, to prevent injection via repo names.
- Explicit file enumeration for `git add` in all bootstrap templates; no `git add -A` in generated commit steps.
- `glab api` and `gh api` error output is redacted to prevent token leakage in hook logs.
- Scope enforcement defaults to fail-closed (`strict`) when the `enforcement` field is absent from `wave-scope.json`.
- `CLAUDE_PROJECT_DIR` is validated to contain a `.claude/` directory before being trusted by enforcement hooks.

### Migration
- Consumer repos with a legacy `<state-dir>/metrics/learnings.jsonl` file should run `bash <plugin>/scripts/migrate-legacy-learnings.sh` once after upgrading. The script is idempotent and produces a `.bak` copy of anything it touches.
- The plugin install command changed in beta.3: use `/plugin marketplace add <source>` and `/plugin install session-orchestrator@kanevry` inside a running Claude Code session. There is no `claude plugin` shell command.

## [2.0.0-beta.6] — 2026-04-16

Issue #98 (Epic) — Bootstrap Gate. Addresses the "LLM rationalizes past hard-stops" problem: in a new empty repo, Codex bypassed the `/plan` skill's Phase-0 abort by falling back to "pragmatic paths", leaving the repo unstructured. The gate is a state-file-backed, cross-platform (Claude Code / Codex / Cursor), non-bypassable replacement. All 20 test suites pass.

### Added — Bootstrap Gate (Epic #98)

- **Non-bypassable Bootstrap Gate** (`skills/_shared/bootstrap-gate.md`) runs in Phase 0 of every orchestrator skill (`/plan`, `/session`, `/go`, `/close`, `/discovery`, `/evolve`). If a repo lacks `CLAUDE.md` + `## Session Config` + `.orchestrator/bootstrap.lock`, the gate invokes a new bootstrap flow.
- **Three intensity tiers** — Fast (demos/spikes), Standard (MVPs/products), Deep (production/team). Each tier is a strict superset of the previous. LLM recommends tier from first user prompt; user confirms with one question.
- **Public path** for users without a local `projects-baseline`: `claude init` (Claude Code) or plugin-bundled minimal templates (Codex, Cursor). Five archetypes: `_minimal`, `static-html`, `node-minimal`, `nextjs-minimal`, `python-uv`.
- **Anti-bureaucracy guardrails** — exactly 1 question in normal flow, max 2 in ambiguous public path; idempotent gate check; committed `.orchestrator/bootstrap.lock` as mechanical truth.
- **New `/bootstrap` command** with `--fast`/`--standard`/`--deep`/`--upgrade <tier>`/`--retroactive` flags.
- **Six new test scripts** covering gate-check, tiers, upgrade, public path, idempotency, red-team.

### Changed

- Phase 0 Bootstrap Gate prepended to all 6 orchestrator skills (`plan`, `session-start`, `wave-executor`, `session-end`, `discovery`, `evolve`).

### Security

- Sanitized placeholder substitution in `skills/bootstrap/public-fallback.md` (Python argv, not sed string interpolation).
- Explicit file enumeration for `git add` in all bootstrap templates (no `git add -A`).
- Redacted `glab api` / `gh api` error output to prevent token leakage.
- Follow-up issues #108 (LOW security) and #109 (MEDIUM+LOW tech-debt) filed for remaining hardening.

### Motivation

Addresses the "LLM rationalizes past hard-stops" problem: in a new empty repo, Codex bypassed the `/plan` skill's Phase-0 abort by falling back to "pragmatic paths", leaving the repo unstructured. The gate is a state-file-backed, cross-platform (Claude Code / Codex / Cursor), non-bypassable replacement.

## [2.0.0-beta.5] - 2026-04-15

Issue #85 — pre-dispatch grounding injection for friction-prone files. Direct translation of the Hashline idea from the *Harness Problem* abgleich (gap G3) to wave-executor's layer: when an agent's scope includes a file with recent `edit-format-friction` stagnation history (from #84 telemetry), the agent prompt is prepended with a line-numbered view of that file so the agent references lines stably instead of re-matching character spans. Per-agent scope, capped at `grounding-injection-max-files` (default 3), gated on `persistence: true`. All 14 script test suites remain green; integration fixtures grew from 107 to 122 assertions.

### Added
- feat(wave-executor): pre-dispatch grounding injection — prepend a line-numbered GROUNDING block to each agent's prompt for any file in the agent's scope that has recent `edit-format-friction` stagnation history (from #84 telemetry). Reduces Edit-tool retry loops by giving agents stable line-number references. Per-agent scope, capped at `grounding-injection-max-files` (default 3). Helper script `scripts/compute-grounding-injection.sh` (new); gated on `persistence: true`. Addresses Harness Problem gap G3. (#85)
- feat(session-end): aggregate `grounding_injected` events into sessions.jsonl as `grounding_injections: {count, files, total_lines}`. Omitted when `count == 0`. (#85)
- config: `grounding-injection-max-files` (integer, default `3`) — cap files injected per agent; set `0` to disable the feature. (#85)

### Tests
- test-integration.sh Group 12 (#85): 15 new assertions covering config default/override/disable, helper early-exit, match-and-emit, cap behavior with `grounding_capped=true`, and PERSISTENCE=false no-event-write path. Total integration assertions 107 → 122.

## [2.0.0-beta.4] - 2026-04-15

Epic #87 — learnings-system efficiency package. Four targeted changes to the cross-session intelligence layer that restore the original design intent: surface the most useful learnings, let irrelevant ones fade naturally, retire the legacy split-brain file, and make the whole thing transparent. Empirical baseline from a consumer repo (85 active learnings, ~13.6k tokens at every session-start) motivated the bundle. All 14 script test suites remain green; integration fixtures grew from 76 to 107 assertions.

### Added
- feat(session-start): rank and cap learnings injection — sort active learnings by confidence, slice to `learnings-surface-top-n` (default 15). Reduces Phase 5.6 token consumption on mature consumer repos. Configurable via Session Config key. Addresses Epic #87 / Issue #88. (#88)
- feat(session-end): passive confidence decay for untouched learnings — subtract `learning-decay-rate` (default `0.05`) from every learning not confirmed, contradicted, or newly-appended this session. Applied before the existing prune step. `0.0` opts out. A learning starting at `0.5` survives ~10 untouched sessions. Addresses Epic #87 / Issue #89. (#89)
- feat(session-start): "Surface health" sub-section in Project Intelligence — shows active/surfaced/suppressed counts, confidence distribution (high/medium/low), oldest surfaced entry, source file, vault mirror status. Prints an advisory when suppressed > surfaced. Addresses Epic #87 / Issue #91. (#91)

### Fixed
- fix(session-start): retire legacy `<state-dir>/metrics/learnings.jsonl` fallback — Phase 5.6 and `_shared/config-reading.md` now read ONLY the canonical `.orchestrator/metrics/learnings.jsonl`. Consumer repos with leftover legacy entries should run `scripts/migrate-legacy-learnings.sh` once. Addresses Epic #87 / Issue #90. (#90)

  **MIGRATION**: in each consumer repo, run:

      bash <plugin>/scripts/migrate-legacy-learnings.sh

  where `<plugin>` is the session-orchestrator plugin directory. The script is idempotent, produces a `.bak` copy of any legacy file it touches, and emits a one-line JSON summary on stdout.

### Tests
- Added 31 integration-test assertions across 4 new fixture groups in `scripts/test/test-integration.sh`: Group 8 (cap+rank, #88, 6 assertions incl. equal-confidence tiebreaker), Group 9 (passive decay, #89, 3 assertions incl. IEEE-754 tolerance), Group 10 (surface health, #91, 8 assertions incl. positive + negative advisory), Group 11 (migration helper, #90, 13 assertions incl. empty-canonical, malformed-legacy, idempotency).
- Added `json_float()` helper to `scripts/parse-config.sh` with regex + awk-based bounds validation (`0.0 ≤ x < 1.0` via strict-less-than max), covered by existing `test-parse-config.sh` suite.

## [2.0.0-beta.3] - 2026-04-15

Documentation patch release. No runtime code changes — all 16 script test suites remain green. End users and contributors can now successfully install the plugin through Claude Code for the first time since #14 shipped.

### Changed
- **Marketplace identifier** renamed from `session-orchestrator` to `kanevry` in `.claude-plugin/marketplace.json`. The plugin name itself remains `session-orchestrator`; this change only affects the suffix after `@` in the install command, so it reads `session-orchestrator@kanevry` instead of the redundant `session-orchestrator@session-orchestrator`. Existing local installs that registered the old marketplace name can remove it with `/plugin marketplace remove session-orchestrator` and re-add.
- **Version string audit** — bumped every `2.0.0-beta.2` reference in sync: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`, `hooks/hooks.json`, `hooks/hooks-codex.json`, `scripts/mcp-server.sh`, `README.md` version badge, `docs/USER-GUIDE.md` banner example, `CONTRIBUTING.md` hook example. Applies the version-string-drift learning from the beta.2 release-cut.

### Fixed
- **Install instructions** across `README.md`, `docs/USER-GUIDE.md`, and `CONTRIBUTING.md` referenced non-existent `claude plugin add` / `claude plugin install` shell commands. Claude Code has no such CLI — plugins install exclusively via the slash commands `/plugin marketplace add <source>` and `/plugin install <name>@<marketplace>` inside a running session. End users following the previous instructions could not install the plugin at all. Docs now show the correct slash-command flow for both GitHub and local-clone installs. This is a follow-up to #14, whose original fix in commit 802d821 introduced the incorrect commands.

## [2.0.0-beta.2] - 2026-04-13

### Added
- **Shared hardening module** (GL#76) — `scripts/lib/hardening.sh` with pure, independently-testable helpers (`require_jq`, `source_platform`, `find_scope_file`, `get_enforcement_level`, `gate_enabled`, `path_matches_pattern`, `command_matches_blocked`, `emit_deny`, `emit_warn`, `suggest_for_*`). All three enforcement hooks now source this module instead of duplicating logic.
- **test-hardening.sh** — 33 assertions covering path matching (directory prefix, `**`, single-segment glob, exact), command word-boundary matching, scope-file discovery, enforcement-level parsing, gate toggles, and suggestion content.
- **Per-gate enforcement toggles** (GL#77) — new `enforcement-gates` Session Config field. Object with boolean values for `path-guard`, `command-guard`, `post-edit-validate`. Missing entries default to enabled. Wave-scope.json gains optional `gates` field; `gate_enabled()` in hardening.sh drives skip logic.
- **Actionable suggestions in hook denials** (GL#78) — `enforce-scope.sh` and `enforce-commands.sh` now include a context-aware suggestion in their denial reason (e.g., force-push denial points to `--force-with-lease`; scope violation lists the allowed paths and next steps).
- **STATE:/PLAN: structured reasoning** (GL#79) — new `reasoning-output` Session Config field (boolean, default `false`). When enabled, wave-executor appends a STATE/PLAN transparency block to every agent prompt. Opt-in — adds prompt overhead.
- **Stagnation patterns** (GL#80) — `circuit-breaker.md` documents three new pagination-aware patterns (Pagination Spiral, Turn-Key Repetition, Error Echo) with a decision table mapping each to a recovery action. `wave-loop.md` step 2 hooks the per-agent check into the existing post-wave review. Detection is heuristic (LLM-applied), not executable code. Detection discipline explicitly notes that two different agents reading the same file is coordination, not stagnation.
- **File-level grounding verification** (GL#81) — `plan-verification.md` § 1.1a compares planned files (union of agent prompt scopes) against actual files (`git diff --name-only $SESSION_START_REF..HEAD`) and reports scope creep + incomplete coverage. Adds a `grounding` field to session metrics JSONL. Gated by the new `grounding-check` Session Config field (boolean, default `true`). Informational only — does not block session close. `wave-loop.md` step 2 also gains a per-wave variant (bullet 3b) using each wave's pre-dispatch HEAD snapshot.
- **Stagnation telemetry + error-echo classification** (GL#84) — `session-end` now emits per-agent stagnation events to `events.jsonl` with `pattern` + `error_class` fields; `evolve` accumulates these into `stagnation-class-frequency` learnings. `circuit-breaker.md` adds an Error-Class Taxonomy (scope-denied, command-denied, edit-format-friction, test-reality-gap, state-read-failure, unknown) with worked examples.
- **Design Philosophy section in wave-executor** (GL#82) — 200-word framing between Execution Model and Platform Note explaining why friction is intentional; references `circuit-breaker.md` + `wave-loop.md`.
- **Stagnation-class-frequency learning type** (GL#83) — shipped in `skills/evolve/SKILL.md:103-110` (redundant with #84 telemetry; issue closed as already-implemented in b238135).
- **test-stagnation.sh** + **test-grounding.sh** — 27 new assertions covering content structure of the new sections, parse-config round-trip for `grounding-check`, error-path for invalid values, and structural ordering (1.1 < 1.1a < 1.2).
- **vault-mirror skipped-invalid action** — new action type emitted when a JSONL entry fails field validation (C2 hardening); prevents silent data loss during auto-sync to the Meta-Vault.
- **daily skill corrupt-file guard** — detects 0-byte or frontmatter-less daily notes and re-creates them; distinct exit codes 2/3/4 for file-missing / corrupt / frontmatter-invalid.

### Changed
- `hooks/enforce-scope.sh`, `hooks/enforce-commands.sh`, `hooks/post-edit-validate.sh` refactored to source `scripts/lib/hardening.sh`. Behavior is unchanged in the default configuration; new behavior surfaces only when `enforcement-gates` or `reasoning-output` are set.
- `scripts/validate-wave-scope.sh` now validates the optional `gates` field (must be an object of booleans).
- `scripts/parse-config.sh` adds `enforcement-gates`, `reasoning-output`, and `grounding-check` fields; `json_bool_object()` helper coerces string values to real JSON booleans.
- `docs/session-config-reference.md` documents the new fields in the Persistence & Safety section.
- `.mcp.json` now falls back to `git rev-parse --show-toplevel` when `$CLAUDE_PLUGIN_ROOT` is unset, allowing local development inside this repo to connect the MCP server without reinstalling as a plugin.
- `skills/vault-sync/SKILL.md` — Outputs/Inputs sections rewritten to match `validator.mjs` impl; vestigial `--json` flag removed from `validator.sh`.
- `skills/daily/SKILL.md` — documented VAULT_DIR Session Config resolution; added Exit codes table.
- `skills/wave-executor/SKILL.md` — added Design Philosophy section (200w) with harness-friction framing.

### Fixed
- **vault-mirror C2 field validation** — malformed JSONL lines now produce `skipped-invalid` actions instead of crashing the sync loop.
- **vault-mirror C3 readline race** — switched to `for await` collect-then-sequential to prevent out-of-order Markdown writes on large JSONL streams.
- **vault-mirror C4 dry-run mkdir** — removed unconditional `mkdirSync` that leaked directories during `--dry-run`; guarded behind write-mode.
- **vault-mirror H3/H4** — nested null-checks + `session_id` slug validation with uuid fallback.
- **session-end C1 broken jq selector** — `.dest` / `written` action selector never matched; corrected to `.path` / `created|updated`. Action list extended with `skipped-invalid`.
- **daily skill** — 0-byte and frontmatter-less daily notes now re-create cleanly instead of propagating corrupt state.

### Sanitized
- Public-surface cleanup: `skills/vault-sync/SKILL.md` and `skills/_shared/model-selection.md` no longer reference private project names or absolute user paths.
- `.orchestrator/metrics/*.jsonl` removed from git tracking (per-project observability data belongs locally, not in the public repo).
- `docs/specs/` removed from git tracking (internal design artifacts).
- `.gitignore` updated accordingly.

### Tests
- 328 → 396 passing (33 new in test-hardening.sh, 6 new in test-parse-config.sh, 15 new in test-stagnation.sh, 12 new in test-grounding.sh — including 3 invalid-value error-path assertions, +2 in test-parse-config.sh for `grounding-check`).
- Bats: `daily.bats` 8 → 10, `vault-mirror.bats` 36 → 40 (+6 assertions across the vault stack).

## [2.0.0-beta.1] - 2026-04-08 — Beta Release

### Added
- **Clank Event Bus integration** (GL#53) — `scripts/lib/events.sh` with `so_emit_event()` function for async event emission to Clank's Event Bus (`events.<internal-host>/api/events`). Bearer-auth via `CLANK_EVENT_SECRET`, graceful degradation when unconfigured.
- **SessionStart event hook** — `hooks/on-session-start.sh` emits `orchestrator.session.started` with platform and project context
- **Stop/SubagentStop event emission** — existing hooks now emit `orchestrator.session.stopped` and `orchestrator.agent.stopped` events
- **Output Styles** (GL#56) — 3 output style definitions (`output-styles/session-report.md`, `wave-summary.md`, `finding-report.md`) for consistent session reporting format
- **test-events.sh** — 12 assertions covering event library loading, graceful degradation, hook integration, and registration

### Changed
- hooks.json + hooks-codex.json: SessionStart now includes async event notification hook
- Plugin version: alpha.15 → beta.1
- Tests: 172+ → 184+ passing (12 new event bus assertions)

### Closed
- GL#53 (HTTP Hooks — reimplemented as Clank Event Bus integration)
- GL#56 (Output Styles)
- GL#47 (Epic: Plugin API Alignment — all sub-issues resolved)

## [2.0.0-alpha.15] - 2026-04-08 — Plugin API Alignment

### Added
- **plugin.json component paths** — `commands`, `agents`, `hooks`, `mcpServers` fields per Plugin API spec
- **validate-plugin.sh** (GL#48) — 18-check validation script: manifest schema, component path resolution, hooks JSON, agent frontmatter, mcpServers validity
- **test-validate-plugin.sh** — 17 assertions covering valid plugin, missing fields, invalid JSON, broken paths, bad frontmatter
- **Stop hook** (GL#52) — `hooks/on-stop.sh` persists session state to metrics on unexpected exit
- **SubagentStop hook** (GL#52) — `hooks/on-subagent-stop.sh` logs agent completion for wave-executor metrics
- **MCP Server skeleton** (GL#54) — `.mcp.json` + `scripts/mcp-server.sh` exposing `session_config` and `session_metrics` tools via JSON-RPC 2.0 stdio

### Changed
- **Issue triage** (GL#60) — verified all 14 epic issues against actual Plugin API docs: 6 closed (not in API), 2 deferred, 4 implemented, 1 epic tracking
- hooks.json + hooks-codex.json now include `Stop` and `SubagentStop` event types
- Tests: 155 → 172+ passing (17 new validate-plugin assertions)

### Closed (not in Plugin API)
- GL#49 (`userConfig`), GL#50 (`CLAUDE_PLUGIN_DATA`), GL#51 (agent extended frontmatter), GL#55 (`bin/` auto-PATH), GL#57 (skill `paths`), GL#58 (LLM hook types)

### Deferred
- GL#53 (HTTP hooks), GL#56 (output styles)

## [2.0.0-alpha.14] - 2026-04-07 — Cross-Platform + Housekeeping

### Added
- **Codex CLI full support** — platform detection (`scripts/lib/platform.sh`), `.orchestrator/metrics/` shared knowledge layer, `.codex-plugin/` with 3 agent TOMLs (explorer, wave-worker, session-reviewer), hooks-codex.json, codex-setup.md
- **Cursor IDE rules-based integration** — 9 `.cursor/rules/*.mdc` files, sequential execution model (no Agent() tool), platform.sh cursor detection, cursor-setup.md, hooks-cursor.json, cursor-install.sh
- **Intelligent agent dispatch** — 3-tier resolution: project agents > plugin agents > general-purpose fallback. 5 domain agents (code-implementer, test-writer, db-specialist, ui-developer, security-reviewer)
- **Worktree tests** (GL#39) — `scripts/test/test-worktree.sh` with 10 assertions covering create/cleanup/cleanup_all
- **Platform slow-path tests** (GL#42) — 8 assertions for marker directory detection without env vars

### Changed
- **DRY hook scripts** (GL#41) — all 3 hooks now source `platform.sh` instead of duplicating `find_project_root()`
- **Removed orphan config fields** (GL#40) — `session-types` and `cli-tools` removed from parser, docs, tests, and 23 files total
- **Codex agent specialization** documented as known limitation (GL#43) — Platform Limitations section in codex-setup.md
- **Test-writer hardening** — 3 anti-greenwashing rules: hardcoded assertions, mandatory error tests, falsification self-check
- **Lifecycle Simulation v3** — 37 gaps found across 3-platform trace, 28 fixed (session-end, wave-executor, session-plan, discovery, evolve, hooks, .cursor/rules)
- All 10 SKILL.md files now include `model-preference-cursor` frontmatter
- `skills/_shared/platform-tools.md` extended with Cursor column
- `skills/_shared/config-reading.md` updated with Cursor fallback paths
- Tests: 130 → 155 passing (10 worktree + 8 platform slow-path + adjustments for removed fields)

### Fixed
- **3 discovery issues created** — GL#44 (post-edit-validate.sh JSON injection), GL#45 (Session Config dogfooding), GL#46 (.claudeignore)

## [2.0.0-alpha.13] - 2026-04-06 — Validate Refactor + Probes Split + PostToolUse Hook

- **refactor:** extract 4 helpers from `validate()` in validate-wave-scope.sh — 109→22 lines (#25)
- **refactor:** split `probes.md` (943 lines) into 6 category files — code, infra, ui, arch, session + intro (#26)
- **feat:** PostToolUse hook for incremental typecheck after Edit/Write — informational, never blocks (#20)
  - `hooks/post-edit-validate.sh` — resolves typecheck command from config, 2s timeout, macOS-compatible
  - hooks.json updated with PostToolUse section
- **test:** 33 new test assertions (wave-scope edge cases + hook test suite)
- **fix:** macOS `date +%s%3N` compatibility in post-edit-validate.sh (BSD date lacks `%N`)

## [2.0.0-alpha.12] - 2026-04-06 — /evolve + Skill Splits

- **feat:** `/evolve` command + skill — extract, review, and list cross-session learnings (#21)
  - `analyze` mode: extract patterns from session history (5 learning types), present via AskUserQuestion, atomic write
  - `review` mode: interactive management (boost/reduce/delete/extend) of existing learnings
  - `list` mode: read-only display grouped by type with confidence and expiry summary
- **refactor:** extract `verification-checklist.md` from session-end SKILL.md Phase 2 (#18)
- **refactor:** extract `wave-template.md` from session-plan SKILL.md Step 4 (#18)
- **feat:** seed initial `learnings.jsonl` with 4 learnings from 8-session history (effective-sizing, scope-guidance)

## [2.0.0-alpha.11] - 2026-04-06 — Deterministic Scripts

- **feat:** `scripts/parse-config.sh` — deterministic Session Config parser with type validation, 36 fields, defaults from reference doc (#19)
- **feat:** `scripts/run-quality-gate.sh` — 4 quality gate variants (baseline, incremental, full-gate, per-file) with structured JSON output (#19)
- **feat:** `scripts/validate-wave-scope.sh` — wave-scope.json validator with security checks (path traversal, absolute paths) (#19)
- **feat:** `scripts/lib/common.sh` — shared library (find_project_root, require_jq, die, warn, resolve_plugin_root)
- **feat:** 94 bash tests across 3 test suites with 8 fixtures
- **refactor:** skills updated to reference scripts (session-start, discovery, plan, wave-executor, session-end, quality-gates)

## [2.0.0-alpha.10] - 2026-04-05

### v2.0.0-alpha.10

**Quality & Architecture**

- fix: remove hardcoded archetype/style/group mappings in plan mode-new — now discovered dynamically from `$BASELINE_PATH` (#11)
- feat: shared Session Config reference at `docs/session-config-reference.md` — single source of truth for all 36 fields (#12)
- refactor: deduplicate Phase 0 config lists across session-start, discovery, and plan skills (#12)
- refactor: extract session-start Phase 7 presentation template to `presentation-format.md` (#18)
- refactor: session-start SKILL.md reduced from 290 to 210 lines (28% reduction) (#18)

## [2.0.0-alpha.9] - 2026-04-05 — Cross-Repo Learnings + Competitive Analysis

- **feat:** cross-repo learnings — anti-pattern detection, skill metadata extraction, confidence-based filtering
- **feat:** skill frontmatter extended with `tags` and `model-preference` fields
- **fix:** discovery probe consistency fixes (false positive reduction, deduplication logic)
- **analysis:** competitive analysis of everything-claude-code, projects-baseline, claude-code-skills repos

## [2.0.0-alpha.8] - 2026-04-04

### Fixed
- **enforce-scope.sh**: default enforcement changed from `warn` (fail-open) to `strict` (fail-closed) when `enforcement` field missing from `wave-scope.json`
- **enforce-commands.sh**: same fail-closed default applied
- **enforce-scope.sh**: incomplete regex metacharacter escaping — `+`, `?`, `|`, `[`, `]`, `(`, `)` now escaped before glob→regex conversion
- **enforce-scope.sh**: symlink bypass — `realpath` canonicalization added for both PROJECT_ROOT and FILE_PATH (directory-level resolution for new files)
- **enforce-commands.sh**: hardcoded fallback safety blocklist (`rm -rf`, `git push --force`, `git reset --hard`, `DROP TABLE`, `git checkout -- .`) enforced when `blockedCommands` absent from `wave-scope.json`
- **Both hooks**: `CLAUDE_PROJECT_DIR` environment variable now validated — must contain `.claude/` directory to be trusted
- **wave-executor**: jq prerequisite check added to Pre-Execution phase (step 4) — warns user if jq missing before wave dispatch

### Changed
- Plugin version alpha.7 → alpha.8
- SECURITY.md expanded with Enforcement Architecture, Prerequisites, Known Limitations, Credential Safety sections
- README.md: jq listed as prerequisite for enforcement hooks
- USER-GUIDE.md: credential safety warning added to Session Config section

## [2.0.0-alpha.7] - 2026-04-04

### Added
- **`/plan` skill** — structured project planning & PRD generation (#27)
- `/plan new` — project kickoff with 3-wave requirement gathering, full PRD, and repo setup
- `/plan feature` — compact feature PRD with 1-2 wave discovery
- `/plan retro` — data-driven retrospective from session metrics
- 3 PRD templates: full (8 sections), feature (5 sections), retro (metrics + actions)
- PRD reviewer prompt with 6-criteria quality review and max 3 iteration protocol
- Product Strategist soul identity (`skills/plan/soul.md`)
- 4 new Session Config fields: `plan-baseline-path`, `plan-default-visibility`, `plan-prd-location`, `plan-retro-location`

### Changed
- Plugin version alpha.6 → alpha.7
- SessionStart hook message updated to include `/plan [new|feature|retro]`
- Component counts updated: 8→9 skills, 4→5 commands

## [2.0.0-alpha.6] - 2026-04-04

### Fixed
- **Worktree enforcement bypass** — `find_project_root()` fallback added to both hook scripts (#21 prep)
- **Quality wave scope conflict** — two-phase scope enforcement: simplification agents get production file scope, then test/review agents get test-only scope (#21 prep)
- **Undefined `<session-start-ref>`** — `SESSION_START_REF` captured at session start, used in 3 locations (#21 prep)
- **PARTIAL/SPIRAL/FAILED detection** — STATUS reporting protocol with coordinator detection rules and definitions table (#21 prep)
- **Discovery embedded mode return contract** — JSON schema for findings + stats between discovery and session-end (#21 prep)
- **Learnings I/O** — in-memory tracking in Phase 3.5a, atomic rewrite in Phase 3.6, explicit conditions (#21 prep)
- 8 medium/low consistency fixes: subject matching, cross-module scope definition, sort order, gate headers, field naming, enforcement docs (M1-M6, L1-L2)

### Changed
- Version bumped alpha.5 → alpha.6 across 5 files
- Validation checklist expanded from 11 to 17 scenarios

## [2.0.0-alpha.5] - 2026-04-03

### Added
- **Confidence-based scoring for discovery probes** (#22) — 0-100 confidence score per finding based on pattern specificity, file context, and historical signal. Auto-defers low-confidence findings below configurable threshold (`discovery-confidence-threshold`, default: 60). Critical findings never auto-deferred.
- **Post-implementation simplification pass** (#23) — Quality wave now dispatches simplification agents before test writers, applying `slop-patterns.md` patterns to clean AI-generated code (unnecessary try-catch, over-documentation, redundant boolean logic, re-implemented stdlib functions).
- **Session-reviewer specialized review sections** (#24) — 3 new review sections: Silent Failure Analysis (catch blocks that swallow errors), Test Depth Check (assertion quality, mock boundaries), Type Design Spot-Check (overly broad types, missing unions). Per-finding confidence scoring (>=80 threshold).
- **CLAUDE.md quality audit probe** (#25) — New `claude-md-audit` probe in session category: validates Session Config paths, checks rules freshness against codebase, detects stale CLAUDE.md, cross-references technology mentions against package.json.
- **Session effectiveness tracking** (#26) — Extended `sessions.jsonl` schema with `discovery_stats`, `review_stats`, and `effectiveness` fields. Session-start surfaces completion rate trends, low-value probe detection, and carryover pattern analysis after 5+ sessions.
- Confidence Scoring Reference section in `probes.md` with per-category guidance
- Discovery Phase 6 (Capture Discovery Stats) for standalone mode

## [2.0.0-alpha.4] - 2026-04-03

### Fixed
- **enforce-scope.sh**: glob matching now supports `**` recursive patterns via regex conversion (was limited to single-level globs)
- **enforce-commands.sh**: word-boundary matching prevents false positives (e.g., `rm -rflag` no longer blocked by `rm -rf` pattern)
- **session_id uniqueness**: format changed from `<branch>-<YYYY-MM-DD>` to `<branch>-<YYYY-MM-DD>-<HHmm>` to prevent same-day collisions
- **Spiral detection scope**: clarified as per-agent (not per-wave) — two agents editing the same file is expected, not a spiral
- **Complexity tier boundaries**: rebalanced to Simple (0-1), Moderate (2-3), Complex (4-6) for better distribution
- **Dynamic scaling threshold**: "fast" defined as under 3 minutes wall-clock (was undefined)
- **Worktree merge strategy**: defined sequential merge protocol with conflict resolution heuristics
- **Directory creation**: explicit `mkdir -p` commands instead of prose instructions for STATE.md and metrics
- **JSONL write safety**: documented POSIX-atomic `>>` append, warned against read-modify-write
- **USER-GUIDE spiral wording**: corrected "per wave" to "per agent" to match authoritative circuit-breaker.md

### Added
- `deviation-pattern` learning type — session-end now reads STATE.md deviations for cross-session pattern extraction
- Discovery role enforcement: `allowedPaths: []` + read-only prompt instruction
- Quality role scope restriction: `allowedPaths` limited to test file patterns (`**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`)
- Role combination verification example (Discovery+Impl-Core → Incremental checks)
- 6+ wave splitting criteria (by module/dependency boundary)
- jq prerequisite documentation in USER-GUIDE.md with install commands
- Integration test reference config (`docs/examples/integration-test-config.md`) covering all 30 Session Config fields
- Validation checklist (`docs/validation-checklist.md`) mapping to #21's 11 test plan items

### Changed
- Hook jq-missing warnings now explicitly state that enforcement is fully disabled
- `enforce-scope.sh` matching has 4 branches: directory prefix → recursive glob → simple glob → exact match

## [2.0.0-alpha.3] - 2026-04-03

### Added
- Session metrics tracking — wall-clock time, agent counts, files changed per wave (#8)
- Historical trend display in session-start showing last 5 sessions
- Adaptive wave sizing with complexity scoring (simple/moderate/complex tiers) (#19)
- Dynamic agent scaling between waves based on performance signals
- Cross-session learning system with confidence scoring (#20)
- Project Intelligence sections in session-start and session-plan from accumulated learnings
- Structured quality-gates output format (JSON) for metrics integration

### Changed
- Circuit breaker and worktree isolation extracted to `circuit-breaker.md` sub-reference
- session-plan steps renumbered (new Step 3: Complexity Assessment)
- session-end Final Report expanded with per-wave metrics breakdown and learnings summary
- Quality gates Variants 2 and 3 have structured JSON output specifications

## [2.0.0-alpha.2] - 2026-04-03

### Added
- Hybrid session persistence via STATE.md lifecycle (init/update/clear) + session memory files (#16)
- PreToolUse hook enforcement: enforce-scope.sh (Edit/Write), enforce-commands.sh (Bash) (#17)
- Circuit breaker with maxTurns limit and spiral detection (#18)
- Worktree isolation for parallel agent execution (#18)
- 5 new Session Config fields: persistence, memory-cleanup-threshold, enforcement, isolation, max-turns
- SESSION-START Phase 0.5 (Session Continuity) and Phase 5.5 (Memory Recall)

### Changed
- USER-GUIDE.md: 2 new sections (Session Persistence, Safety Features) + config fields + cheat sheet
- wave-executor: STATE.md initialization, post-wave updates, scope manifest, circuit breaker

## [2.0.0-alpha] - 2026-04-02

### Added
- quality-gates reference skill — canonical commands for typecheck, test, lint with 4 variants (Baseline, Incremental, Full Gate, Per-File)
- 9 new Session Config fields: test-command, typecheck-command, lint-command, ssot-freshness-days, plugin-freshness-days, recent-commits, issue-limit, stale-branch-days, stale-issue-days
- Role-to-wave mapping table — waves dynamically map to 5 roles (Discovery, Impl-Core, Impl-Polish, Quality, Finalization) based on configured wave count (3-6+)
- discovery skill with /discovery command — systematic quality audit with 22 probes across 5 categories (code, infra, ui, arch, session)
- 4 new Session Config fields for discovery: discovery-on-close, discovery-probes, discovery-exclude-paths, discovery-severity-threshold

### Changed
- gitlab-ops is now the single source of truth for all VCS operations — consuming skills reference it instead of duplicating commands (#11)
- Quality checks across all skills now reference quality-gates instead of hardcoding commands (#12)
- Session Config documentation consolidated — USER-GUIDE.md Section 4 is the authoritative field reference (#13)
- All hardcoded thresholds (SSOT freshness, plugin age, stale branches, etc.) are now configurable via Session Config (#14)
- Wave execution model rewritten from hardcoded wave numbers to role-based assignment (#15)
- Pencil design review triggers now reference Impl-Core and Impl-Polish roles instead of Wave 2/3
- Label taxonomy in CONTRIBUTING.md and USER-GUIDE.md now points to gitlab-ops as SSOT

### Removed
- ~80 lines of duplicated VCS detection/command logic across 4 skills
- ~30 lines of duplicated quality check commands across 4 skills
- ~60 lines of duplicated Session Config documentation across 3 files
- All hardcoded "Wave 1/2/3/4/5" references in favor of role names

## [1.0.0] - 2026-04-02

### Added
- 6 skills: session-start, session-plan, wave-executor, session-end, ecosystem-health, gitlab-ops
- 3 commands: /session, /go, /close
- 1 agent: session-reviewer (inter-wave quality gate)
- SessionStart hook with startup notification
- Soul personality system (soul.md)
- VCS auto-detection with dual GitLab + GitHub support
- 5-wave execution pattern with configurable agent counts
- Inter-wave Pencil design-code alignment reviews
- Ecosystem health monitoring (service endpoints + cross-repo scanning)
- Session Config system with 13 configurable fields
- User Guide, CONTRIBUTING guide, and example Session Configs
