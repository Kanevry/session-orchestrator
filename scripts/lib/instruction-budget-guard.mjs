/**
 * instruction-budget-guard.mjs — #687 / #877 (FA2)
 *
 * Lightweight directive-budget guard for always-on `.claude/rules/*.md`.
 *
 * Sums the always-on directive count across the rule files that Claude Code
 * loads always-on: every rule WITHOUT a `paths:` frontmatter key (#1638).
 * Claude Code reads `paths:` only and ignores `globs:` without an error, so a
 * `globs:`-only rule is always-on there and counts here, even though the
 * rule-loader's own wave injection scopes it. Measured through
 * `loadApplicableRules({ scopeKey: 'paths' })`. It warns when the total
 * exceeds a ceiling. "Mechanism over discipline" — the #668 instruction-
 * budget audit recommends this as a silent-now growth ratchet that only
 * fires when NEW always-on directives are added.
 *
 * #877 FA2 extends this additively with a BYTE dimension (`totalBytes` /
 * `perFile[].bytes`) and a per-tier surface split (`bySurface`). The
 * original directive-line heuristic only inspects bullet/digit/`##` lines —
 * the majority of an always-on rule file's payload (prose paragraphs, code
 * fences) never contributes to `totalDirectives`, so that count alone
 * understates the real instruction-budget cost. `bySurface` further splits
 * the always-on corpus by `entry.tier` (issue #692) so a coordinator-only
 * file (never reaches a wave agent) does not silently inflate what a wave
 * agent's own budget looks like.
 *
 * #893 correction: `bySurface.coordinator` mirrors
 * `loadApplicableRules({context:'coordinator'})` exactly — the REAL
 * coordinator delivery path (`print-applicable-rules.mjs --context
 * coordinator`) — which EXCLUDES `tier: wave-only` content, not "the entire
 * always-on corpus regardless of tier" as a pre-#893 doc revision claimed.
 * `always` is a strict subset of both `wave` and `coordinator` (neither tier
 * gate touches `tier: 'always'`), but `wave` and `coordinator` are each other's
 * SIBLING projections, not nested — one excludes `coordinator-only`, the other
 * excludes `wave-only`, so neither is guaranteed to be `⊆` the other. Do NOT
 * assume `wave ⊆ coordinator` (that only held under the pre-#893 bug where
 * `context: 'coordinator'` silently meant "untiered"). The additive
 * `coordinator + wave === totalBytes` identity is separately never
 * guaranteed either — it double-counts the `always` tier that sits in both
 * surfaces; see #877 issue discussion.
 *
 * Plain-JS — no Zod dependency. Never throws.
 *   - `computeInstructionBudget` always returns the full shape (never null).
 *   - `checkInstructionBudget` returns a banner object or null (session-start
 *     Phase 4 convention, mirroring checkQgCommandDrift / checkCiStatus).
 *
 * Always-on membership AND tier-surface gating are both delegated to
 * `loadApplicableRules` from `./rule-loader.mjs` (single SSOT) — we do NOT
 * hard-code the file list, and we do NOT hand-roll a second copy of the
 * tier-gate conditionals `applyGates` already implements (the `context`
 * param below is the exact mechanism rule-loader exposes for this).
 *
 * #1449: that membership now matches what Claude Code actually loads. The
 * loader used to skip a leading provenance comment before `---`, so a rule
 * Claude Code loads always-on (it reads frontmatter only from line 1) counted
 * here as path-scoped, and every consumer's always-on total was short by the
 * vendored rules carrying that header. Such a file now counts as always-on —
 * its displaced frontmatter as body bytes, since that is how Claude Code
 * delivers it — and is listed in `defects` and on its own banner line. The
 * list is report-only: it is not an `overBudget` term, so a defect never turns
 * a budget verdict red.
 *
 * Cross-references:
 * - "2026-06-20 instruction-budget audit" (#668 / #687; archived in the private Meta-Vault)
 * - scripts/lib/rule-loader.mjs (always-on classification + tier-gate SSOT)
 * - scripts/lib/qg-command-drift-banner.mjs (banner-shape convention)
 * - scripts/lib/ci-status-banner.mjs (never-throws convention)
 * - issue #877 (FA2 — byte dimension + surface split)
 * - SISTER GUARD / KNOWN DIVERGENCE (#906.3): the projects-baseline repo
 *   (resolved via `plan-baseline-path` / owner.yaml `baseline-path`) ships
 *   `scripts/check-instruction-budget.sh` under rule CCU-009c. It measures the
 *   SAME `.claude/rules/*.md` corpus and its total is NOT comparable to ours.
 *   As of 2026-07-30 it diverged on BOTH axes, in OPPOSITE directions:
 *     (a) MEMBERSHIP — it classifies a file as path-scoped only on a `paths:`
 *         frontmatter key, so this repo's then `globs:`-scoped rules stayed
 *         inside ITS always-on set: 26 files where we counted 12. That was
 *         Claude Code's semantics and ours was wrong; since #1638 this guard
 *         also scopes on `paths:` only, so the membership axis is aligned.
 *     (b) HEURISTIC — it counts only rule-ID anchors and imperative-keyword
 *         BULLET lines outside code fences, where `countDirectives` below
 *         counts every bullet, ordered-list item and `##`-or-deeper heading.
 *   The narrower heuristic outweighs the wider file set, so its total runs
 *   LOWER than ours: measured 2026-07-30 against this repo's corpus, 263 (its
 *   heuristic) vs 471 (ours) ≈ 1.79x; its own header reports a ~2-3x spread on
 *   the baseline repo's corpus, so the factor is corpus-dependent, not a
 *   constant. Never diff or reconcile the two totals — each is only meaningful
 *   against its OWN ceiling, and on that same corpus the two already disagree
 *   on the verdict (263 > its max of 200 → over budget; 471 <= our 480 → ok).
 *   Their ceilings are not the same kind of number either: its 200 is an
 *   unvalidated placeholder it explicitly retracts in its own header, ours is a
 *   self-relative growth ratchet calibrated just above our own baseline.
 *
 * CONSUMER REPOS (#1995). Because every DEFAULT_* ceiling below is this repo's
 * self-relative ratchet, it says nothing about a consumer's corpus: measured
 * 2026-11-09 over 32 consumer repos, the breach line fired in 15 (47 %). A
 * consumer axis is therefore judged as "over" only once the repo has set its own
 * key; until then `checkInstructionBudget` reports it as NOT CALIBRATED and
 * points at `scripts/instruction-budget-calibrate.mjs`, which prints a block
 * measured on that repo. `computeInstructionBudget` is unchanged — its flags
 * still compare against whatever ceiling it is given.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventsFilePath, scanEventsBackwards } from './events.mjs';
import {
  FRONTMATTER_NOT_AT_TOP,
  loadApplicableRules,
  isRuleExpired,
  parseGlobsFrontmatter,
  ruleExpiryInstantMs,
} from './rule-loader.mjs';

/*
 * RE-CALIBRATED 2026-11-10 (#2000) — THIS REPO's `instruction-budget:` block,
 * not the module defaults. The four DEFAULT_* constants below are UNCHANGED:
 * `computeInstructionBudget()` binds them (it reads no Session Config), and
 * `tests/rules/receiving-review.test.mjs` pins the live repo against them.
 *
 * Why: the always-on corpus halved in one commit (`9c388d9c`, 2026-10-12:
 * 470 → 242 directives, 120,927 → 64,913 B), so the ceilings calibrated on the
 * old corpus sat at 50 % / 54 % / 66 % / 84 % share and fired on no growth.
 *
 * Method (#1308 replay, widened): `git log --format=%h -- .claude/rules/`
 * → 132 states, `45116136` (2026-04-19) .. `9eaf9e34` (2026-11-07), measured
 * 2026-11-10T07:05Z with the base tree `418773a7`. Each state materialised via
 * `git archive <sha> .claude/rules | tar -x`, fed to `computeInstructionBudget
 * ({ rulesDir })`, with the clock set to the commit time so rule expiry is
 * judged as it was then. Two rates per candidate: STATE firing (states over
 * the ceiling) and STEP firing (single commits whose growth alone exceeds the
 * headroom the ceiling leaves over today's value).
 *
 * Peaks: directives 1,317 @ `a9040080`; always-on 218,115 B @ `a9040080`;
 * generated 99,774 B @ `2ae08fe0`; path-scoped 147,407 B @ `2ae08fe0`.
 * Today (`418773a7`): 241 / 65,000 / 62,515 / 104,685.
 *
 *   ceiling 273 (was 480): state 107/132 (all pre-diet states; 0/19 since
 *     `9c388d9c`), step 7/131 = 5.3 % (480: step 1/131). Measured + one
 *     medium rule (32 directives, the calibrate floor).
 *   byte-ceiling 72,000 (was 121,000): state 0/19 since `9c388d9c` (106/132
 *     overall, every one pre-diet), step 8/131 = 6.1 % (121,000: 1/131).
 *     Headroom 7,000 B ≥ one medium always-on rule (6,113 B). State firing
 *     over all 132 is the wrong denominator here: it counts a corpus that no
 *     longer exists, so the step rate is the falsification record.
 *   generated-byte-ceiling 81,000 (was 95,000): state 9/132 = 6.8 %, step
 *     3/131 = 2.3 % (the three 10-learning standalone-file /reconcile runs,
 *     `f0766e1e` +18,926, `8dbc81b3` +21,609, `2cb8708b` +19,987); 0/41 steps
 *     since the #1367 thematic writer (`dd05e0f8`), whose largest step is
 *     +4,574 B (`c6b7331c`) — covered 4x by the 18,485 B headroom. Chosen at
 *     or under the path-scoped headroom (19,315 B) on purpose: every generated
 *     byte is also a path-scoped byte, so a looser generated ceiling (85,000,
 *     the "largest step ever" value) would never fire before the path-scoped
 *     one — decorative by construction. Fires on the regime peak 81,147 B.
 *   path-scoped-byte-ceiling 124,000 — KEPT: state 5/132 = 3.8 %, step 4/131.
 *     The calibrate suggestion 117,000 would put the 90 % near-threshold at
 *     105,300 B, 615 B over today — the first /reconcile step of the
 *     thematic regime's typical size would raise the near banner. 124,000
 *     leaves 6,915 B to the near line and 19,315 B to the ceiling. Covering
 *     the largest generated step (+21,609 B) would need 127,000, a raise.
 *
 * 24 rule-eligible learnings are queued: no falsifiable ceiling covers all of
 * them at once (~1.5 KB each per #1419). The /reconcile writer's budget
 * pre-flight (`reconcile/writer.mjs`, reads this block) refuses a batch
 * that would cross a ceiling, so the gate cannot turn red from a reconcile;
 * the batch is capped instead — the intended cue to consolidate.
 *
 * BV-004 revisit trigger: re-run the replay after the next /reconcile here,
 * or when an always-on axis has used half its headroom (directives > 257,
 * always-on > 68,500 B). An "> 80 % of ceiling" trigger cannot work on these
 * values: at calibration the axes already stand at 88.3 % (241/273) and
 * 90.3 % (65,000/72,000), because measured + one rule is the whole method.
 */

/** Default directive ceiling (operator-chosen growth ratchet just above the ~457 baseline). */
export const DEFAULT_CEILING = 480;

/**
 * Default BYTE ceiling (#931a) — the second axis of the same growth ratchet.
 *
 * Derived from measurement, not from a feeling. Measured 2026-07-30 against
 * this repo's own always-on corpus:
 *
 *   node -e "import('./scripts/lib/instruction-budget-guard.mjs').then(m =>
 *     console.log(m.computeInstructionBudget({repoRoot: process.cwd()}).totalBytes))"
 *   → 108589    (12 always-on rules, untiered surface)
 *
 * 108589 x 1.05 = 114018 → rounded DOWN to 114000. The +5% headroom is not
 * arbitrary either: it is the SAME relative headroom the directive ceiling
 * already carries (480 over its ~457 baseline = +5.03%), so the two axes are
 * calibrated identically rather than one being tighter than the other by
 * accident. In absolute terms +5% ≈ 5.4 KB ≈ one medium always-on rule file
 * (verification-before-completion.md is 6.1 KB) — i.e. the ratchet fires when
 * a genuinely NEW always-on surface is added, not when an existing rule is
 * edited. A default that reddens the current state would be switched off
 * within one session and measure nothing thereafter.
 *
 * Note the byte axis is materially LOOSER than the directive axis in practice:
 * the live repo sits at 471/480 directives (98.1% of ceiling) but 108589/114000
 * bytes (95.3%). That asymmetry is inherited from the pre-existing directive
 * ratchet, not introduced here.
 *
 * RE-BASELINED 2026-08-22: 114000 -> 121000. The ratchet fired for exactly the
 * reason stated above — "a genuinely NEW always-on surface is added". Since the
 * 2026-07-30 calibration this repo's corpus grew 108589 -> 115730 B, and the
 * largest single cause is a rule file the operator adopted:
 * .claude/rules/host-resources.md (7457 B, #1089, live 2026-08-21). Headroom
 * unchanged at +5%: 115730 x 1.05 = 121516, rounded DOWN to 121000. Same
 * relative slack, measured against the corpus that actually exists.
 *
 * Consumer impact was CHECKED, not assumed. This module ships inside the npm
 * package, so the first instinct was to keep the shared default fixed and set a
 * repo-local `instruction-budget.byte-ceiling` override instead. Two
 * measurements killed that plan: (a) the package ships THREE always-on rules
 * totalling 9261 B — both ceilings sit ~12x above any consumer's inherited
 * corpus, so the delta is numerically inert downstream; and (b) the number was
 * never a shipped-corpus figure in the first place — the calibration above says
 * "measured against this repo's own always-on corpus". A repo-local override
 * also could not have worked: tests/rules/receiving-review.test.mjs calls
 * computeInstructionBudget({repoRoot}), which does not read Session Config, so
 * it pins this constant by construction.
 *
 * Not a licence to raise the number whenever it is hit — a ratchet that yields
 * on contact measures nothing, and the NEXT breach belongs to a diet. 4499 B of
 * the always-on security.md still describes surfaces this repo does not have
 * (SSRF via an http-client package, an OWASP table, RLS, bcrypt/JWT), vendored
 * from the baseline and never adapted — the same class as the Semgrep claim
 * fixed today. That cut is real and nameable and is tracked in #1126; it was
 * deliberately NOT taken in the same pass that raised the ceiling, because
 * deleting security prose to hit a number is the failure build-value.md BV-002
 * names.
 */
export const DEFAULT_BYTE_CEILING = 121000;

/**
 * Default byte ceiling for the PATH-SCOPED rule surface — the third axis, and
 * the one that closes this guard's largest blind spot.
 *
 * Both ceilings above measure ONLY always-on rules (`loadApplicableRules`
 * with `scopePaths: []` returns nothing else), so every `globs:`-scoped rule
 * file was invisible to this guard by construction. That blind spot was
 * MEASURED, not hypothesised: on 2026-09-06 @ `e4674109` the reconciliation
 * engine had accumulated **43 generated rule files / 112,443 B** in
 * `.claude/rules/` — 46.2 % of it pure frontmatter+provenance overhead — while
 * this guard reported a comfortable 470/480 directives over 15 files and could
 * not have fired on that growth at any ceiling, because it never counted it.
 * A wave agent paid those bytes twice (rule-injection block + native delivery,
 * see `docs/instruction-delivery.md` §5).
 *
 * Derivation (HR-105 — a threshold whose firing rate nothing records is not a
 * rule): measured 2026-09-06 after the 43→8 consolidation AND the
 * harness-parity repair that followed it, the path-scoped surface is
 * **96,757 B over 11 files** (8 consolidated + the 3 hand-written scoped rules
 * `testing.md` / `cli-design.md` / `bash-harness-pitfalls.md`), counted the
 * same way as `totalBytes` — frontmatter stripped, via
 * {@link countContentBytes}. RE-MEASURED 2026-09-06 later the same day
 * (`computeInstructionBudget({repoRoot}).bySurface.generated` @ `bc49301b` →
 * `{ bytes: 109593, files: 11 }`): the live figure is **109,593 B over the same
 * 11 files**, ×1.13 under the unchanged 124,000 ceiling — restored prose, not
 * reconciliation growth (the consolidation pass had dropped 10 learnings'
 * bodies, which were written back into the same 8 files).
 *
 * CORRECTED 2026-09-06, one wave after the line above was first written. Two
 * things in that first derivation no longer hold:
 *
 *  - The base was **95,277 B**, measured while the 8 consolidated files still
 *    carried `globs:` with no `paths:`. Adding `paths:` + `learning-key:` did
 *    NOT move this number by a single byte — {@link countContentBytes} strips
 *    frontmatter — so the +1,480 B is entirely the 8 × 185 B provenance note
 *    the repair added to the BODIES. Written down because the number moved and
 *    the cause was hand-editing, NOT the reconciliation growth this axis
 *    exists to catch.
 *  - "The ~30 % headroom is deliberately the SAME relative slack the byte
 *    ceiling above carries" was simply false. {@link DEFAULT_BYTE_CEILING}
 *    carries +5 % (121,000 / 115,730 = 1.046), not +30 %. The axes are NOT
 *    calibrated alike, and saying they were hid a 6× difference in tolerance.
 *
 * The ceiling STAYS at 124,000 rather than re-deriving upward to
 * 96,757 × 1.30 ≈ 126,000. The guard has never fired at this base, and raising
 * an unfired ceiling to preserve a round multiplier is the threshold-patch
 * `.claude/rules/development.md` § Guard & Threshold Design forbids. 124,000 is
 * now ×1.28 over the live corpus — tighter than before, not looser.
 * Re-derive it (never merely raise it) with:
 *
 *   `node -e "…parseGlobsFrontmatter over .claude/rules/*.md…"` — or simply
 *   read `computeInstructionBudget().bySurface.generated` and re-apply ×1.30.
 *
 * What makes this ceiling reachable rather than decorative (HR-105 again — a
 * threshold nobody can falsify is not a rule): the SAME measurement replayed
 * against `git show HEAD:.claude/rules/*` at `e4674109`, i.e. the tree one
 * commit before the consolidation, returns **137,410 B over 46 path-scoped
 * files** — over this ceiling, so the guard WOULD have fired there and is
 * silent at 96,757 B / 11 files now. Firing rate on the two states that exist:
 * 1 of 2. That is the intended condition — reconciliation growth, not the
 * hand-written corpus, which contributes 3 of the 11 files.
 *
 * (Note 137,410 is not the 112,443 B the audit quotes for the 43 generated
 * files: that figure is raw bytes INCLUDING frontmatter and EXCLUDING the 3
 * hand-written scoped rules; this axis strips frontmatter and counts all 46.
 * Two different populations — see `.claude/rules/measurement-discipline.md`
 * § "the unnamed population".)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POPULATION CORRECTED 2026-09-11 (#1297). Everything above this line measured
 * the PATH-SCOPED corpus and called it `generated`. It is not the same set, and
 * the difference was not marginal: measured at `c73c094f`,
 *
 *   path-scoped:  11 files / 123,747 B   (what this axis used to judge)
 *   generated:     8 files /  76,114 B   (what it always claimed to judge)
 *
 * — a 47,633 B gap carried by exactly three HAND-WRITTEN rules that happen to
 * be `globs:`-scoped (`testing.md` 36,252 B, `bash-harness-pitfalls.md` 7,705 B,
 * `cli-design.md` 3,676 B). `testing.md` alone was 29.3 % of a ceiling meant for
 * machine output. Consequence at `c73c094f`: 253 B of headroom, so the next
 * /reconcile run that materialized a single rule would have turned
 * `tests/rules/receiving-review.test.mjs` red — and no diet of the generated
 * corpus could have fixed it, because the dominant file is not generated.
 * Textbook `.claude/rules/measurement-discipline.md` § "the unnamed population":
 * the measurement was right, the set was wrong.
 *
 * Membership is now decided by the reconciliation PROVENANCE marker
 * ({@link isMachineGeneratedRule}), mirroring `reconcile/writer.mjs` Tier 3.
 * The old number survives as `bySurface.pathScoped` — a real quantity, just not
 * this one — so nothing that wants it has to re-derive it.
 *
 * The ceiling itself is DELIBERATELY LEFT AT 124,000 in this change. Correcting
 * a population and re-calibrating a threshold are two decisions, and only the
 * first one is measured here. What the correction does expose, and what the
 * operator should decide separately, is that 124,000 is now decorative on this
 * axis (HR-105 — a rule you cannot falsify is not a rule):
 *
 *   commit `c73c094f`:                            76,114 B / 8 files  → x1.63
 *   live corpus (2026-09-11, working tree):       87,336 B / 8 files  → x1.42
 *   pre-consolidation peak (`e4674109`, replayed
 *     with the corrected predicate):              89,763 B / 43 files → x1.38
 *
 * NUMBERS RE-MEASURED 2026-09-11 (same day, one wave later). The first line
 * above previously read `live corpus (2026-09-11, c73c094f): … x1.63` — the
 * date and the SHA contradicted each other, and the SHA lost: the SAME session
 * that corrected the population then absorbed 10 learnings into
 * `.claude/rules/`, adding +11,222 B to the generated corpus (87,336 − 76,114).
 * x1.63 was already stale when it was written down. Commands, all run at
 * 2026-09-11 against the working tree / the named SHAs:
 *
 *   `node -e "computeInstructionBudget({repoRoot}).bySurface.generated"`
 *      → working tree: { bytes: 87336, files: 8 }
 *      → rulesDir extracted from `c73c094f`: { bytes: 76114, files: 8 }
 *      → rulesDir extracted from `e4674109`: { bytes: 89763, files: 43 }
 *
 * HISTORY as of 2026-09-16 — every number in this paragraph described the
 * 124,000 ceiling, which no longer exists on this axis. It read, correctly for
 * 2026-09-11: firing rate 0 of 3, not 0 of 2; the generated corpus then sat
 * **2,427 B** below the peak known at that time (87,336 of 89,763 B), not
 * 13,649 B, so one /reconcile wave of the size that session absorbed would have
 * restored its worst recorded state with the ceiling still silent. Superseded
 * on BOTH terms by the RE-CALIBRATED block below (ceiling 95,000, true peak
 * 99,774 B, live distance to the peak 29,833 B measured 2026-09-16). Kept
 * because it records the rule that produced the eventual fix: raising OR
 * lowering a threshold inside a population fix is exactly the conflation this
 * comment exists to end.
 *
 * FIRING-RATE AUDIT — widened from 3 states to 89 (#1308, 2026-09-11T17:26Z,
 * clean tree @ `4a49adc6`). HR-105 forbids a rule nothing records; "0 of 3"
 * was too small a base to tell "genuinely rare" from "silently broken", so the
 * guard was replayed over EVERY commit that touched `.claude/rules/`:
 * `git log --format=%h -- .claude/rules/` → 89 commits, each extracted with
 * `git archive <sha> .claude/rules | tar -x -C <tmp>` and fed to
 * `computeInstructionBudget({rulesDir})`. Firing rates only — the headroom
 * annotations this table used to carry are deliberately gone, because an
 * absolute headroom rots between two edits of the corpus; read the live one
 * from the axis itself (command in the RE-MEASURED block below):
 *
 *   directive axis  (480)      → fires  4/89 =  4.5 %   rare, healthy
 *   byte axis       (121,000)  → fires  0/89 =  0.0 %
 *   generated axis  (124,000)  → fires  0/91 =  0.0 %   → superseded, see below
 *   pathScoped axis (124,000)  → fires  5/91 =  5.5 %   → calibrated
 *
 * RE-CALIBRATED 2026-09-16 (#1308). The replay was re-run over the FULL
 * recorded history of this directory, not the 89-state subset:
 *
 *   `git log --format=%h -- ./.claude/rules/` → 91 states; each materialized
 *   with `git archive <sha> .claude/rules | tar -x -C <tmp>` and fed to
 *   `computeInstructionBudget({ rulesDir })`.
 *
 * True peak of the generated axis: **99,774 B @ `2ae08fe0`** — which CORRECTS
 * the "peak ever 89,763 B" this docblock carried until now (that number came
 * from a single replayed commit, not from the population). Median state:
 * 4,802 B. Firing table over the same 91 states:
 *
 *   124,000            → 0/91 = 0.0 %   (the standing, unfalsifiable value)
 *   102,268 (peak+2.5%)→ 0/91 = 0.0 %   (a ceiling above the peak never fires)
 *    95,000            → 1/91 = 1.1 %   ← chosen
 *    88,000            → 3/91 = 3.3 %
 *    80,000            → 5/91 = 5.5 %
 *
 * Why 95,000: it FIRES on recorded history (HR-105 — a rule you cannot falsify
 * is not a rule), at 1.1 % it sits in HR-101's rare band (a class above ~10 %
 * is a broken instrument), and it stays silent on the corpus it lands on, so it
 * does not go red before the #1367 consolidation has been committed. "Peak +
 * 2.5 %" is REJECTED here for the reason the old text recommended it: above the
 * peak, the axis is decorative by construction.
 *
 * RE-MEASURED 2026-09-16 @ `ca214376`, after the #1367 consolidation landed in
 * the working tree (the state this ceiling was calibrated for is the state it
 * now judges):
 *
 *   node --input-type=module -e "const m = await import('./scripts/lib/instruction-budget-guard.mjs'); \
 *     console.log(JSON.stringify(m.computeInstructionBudget({ repoRoot: process.cwd() }).bySurface))"
 *   → generated  { bytes: 69941, files: 7 }   ×1.36 under 95,000
 *     pathScoped { bytes: 109932, files: 10 }
 *
 * Read the headroom off that command, never off a sentence in this block: the
 * two numbers a verdict needs are the AXIS and its CEILING, and the distance
 * between them changes with every rule edit. For the record at that SHA the
 * generated axis sat 25,059 B under its ceiling and 29,833 B under the 99,774 B
 * peak — i.e. one /reconcile wave the size of the largest recorded one would
 * still not reach the peak, but a repeat of the growth that produced it would
 * cross 95,000 first. That is the intended, rare signal: a cue to consolidate.
 *
 * BV-004 revisit trigger: re-run the 91-state replay when the generated corpus
 * passes 90,000 B, or on this ceiling's FIRST fire — at which point it is
 * calibrated by a real event rather than by a replay.
 */
export const DEFAULT_GENERATED_BYTE_CEILING = 95000;

/**
 * Default byte ceiling for the PATH-SCOPED rule surface — the fourth axis,
 * and a RESTORATION of coverage rather than a new threshold (#1297 follow-up).
 *
 * Why this exists. The #1297 population fix above moved
 * {@link DEFAULT_GENERATED_BYTE_CEILING} from "every `globs:`-scoped rule" to
 * "every provenance-marked rule" — the right correction, on the right
 * evidence. What it did NOT notice is that the population it moved AWAY from
 * kept its measurement (`bySurface.pathScoped`) and lost its ceiling. Measured
 * 2026-09-11 on the working tree:
 *
 *   `node -e "computeInstructionBudget({repoRoot}).bySurface"`
 *     generated:   87,336 B /  8 files   judged against 124,000 → ok
 *     pathScoped: 134,969 B / 11 files   judged against NOTHING → no verdict
 *
 *   `rg -n "pathScoped" scripts/ tests/ CHANGELOG.md` → 23 hits at that
 *   moment, not one of them a ceiling comparison.
 *
 * 134,969 B is **10,969 B OVER** the 124,000 this exact population was checked
 * against until that commit. Replayed literally — `git show
 * HEAD:scripts/lib/instruction-budget-guard.mjs` (`c73c094f`) run against
 * TODAY's rule corpus, in a tmp dir:
 *
 *   OLD code, today's corpus → generated { bytes: 134969, files: 11 },
 *                              overGeneratedBudget: true, severity: 'warn'
 *   NEW code, today's corpus → overGeneratedBudget: false, severity: 'ok'
 *
 * The diff that swapped the ceiling's predicate is the same diff that would
 * have breached the old ceiling — the learnings this session absorbed put
 * **+11,222 B** on the path-scoped corpus (134,969 today − 123,747 B / 11
 * files measured at `c73c094f`; the same +11,222 B the generated corpus
 * gained, since all of it landed in provenance-marked files). A category
 * split gives each split
 * category its OWN counter AND its own threshold
 * (`.claude/rules/development.md` § Guard & Threshold Design). Here one
 * category got a name and no threshold, which is precisely the state
 * `.claude/rules/host-resources.md` HR-105 forbids: a rule you cannot falsify
 * is not a rule.
 *
 * VALUE: 124,000, unchanged — this is the number this population was always
 * judged against, so restoring it restores coverage and invents nothing.
 * Measured firing rate over the three states of `.claude/rules/` this repo has
 * recorded (`bySurface.pathScoped`, each rulesDir extracted from the named
 * tree, 2026-09-11):
 *
 *   `e4674109` (pre-consolidation):  137,410 B / 46 files → FIRES
 *   `c73c094f` (population fix):     123,747 B / 11 files → silent (253 B left)
 *   working tree (2026-09-11):       134,969 B / 11 files → FIRES
 *
 * Firing rate 2 of 3, falsifiable in both directions — the condition
 * {@link DEFAULT_GENERATED_BYTE_CEILING} did not meet while it stood at
 * 124,000 (0 of 3). Confirmed on a wider base (#1308, 2026-09-11T17:26Z @
 * `4a49adc6`): replayed over all 89 commits that touched `.claude/rules/`, this
 * axis fires 4/89 (4.5 %) — inside HR-101's rare band, and falsifiable.
 * SUPERSEDED as a CONTRAST 2026-09-16: the sibling ceiling was re-calibrated to
 * 95,000 in the same #1308 replay and now fires 1/91 (1.1 %) on recorded
 * history, so "the property the sibling ceiling lacks" is no longer true of it —
 * both axes are falsifiable, and this one is simply the looser of the two.
 * This is also why it is not re-derived upward off the live number: a ceiling
 * placed above 134,969 would be silent on all three states, i.e. the same
 * unfalsifiable shape, obtained by the threshold-patch move
 * `development.md` § Guard & Threshold Design forbids.
 *
 * FOLDED INTO `overBudget` (#1316, 2026-09-12). Until then the flag was
 * computed and reported but did not flip the aggregate verdict, on two stated
 * conditions: the corpus stood over this ceiling (folding it in would have
 * turned the live verdict red and reported a corpus fact as a code defect),
 * and whether the corpus or the ceiling had to move was an operator decision.
 * The operator decided "consolidate, then gate", and fold-in condition 1 — the
 * corpus back under 124,000 — is now met: the 8 generated rule files were
 * consolidated (prose only; every provenance pair, heading and evidence line
 * unchanged), taking the path-scoped corpus from 147,407 B at `c16fb518` to
 * 122,763 B / 11 files on the 2026-09-12 working tree (generated 99,774 →
 * 75,130 B). A breach on this axis alone now sets `overBudget` and raises the
 * session-start banner.
 *
 * Calibration (Discovery replay, 2026-09-12): `bySurface.pathScoped` over
 * every commit touching `.claude/rules/` (`git log --format=%h --
 * ./.claude/rules/` → 90 states): median 84,752 B, peak 147,407 B; 124,000
 * fires on 5/90 = 5.6 %, inside HR-101's rare band. The peak + 2.5 % method
 * the generated axis uses does NOT carry over: this population's peak is HEAD
 * itself, so peak + 2.5 % (151,092 B) fires on 0/90 — an unfalsifiable raise,
 * the threshold-patch move `development.md` § Guard & Threshold Design
 * forbids.
 *
 * Headroom moves with every rule edit, so it is measured, never quoted from
 * here: `computeInstructionBudget({ repoRoot }).bySurface.pathScoped` against
 * this constant. At 2026-09-16 @ `ca214376` that was 109,932 B / 10 files —
 * 14,068 B under the ceiling, after the #1367 consolidation; on 2026-09-12 it
 * was 1,237 B, which is how narrow this axis can get. The next `/reconcile`
 * rule (~2.5 KB written standalone) trips it from a margin like that one
 * unless it is absorbed into a thematic file in the SAME write step — an
 * obligation written in the /reconcile-overshoot
 * learning of `.claude/rules/measurement-discipline.md` and checked by the
 * reconcile writer's budget pre-flight (`scripts/lib/reconcile/writer.mjs`).
 * A breach sets `overBudget` AND turns `tests/rules/receiving-review.test.mjs`
 * (which asserts the live repo is not over budget) red at an otherwise green
 * gate. That is the intended, rare signal — a cue to consolidate, never to
 * raise the ceiling.
 *
 * Revisit trigger (BV-004): re-run the 90-state replay when (a) the
 * hand-written scoped share (`pathScoped − generated`, 47,633 B on the
 * 2026-09-12 tree) moves — consolidating generated rules cannot shrink it, so
 * growth there eats the headroom that lever creates — or (b) the replay's
 * firing rate exceeds 10 % (HR-101: then the instrument is re-aimed, neither
 * obeyed nor silenced).
 *
 * Re-derive (never merely raise) with
 * `computeInstructionBudget({repoRoot}).bySurface.pathScoped`.
 */
export const DEFAULT_PATH_SCOPED_BYTE_CEILING = 124000;

/**
 * Share of {@link DEFAULT_PATH_SCOPED_BYTE_CEILING} at which the banner warns
 * BEFORE the writer refuses (#1419).
 *
 * The defect #1419 records is not the ceiling but its TIMING: it becomes
 * visible only inside `writeApprovedRules`, after the operator has already
 * decided. Measured on that case (2026-09-20, /reconcile run): 117,973 of
 * 124,000 B = 95.1 % — ~6 kB of headroom holding back `capped: 91`
 * candidates, and `overPathScopedBudget` (a HARD `bytes > ceiling` test) did
 * not fire, so nothing warned.
 *
 * 90 % is the distance of ~4 materialised rules: 10 % of 124,000 B = 12,400 B
 * against the ~1.5 kB a generated rule file occupied on the #1419 tree — i.e.
 * roughly four more accepted learnings until the hard break. A fixed fraction,
 * deliberately not a per-repo calibration: it cannot know how large THIS
 * repo's next rule is, and a second calibrated number would need its own
 * falsification record.
 *
 * BV-004 ceiling + revisit trigger (HR-105): measure this line's firing rate
 * after ~20 sessions from the probe records in
 * `.orchestrator/metrics/events.jsonl`
 * (`jq -c 'select(.event=="orchestrator.probes.completed")
 * | .probes[] | select(.id=="instruction-budget")' …` — count `ran-warn`
 * against the record total).
 * Above ~10 % the instrument is RE-AIMED per HR-101 — neither lowered nor
 * silenced; below it, leave it alone.
 */
export const PATH_SCOPED_NEAR_THRESHOLD = 0.9;

/**
 * Read the `instruction-budget:` nested block from the `## Session Config`
 * section of CLAUDE.md (or AGENTS.md) at `repoRoot`. Synchronous + never throws.
 *
 * The block lives inside `## Session Config`, e.g.:
 *
 *   instruction-budget:
 *     enabled: true
 *     ceiling: 480
 *     byte-ceiling: 114000
 *     generated-byte-ceiling: 124000     # optional (#1309)
 *     path-scoped-byte-ceiling: 124000   # optional (#1309)
 *     mode: warn
 *
 * Behaviour:
 *   - Config-load failure (no instruction file / unreadable) → returns the
 *     graceful fallback `{ enabled: true, ceiling: DEFAULT_CEILING,
 *     'byte-ceiling': DEFAULT_BYTE_CEILING, mode: 'warn' }` so the probe still
 *     computes (mirrors the other session-start probes).
 *   - Absent block → same fallback (the feature is on-by-default, growth-ratchet).
 *   - Malformed individual values silently fall back to the per-key default.
 *
 * The `byte-ceiling` key keeps its KEBAB form in the returned object, matching
 * how every other config loader in `scripts/lib/config/` mirrors a multi-word
 * YAML key (`'due-days'`, `'timeout-ms'`, `'confidence-floor'`). The camelCase
 * `byteCeiling` spelling appears only on the `opts`/result surfaces of
 * `computeInstructionBudget`, which are plain JS objects, not config mirrors.
 *
 * `opts.withExplicit` (#1995): when true, the result ALSO carries
 * `explicit: string[]` — the axis keys (`ceiling`, `byte-ceiling`,
 * `generated-byte-ceiling`, `path-scoped-byte-ceiling`) that THIS repo's own
 * block sets to a valid value. An axis listed there is CALIBRATED for the repo;
 * an axis absent from it is judged against a plugin default that was measured
 * on the plugin's own corpus, not on this one. Opt-in so the shape every
 * existing caller reads stays byte-identical; on any fallback path the list is
 * `[]` (nothing was set, so nothing is calibrated). The same opt-in also adds
 * `hostFile` (the file read, see {@link resolveInstructionBudgetHostFile}) and
 * `existingBlock` ({@link findInstructionBudgetBlock} of that file) so the
 * banner can say WHERE the calibrated block goes.
 *
 * @param {string} repoRoot
 * @param {{ withExplicit?: boolean }} [opts]
 * @returns {{ enabled: boolean, ceiling: number, 'byte-ceiling': number, mode: 'warn' | 'off', explicit?: string[], hostFile?: 'CLAUDE.md' | 'AGENTS.md' | null, existingBlock?: { keys: string[] } | null }}
 */
export function loadInstructionBudgetConfig(repoRoot, opts = {}) {
  const withExplicit = opts?.withExplicit === true;
  const defaults = {
    enabled: true,
    ceiling: DEFAULT_CEILING,
    'byte-ceiling': DEFAULT_BYTE_CEILING,
    mode: 'warn',
  };
  const host = resolveInstructionBudgetHostFile(repoRoot);
  const where = (obj) =>
    withExplicit
      ? {
          ...obj,
          hostFile: host ? host.name : null,
          existingBlock: host ? findInstructionBudgetBlock(host.content) : null,
        }
      : obj;
  const fallback = withExplicit ? where({ ...defaults, explicit: [] }) : defaults;
  if (host === null) return fallback;

  try {
    return where(_parseInstructionBudget(host.content, defaults, { withExplicit }));
  } catch {
    return fallback;
  }
}

/**
 * The instruction file the budget loader actually reads: `CLAUDE.md` when it
 * exists and is readable, else `AGENTS.md`, else null (#1995 F4). A
 * `CLAUDE.md` stub therefore shadows a block that lives only in `AGENTS.md` —
 * the calibrate CLI and the banner name THIS file so the operator pastes the
 * block where it is read.
 *
 * @param {string} [repoRoot] - default process.cwd()
 * @returns {{ name: 'CLAUDE.md' | 'AGENTS.md', path: string, content: string } | null}
 */
export function resolveInstructionBudgetHostFile(repoRoot) {
  for (const name of /** @type {const} */ (['CLAUDE.md', 'AGENTS.md'])) {
    const file = join(repoRoot ?? process.cwd(), name);
    try {
      if (existsSync(file)) return { name, path: file, content: readFileSync(file, 'utf8') };
    } catch {
      // unreadable — try the next candidate
    }
  }
  return null;
}

/**
 * Scan `content` for the FIRST `instruction-budget:` key and collect its child
 * lines. Only the first block is ever read, so a second block pasted below an
 * existing one is dead (#1995 F2) — callers use the non-null result to tell the
 * operator to REPLACE the existing block instead of adding another.
 *
 * @param {string} content
 * @returns {{ keyIndent: number, blockLines: string[] } | null} null ⇔ no key line
 */
function scanInstructionBudgetBlock(content) {
  if (typeof content !== 'string' || content === '') return null;
  let inBlock = false;
  let keyIndent = 0;
  const blockLines = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      // The block key normally sits at column 0 inside `## Session Config`,
      // but tolerate a leading indent (e.g. nested under another mapping).
      const m = line.match(/^(\s*)instruction-budget:\s*$/);
      if (m) {
        inBlock = true;
        keyIndent = m[1].length;
      }
      continue;
    }
    // Blank lines stay inside the block (mid-block spacing is tolerated).
    if (line.trim() === '') {
      blockLines.push(line);
      continue;
    }
    // A child line must be indented STRICTLY DEEPER than the block key.
    // Any line at or below the key's indent (incl. column 0) closes the block.
    const indent = line.length - line.replace(/^\s+/, '').length;
    if (indent <= keyIndent) break;
    blockLines.push(line);
  }
  return inBlock ? { keyIndent, blockLines } : null;
}

/**
 * The block the loader reads in `content`, as the key names it sets (in file
 * order, comments stripped, values not interpreted), or null when the file has
 * no `instruction-budget:` key at all.
 *
 * @param {string} content
 * @returns {{ keys: string[] } | null}
 */
export function findInstructionBudgetBlock(content) {
  const scan = scanInstructionBudgetBlock(content);
  if (scan === null) return null;
  const keys = [];
  for (const raw of scan.blockLines) {
    const m = raw.replace(/\s*#.*$/, '').match(/^\s+([a-zA-Z_-]+):/);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return { keys };
}

/**
 * Parse the `instruction-budget:` block out of raw markdown content.
 * Independent helper (testable without disk IO).
 *
 * A `defaults` object that predates the `byte-ceiling` key (#931a) is tolerated:
 * the missing entry falls back to `DEFAULT_BYTE_CEILING` rather than yielding
 * `undefined`, so an older caller can never disable the byte axis by omission.
 *
 * The two SURFACE ceilings (`generated-byte-ceiling`, `path-scoped-byte-ceiling`)
 * are parsed with the same validation as `byte-ceiling` but emitted ONLY when
 * present (in the block or in `defaults`) — see the inline note in the body.
 * Until #1309 they were parsed by nothing at all, so the Session Config
 * override for both surface axes was dead from the day the axes were added:
 * `checkInstructionBudget` read `cfg['generated-byte-ceiling']` /
 * `cfg['path-scoped-byte-ceiling']`, and the only producer of `cfg` never put
 * either key on the object.
 *
 * `opts.withExplicit` (#1995) adds `explicit: string[]` — see
 * {@link loadInstructionBudgetConfig}. A key whose value is malformed or
 * non-positive is NOT explicit: it silently keeps the default, so the axis is
 * still judged by a number this repo never chose.
 *
 * @param {string} content - full file contents
 * @param {{ enabled: boolean, ceiling: number, 'byte-ceiling'?: number, 'generated-byte-ceiling'?: number, 'path-scoped-byte-ceiling'?: number, mode: 'warn' | 'off' }} [defaults]
 * @param {{ withExplicit?: boolean }} [opts]
 * @returns {{ enabled: boolean, ceiling: number, 'byte-ceiling': number, 'generated-byte-ceiling'?: number, 'path-scoped-byte-ceiling'?: number, mode: 'warn' | 'off', explicit?: string[] }}
 */
export function _parseInstructionBudget(content, defaults, opts = {}) {
  const withExplicit = opts?.withExplicit === true;
  /** @type {string[]} */
  const explicit = [];
  const tag = (obj) => (withExplicit ? { ...obj, explicit } : obj);
  const base = defaults ?? {
    enabled: true,
    ceiling: DEFAULT_CEILING,
    'byte-ceiling': DEFAULT_BYTE_CEILING,
    mode: 'warn',
  };
  const baseByteCeiling =
    typeof base['byte-ceiling'] === 'number' ? base['byte-ceiling'] : DEFAULT_BYTE_CEILING;
  if (typeof content !== 'string' || content === '') {
    return tag({ ...base, 'byte-ceiling': baseByteCeiling });
  }

  const blockLines = scanInstructionBudgetBlock(content)?.blockLines ?? [];

  if (blockLines.length === 0) return tag({ ...base, 'byte-ceiling': baseByteCeiling });

  let enabled = base.enabled;
  let ceiling = base.ceiling;
  let byteCeiling = baseByteCeiling;
  // The two SURFACE ceilings are OPTIONAL on this shape, unlike the two above:
  // `checkInstructionBudget` already falls back to the module default when the
  // key is absent, and `loadInstructionBudgetConfig`'s own fallback object
  // never carried them. So they are emitted only when a value actually
  // resolves — emitting `undefined` would be indistinguishable from "set to
  // nothing", and emitting the module default here would duplicate a default
  // that already lives at the consumer (#1309).
  let generatedByteCeiling =
    typeof base['generated-byte-ceiling'] === 'number' ? base['generated-byte-ceiling'] : undefined;
  let pathScopedByteCeiling =
    typeof base['path-scoped-byte-ceiling'] === 'number'
      ? base['path-scoped-byte-ceiling']
      : undefined;
  let mode = base.mode;

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        // Default on → only flip to false on explicit "false".
        enabled = v.toLowerCase() !== 'false';
        break;
      case 'ceiling': {
        if (/^-?\d+$/.test(v)) {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) {
            ceiling = n;
            if (!explicit.includes('ceiling')) explicit.push('ceiling');
          }
        }
        break;
      }
      case 'byte-ceiling': {
        // Same shape as `ceiling` above — integer, strictly positive, malformed
        // or non-positive values silently keep the default (#931a).
        if (/^-?\d+$/.test(v)) {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) {
            byteCeiling = n;
            if (!explicit.includes('byte-ceiling')) explicit.push('byte-ceiling');
          }
        }
        break;
      }
      case 'generated-byte-ceiling': {
        // Identical validation to `byte-ceiling` above — integer, strictly
        // positive; malformed or non-positive silently keeps whatever was
        // already resolved (#1309).
        if (/^-?\d+$/.test(v)) {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) {
            generatedByteCeiling = n;
            if (!explicit.includes('generated-byte-ceiling')) explicit.push('generated-byte-ceiling');
          }
        }
        break;
      }
      case 'path-scoped-byte-ceiling': {
        // Same shape again — the sibling surface axis (#1297 follow-up); both
        // config keys were read by `checkInstructionBudget` and emitted by
        // nothing until #1309.
        if (/^-?\d+$/.test(v)) {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) {
            pathScopedByteCeiling = n;
            if (!explicit.includes('path-scoped-byte-ceiling')) explicit.push('path-scoped-byte-ceiling');
          }
        }
        break;
      }
      case 'mode':
        // Only `off` silences; any other value (incl. `warn`) surfaces the banner.
        mode = v.toLowerCase() === 'off' ? 'off' : 'warn';
        break;
    }
  }

  const parsed = { enabled, ceiling, 'byte-ceiling': byteCeiling, mode };
  if (typeof generatedByteCeiling === 'number') {
    parsed['generated-byte-ceiling'] = generatedByteCeiling;
  }
  if (typeof pathScopedByteCeiling === 'number') {
    parsed['path-scoped-byte-ceiling'] = pathScopedByteCeiling;
  }
  return tag(parsed);
}

/**
 * Skips a leading YAML frontmatter block (`---` … `---`) and returns the
 * remaining lines. Shared frontmatter classification for BOTH the directive
 * counter and the byte-walk (#877) — a single SSOT so the two dimensions
 * can never drift on "where does the file's body actually start".
 *
 * @param {string} content - raw file contents
 * @returns {string[]} lines after the frontmatter block (or all lines when
 *   there is no leading frontmatter / it never closes)
 */
function stripFrontmatterLines(content) {
  if (typeof content !== 'string' || content === '') return [];

  const lines = content.split(/\r?\n/);
  let i = 0;

  // Skip a leading YAML frontmatter block: `---` … `---`.
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    let j = 1;
    while (j < lines.length && lines[j].trim() !== '---') j++;
    // Only skip if a closing fence was found; otherwise leave i at 0.
    if (j < lines.length) i = j + 1;
  }

  return lines.slice(i);
}

/**
 * Count always-on directives in a single rule file's content.
 *
 * Deterministic heuristic — counts lines that represent a directive:
 *   - bullets:       /^\s*[-*+]\s/
 *   - ordered items: /^\s*\d+[.)]\s/
 *   - headings ≥2:   /^#{2,}\s/
 *
 * Fenced code blocks (``` … ```) are excluded entirely, and a leading
 * `---` … `---` YAML frontmatter block is skipped before counting (shared
 * skip logic with the byte-walk below — see `stripFrontmatterLines`).
 *
 * Exported (#877) so `countContentBytes` reuses this exact classification
 * instead of a second hand-rolled copy — see the module doc's "Guard &
 * Threshold Design" cross-reference in `.claude/rules/development.md` on
 * why a duplicated classifier is a drift hazard, not a convenience.
 *
 * @param {string} content - raw file contents
 * @returns {number}
 */
export function countDirectives(content) {
  const lines = stripFrontmatterLines(content);

  let count = 0;
  let inFence = false;

  for (const line of lines) {
    // Toggle code-fence state on any line that opens/closes a fence.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (
      /^\s*[-*+]\s/.test(line) ||
      /^\s*\d+[.)]\s/.test(line) ||
      /^#{2,}\s/.test(line)
    ) {
      count++;
    }
  }

  return count;
}

/**
 * Byte-walk companion to `countDirectives` (#877 FA2). Sums the UTF-8 byte
 * length of a rule file's BODY (everything after a leading YAML frontmatter
 * block, reusing `stripFrontmatterLines` — the exact same frontmatter
 * classification `countDirectives` uses, so the two dimensions can never
 * disagree on where the body starts).
 *
 * Deliberately UNLIKE `countDirectives`: fenced code blocks are NOT
 * excluded here. That divergence is the entire point of the byte
 * dimension — the #877 audit measured that fenced-code and prose bytes
 * (both invisible to the directive-line heuristic) still consume real
 * instruction-budget payload. Frontmatter is excluded from both dimensions
 * identically because it is metadata, not instructional content.
 *
 * @param {string} content - raw file contents
 * @returns {number} UTF-8 byte length of the body (0 for empty/non-string input)
 */
function countContentBytes(content) {
  const lines = stripFrontmatterLines(content);
  if (lines.length === 0) return 0;
  return Buffer.byteLength(lines.join('\n'), 'utf8');
}

/**
 * Sums `countContentBytes` over an entry list already filtered to
 * `alwaysOn === true`. Small private helper so the three surface totals
 * below (`coordinator` / `wave` / `always`) share one summation shape.
 *
 * @param {Array<{content: string}>} entries
 * @returns {number}
 */
function sumBytes(entries) {
  let bytes = 0;
  for (const entry of entries) bytes += countContentBytes(entry.content);
  return bytes;
}

/**
 * Is this rule file MACHINE-GENERATED by the reconciliation engine?
 *
 * The predicate mirrors `scripts/lib/reconcile/writer.mjs` § "Tier 3: binds on
 * any machine-provenance-bearing document" VERBATIM — `auto-generated: true`,
 * OR a `learning-key`, OR an `expires-at`. That is deliberately the writer's
 * own definition and not a fourth copy of it: the writer is what STAMPS these
 * keys (`reconcile/renderer.mjs` emits `learning-key` + `expires-at` on every
 * rule it renders, and the consolidated files additionally carry
 * `auto-generated: true`), so a rule the writer would hold to the invariant is
 * exactly a rule this ceiling should judge.
 *
 * The `meta` object is whatever {@link parseGlobsFrontmatter} surfaced — all
 * three keys are in rule-loader's known-meta set, so no second frontmatter
 * parser is introduced here.
 *
 * @param {Record<string, unknown>} meta
 * @returns {boolean}
 */
export function isMachineGeneratedRule(meta) {
  if (!meta || typeof meta !== 'object') return false;
  return (
    meta['auto-generated'] === true ||
    Object.prototype.hasOwnProperty.call(meta, 'learning-key') ||
    Object.prototype.hasOwnProperty.call(meta, 'expires-at')
  );
}

/** One day in milliseconds — local to this module, as in every other lib here. */
const MS_PER_DAY = 86_400_000;

/**
 * Whole days from `now` until this rule's `expires-at`, or `null` when the rule
 * declares no expiry or an unparseable one.
 *
 * Negative ⇒ already expired. The comparison basis is deliberately the SAME one
 * `rule-loader.mjs` `applyGates` uses — `ruleExpiryInstantMs`, where a bare
 * `YYYY-MM-DD` is INCLUSIVE and expires at the FOLLOWING UTC midnight (#1521) —
 * so "expired" here means exactly "the loader already filters it out of every
 * wave's rule set", never a second definition of the same word. `0` therefore
 * means "last day: still loads today", `-1` "dropped at the last midnight".
 *
 * An unparseable date returns `null` (fail-OPEN, matching the loader, which
 * warns and ignores the expiry rather than excluding the file) — the malformed
 * value is a separate finding, not an expiry verdict.
 *
 * @param {{ meta?: Record<string, unknown>, now?: Date|number|string }} [opts]
 * @returns {number|null}
 */
export function daysUntilGeneratedRuleExpiry(opts = {}) {
  const meta = opts.meta;
  if (!meta || typeof meta !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(meta, 'expires-at')) return null;
  const expiresAt = ruleExpiryInstantMs(meta['expires-at']);
  if (expiresAt === null) return null;

  return Math.floor((expiresAt - nowMs(opts.now)) / MS_PER_DAY);
}

/** `now` as epoch ms: Date, number or parseable string; anything else → the process clock. */
function nowMs(raw) {
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && Number.isFinite(Date.parse(raw))) return Date.parse(raw);
  return Date.now();
}

/**
 * Is this generated rule's `expires-at` already in the past?
 *
 * The defect it names (#1372): `rule-loader.mjs` filters an expired rule out at
 * READ time, but nothing DELETES it — so the file keeps being counted by every
 * byte ceiling above and keeps being loaded verbatim by Claude Code, which has
 * no notion of `expires-at`.
 *
 * @param {{ meta?: Record<string, unknown>, now?: Date|number|string }} [opts]
 * @returns {boolean}
 */
export function isExpiredGeneratedRule(opts = {}) {
  const meta = opts.meta;
  if (!meta || typeof meta !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(meta, 'expires-at')) return false;
  // The loader's own predicate, not `days < 0`: flooring whole days would call
  // the rule live for the first millisecond after the boundary (#1521).
  return isRuleExpired(meta['expires-at'], nowMs(opts.now));
}

/**
 * Enumerate the machine-generated rule files in `rulesDir`.
 *
 * Same population, same filter and same frontmatter parser as
 * {@link measureRuleCorpora}'s `generated` surface — that is the point of
 * exporting it: a consumer that needs the FILES rather than the BYTES (the
 * expiry test, the session-start maintenance probe) must not mirror the
 * predicate, because a mirror agrees only until one side is edited.
 *
 * Three-state, like every reader in the banner family: `ok: false` means the
 * directory exists but could not be enumerated, which a caller must record as
 * "undeterminable" and never as "no generated rules". A MISSING directory is
 * `ok: true` with an empty list — a repo without `.claude/rules/` genuinely has
 * none.
 *
 * @param {{ rulesDir?: string, repoRoot?: string }} [opts]
 * @returns {{ ok: boolean, rules: Array<{ file: string, meta: Record<string, unknown>, expiresAt: string|null }> }}
 */
export function listMachineGeneratedRules(opts = {}) {
  const dir =
    typeof opts.rulesDir === 'string' && opts.rulesDir.length > 0
      ? opts.rulesDir
      : join(opts.repoRoot ?? process.cwd(), '.claude', 'rules');

  /** @type {Array<{ file: string, meta: Record<string, unknown>, expiresAt: string|null }>} */
  const rules = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    // ENOENT is an answer ("no generated rules"); anything else is not knowing.
    return { ok: err?.code === 'ENOENT', rules };
  }

  for (const file of names) {
    if (!file.endsWith('.md')) continue;
    let meta;
    try {
      ({ meta } = parseGlobsFrontmatter(readFileSync(join(dir, file), 'utf8')));
    } catch {
      continue; // unreadable or unparseable — skip, never throw
    }
    if (!isMachineGeneratedRule(meta)) continue;
    const raw = meta?.['expires-at'];
    rules.push({ file, meta, expiresAt: typeof raw === 'string' ? raw : null });
  }

  return { ok: true, rules };
}

/**
 * Single-pass scan of `.claude/rules/*.md` producing the TWO corpus measures
 * this guard's third axis needs, which #1297 proved are NOT the same set:
 *
 *   - `generated`  — rules carrying a reconciliation provenance marker
 *     ({@link isMachineGeneratedRule}). This is the population
 *     {@link DEFAULT_GENERATED_BYTE_CEILING} is a ceiling FOR: the thing that
 *     grows on its own, without anyone deciding to add a rule.
 *   - `pathScoped` — every rule with a `paths:` key (#1638: Claude Code's only
 *     scope key; a `globs:`-only rule is always-on there), i.e. the complement
 *     of the always-on set the three tier surfaces measure.
 *     A real quantity, and the one this axis USED to report under the name
 *     `generated` — see the ceiling's docblock for what that cost.
 *
 * The two overlap but neither contains the other by construction: a
 * hand-written rule can be path-scoped (3 of them are here), and a generated
 * rule could in principle carry a `host-class` activation axis instead of
 * `paths:`.
 *
 * Neither can reuse `loadApplicableRules`: that loader takes a `scopePaths`
 * list and returns the rules APPLICABLE to it, so with `scopePaths: []` it
 * yields always-on rules only. Neither question is about a wave's file scope —
 * both are properties of the DIRECTORY. The frontmatter reading is still
 * delegated (`parseGlobsFrontmatter`), so the always-on/path-scoped split and
 * the provenance keys stay decided in exactly one place.
 *
 * Bytes are counted with {@link countContentBytes} — frontmatter stripped —
 * so both are directly comparable to `totalBytes` and to the tier surfaces.
 * Note what that implies for the generated corpus specifically: its frontmatter
 * and `## Provenance` FRONTMATTER is excluded, its provenance BODY bullets are
 * not (they are body text).
 *
 * Never throws: an unreadable dir or file yields zeros / is skipped, matching
 * this module's never-throw posture.
 *
 * @param {string} rulesDir
 * @returns {{ generated: { bytes: number, files: number }, pathScoped: { bytes: number, files: number } }}
 */
function measureRuleCorpora(rulesDir) {
  const generated = { bytes: 0, files: 0 };
  const pathScoped = { bytes: 0, files: 0 };

  let names;
  try {
    names = readdirSync(rulesDir);
  } catch {
    return { generated, pathScoped };
  }

  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    let content;
    try {
      content = readFileSync(join(rulesDir, name), 'utf8');
    } catch {
      continue; // unreadable file — skip, never throw
    }
    let paths;
    let meta;
    try {
      ({ paths, meta } = parseGlobsFrontmatter(content));
    } catch {
      continue;
    }
    const bytes = countContentBytes(content);
    if (isMachineGeneratedRule(meta)) {
      generated.files += 1;
      generated.bytes += bytes;
    }
    // `paths === null` → always-on for Claude Code, already counted by the
    // tier surfaces (which load with `scopeKey: 'paths'` — same split).
    if (paths !== null) {
      pathScoped.files += 1;
      pathScoped.bytes += bytes;
    }
  }

  return { generated, pathScoped };
}

/**
 * Pure computation — always returns the full shape (never null, never throws).
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]  project root (defaults to process.cwd()).
 * @param {string} [opts.rulesDir]  rules directory (defaults to <repoRoot>/.claude/rules).
 * @param {number} [opts.ceiling]   directive ceiling (defaults to DEFAULT_CEILING).
 * @param {number} [opts.byteCeiling] byte ceiling (defaults to DEFAULT_BYTE_CEILING).
 *   #931a: the byte dimension shipped in #877 as DATA ONLY — nothing read it,
 *   so a rule file could grow without limit as long as it added few bullet
 *   lines. It is now a verdict axis alongside the directive count.
 * @param {'wave'|'coordinator'|null} [opts.context]  (#877; corrected #893)
 *   narrows the PRIMARY totals (`totalDirectives`/`totalBytes`/`perFile`) to
 *   what a given surface actually receives, via rule-loader's own tier gate
 *   (`loadApplicableRules({context})`) — no hand-rolled tier conditionals
 *   here:
 *     - `'wave'`: excludes `tier: coordinator-only` (what a WAVE agent
 *       receives).
 *     - `'coordinator'` (#893 fix — previously silently coerced to `null`,
 *       i.e. untiered): excludes `tier: wave-only` — mirrors
 *       `loadApplicableRules({context:'coordinator'})` exactly, the REAL
 *       coordinator delivery path (`print-applicable-rules.mjs --context
 *       coordinator`).
 *     - `null` (default) OR any unrecognised value (`undefined`, `'bogus'`,
 *       …): the pre-#877 tier-agnostic shape — every always-on rule,
 *       regardless of tier. This ALSO matches rule-loader's own
 *       `context: null` semantics (no tier gating at all — see
 *       `rule-loader.mjs`'s `applyGates`), so `null` is not a special case
 *       invented by this module; it is the same "no tier gate" behaviour
 *       rule-loader itself defines. Fail-open: an unrecognised string never
 *       throws, it just falls back to this same untiered shape.
 *   This `context` param is independent of `bySurface`, which is ALWAYS
 *   computed the same way for all three surfaces regardless of `context`
 *   (see the `bySurface` doc below).
 * @returns {{
 *   totalDirectives: number,
 *   totalBytes: number,
 *   perFile: Array<{ file: string, count: number, bytes: number }>,
 *   ceiling: number,
 *   byteCeiling: number,
 *   overDirectiveBudget: boolean,
 *   overByteBudget: boolean,
 *   overGeneratedBudget: boolean,
 *   overPathScopedBudget: boolean,
 *   overBudget: boolean,
 *   severity: 'ok' | 'warn',
 *   bySurface: { coordinator: number, wave: number, always: number,
 *               generated: {bytes: number, files: number},
 *               pathScoped: {bytes: number, files: number} },
 *   defects: string[],
 * }}
 *   perFile is sorted DESC by count. `defects` (#1449) lists, sorted by name,
 *   the rule files whose frontmatter does not start on line 1 — Claude Code
 *   ignores it, so they load always-on and are counted as such. It is
 *   independent of `context` (such a file has no tier to gate on) and never
 *   feeds `overBudget`. On missing/unreadable dir →
 *   { totalDirectives: 0, totalBytes: 0, perFile: [], ceiling, byteCeiling,
 *     overDirectiveBudget: false, overByteBudget: false, overBudget: false,
 *     severity: 'ok', bySurface: { coordinator: 0, wave: 0, always: 0,
 *     generated: {bytes:0,files:0}, pathScoped: {bytes:0,files:0} },
 *     defects: [] }.
 *
 *   #931a verdict rule — `overBudget` is the OR of the two axes
 *   (`overDirectiveBudget || overByteBudget`), NOT a per-axis severity split:
 *     - Both axes measure the SAME quantity (the cost of the always-on
 *       instruction corpus) on different scales, and either one breaching is
 *       equally actionable. A 9 KB prose-only rule with three bullets is
 *       invisible to the directive axis while consuming real payload — that
 *       gap is precisely what #877 measured and what this OR closes.
 *     - A per-axis severity would need a third value in the banner-shape
 *       vocabulary (`{severity:'warn', message}` is a fixed convention shared
 *       with checkQgCommandDrift / checkCiStatus), i.e. a protocol change for
 *       every Phase-4 banner consumer — disproportionate to the gain.
 *     - Alarm fatigue is governed by the CEILING CHOICE, not by the severity
 *       label: a ceiling calibrated above the current state (see
 *       DEFAULT_BYTE_CEILING) fires rarely, whereas a too-tight ceiling
 *       produces a line at every session start no matter how it is labelled.
 *   The two sub-flags are exported so a consumer can discriminate WHICH axis
 *   broke without re-deriving the comparison (the banner below does exactly
 *   this to choose its Top-files sort key). The same OR later took two more
 *   terms — `overGeneratedBudget` (#1297) and `overPathScopedBudget` (#1316) —
 *   so today `overBudget` is true when ANY of the four axes breaches.
 *
 *   bySurface definition (#877; corrected #893 — NOT the additive
 *   `coordinator + wave === totalBytes` identity, which double-counts the
 *   `always` tier):
 *     bySurface.wave === bytes of every always-on rule whose tier is not
 *       'coordinator-only' (i.e. what `loadApplicableRules({context:'wave'})`
 *       returns) — equivalently "always + wave-only" bytes.
 *     bySurface.coordinator === bytes of every always-on rule whose tier is
 *       not 'wave-only' (i.e. what `loadApplicableRules({context:'coordinator'})`
 *       returns — the REAL coordinator delivery path,
 *       `print-applicable-rules.mjs --context coordinator`) —
 *       equivalently "always + coordinator-only" bytes. #893 fix: this is
 *       NOT a tier-agnostic alias of `totalBytes` — a pre-#893 doc revision
 *       claimed the coordinator "structurally sees the entire always-on
 *       corpus regardless of tier", which does not match rule-loader's own
 *       tier gate and is corrected here.
 *     bySurface.always === bytes of always-on rules with `tier === 'always'` only.
 *     bySurface.generated === {bytes, files} of every rule carrying a
 *       reconciliation PROVENANCE marker (`auto-generated: true` /
 *       `learning-key` / `expires-at`) — the corpus
 *       {@link DEFAULT_GENERATED_BYTE_CEILING} judges (#1297).
 *     bySurface.pathScoped === {bytes, files} of every rule with a `paths:`
 *       key (#1638) — the complement of the always-on set, and
 *       the number an operator reproduces from `ls .claude/rules/` (HR-106).
 *       Judged against {@link DEFAULT_PATH_SCOPED_BYTE_CEILING} into
 *       `overPathScopedBudget`, an `overBudget` term since #1316 (see that
 *       constant's docblock for why it was held out until then).
 *
 *   `always` is a strict subset of BOTH `wave` and `coordinator` (neither
 *   tier gate excludes `tier: 'always'`), but `wave` and `coordinator` are
 *   SIBLING projections of the same corpus, not nested in each other — each
 *   excludes a DIFFERENT tier, so their relative size depends on how much
 *   content actually carries `tier: wave-only` vs. `tier: coordinator-only`.
 *   Do NOT assume `wave ⊆ coordinator` or `coordinator ⊆ wave`.
 *
 *   `bySurface` is computed identically regardless of what `opts.context`
 *   was requested for the PRIMARY totals above — e.g. a `context: 'wave'`
 *   call still reports the FULL coordinator-surface byte sum in
 *   `bySurface.coordinator`, not the wave-narrowed `totalBytes`.
 */
export function computeInstructionBudget(opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const rulesDir = opts.rulesDir ?? join(repoRoot, '.claude/rules');
  const ceiling = typeof opts.ceiling === 'number' ? opts.ceiling : DEFAULT_CEILING;
  const byteCeiling =
    typeof opts.byteCeiling === 'number' ? opts.byteCeiling : DEFAULT_BYTE_CEILING;
  const generatedByteCeiling =
    typeof opts.generatedByteCeiling === 'number'
      ? opts.generatedByteCeiling
      : DEFAULT_GENERATED_BYTE_CEILING;
  const pathScopedByteCeiling =
    typeof opts.pathScopedByteCeiling === 'number'
      ? opts.pathScopedByteCeiling
      : DEFAULT_PATH_SCOPED_BYTE_CEILING;
  // #893 fix: 'coordinator' used to fall through to the `null` (untiered)
  // branch below — silently measuring the WRONG rule set for a coordinator
  // context (it never excluded `tier: wave-only`). Now explicitly recognised
  // alongside 'wave'; any other value (incl. `undefined`/'bogus') still
  // fails open to the untiered `null` shape — see the param doc above.
  const context =
    opts.context === 'wave' ? 'wave' : opts.context === 'coordinator' ? 'coordinator' : null;

  const empty = {
    totalDirectives: 0,
    totalBytes: 0,
    perFile: [],
    ceiling,
    byteCeiling,
    generatedByteCeiling,
    pathScopedByteCeiling,
    overDirectiveBudget: false,
    overByteBudget: false,
    overGeneratedBudget: false,
    overPathScopedBudget: false,
    overBudget: false,
    severity: 'ok',
    bySurface: {
      coordinator: 0,
      wave: 0,
      always: 0,
      generated: { bytes: 0, files: 0 },
      pathScoped: { bytes: 0, files: 0 },
    },
    defects: [],
  };

  let allEntries;
  let waveEntries;
  let coordinatorEntries;
  try {
    // Empty scopePaths → only always-on rules (no glob matches) are
    // returned by any of the three calls. `context: null` is the pre-#877
    // shape (tier-agnostic — no tier gating at all, matching rule-loader's
    // own `context: null` semantics); `context: 'wave'` / `context:
    // 'coordinator'` each apply rule-loader's own tier gate (`applyGates`)
    // — reused, not reimplemented. All three lists are loaded unconditionally
    // (not just the one matching `opts.context`) because `bySurface` reports
    // all three surfaces regardless of which `context` was requested for the
    // PRIMARY totals (see doc above). `scopeKey: 'paths'` (#1638): the budget
    // measures what Claude Code loads, and Claude Code scopes on `paths:` only.
    const scopeKey = 'paths';
    allEntries = loadApplicableRules({ rulesDir, scopePaths: [], scopeKey });
    waveEntries = loadApplicableRules({ rulesDir, scopePaths: [], context: 'wave', scopeKey });
    coordinatorEntries = loadApplicableRules({ rulesDir, scopePaths: [], context: 'coordinator', scopeKey });
  } catch {
    return empty;
  }

  if (
    !Array.isArray(allEntries) ||
    !Array.isArray(waveEntries) ||
    !Array.isArray(coordinatorEntries)
  ) {
    return empty;
  }

  const alwaysOnAll = allEntries.filter((e) => e && e.alwaysOn === true);
  const alwaysOnWave = waveEntries.filter((e) => e && e.alwaysOn === true);
  const alwaysOnCoordinator = coordinatorEntries.filter((e) => e && e.alwaysOn === true);

  const bySurface = {
    coordinator: sumBytes(alwaysOnCoordinator),
    wave: sumBytes(alwaysOnWave),
    always: sumBytes(alwaysOnAll.filter((e) => e.tier === 'always')),
    // The fourth and fifth surfaces are deliberately a different SHAPE from
    // their three siblings ({bytes, files} vs. a bare byte number): these
    // corpora grow by FILE COUNT as much as by size — 43 files averaging
    // 2.1 kB is the shape this axis exists to catch — and a bare number would
    // hide that.
    //
    // #1297: `generated` is the PROVENANCE-marked corpus (what /reconcile
    // materializes), NOT "every path-scoped file" as it was through #1240.
    // `pathScoped` keeps the old measurement under its honest name. Both are
    // disjoint from `totalBytes`, which counts always-on rules exclusively —
    // except that a generated rule activated by `host-class` rather than
    // `paths:` would be always-on and therefore counted in both.
    ...measureRuleCorpora(rulesDir),
  };

  // Surface-selected entry set for the PRIMARY totals. `context: null`
  // (default, or any unrecognised value) preserves pre-#877 behaviour —
  // every always-on rule, tier-agnostic. `context: 'wave'` / `context:
  // 'coordinator'` each narrow to the exact same filtered list their
  // `bySurface` counterpart sums (no second, separately computed entry list).
  const selectedEntries =
    context === 'wave' ? alwaysOnWave : context === 'coordinator' ? alwaysOnCoordinator : alwaysOnAll;

  const perFile = [];
  let totalDirectives = 0;
  let totalBytes = 0;

  for (const entry of selectedEntries) {
    const count = countDirectives(entry.content);
    const bytes = countContentBytes(entry.content);
    totalDirectives += count;
    totalBytes += bytes;
    perFile.push({ file: basename(entry.path), count, bytes });
  }

  // Sort DESC by count; tie-break by filename for deterministic output.
  perFile.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));

  // #931a: both axes are evaluated; `overBudget` is their OR (rationale in the
  // returns-doc above). Strict `>` on both, so a total sitting exactly ON its
  // ceiling is still "ok" — the byte axis inherits the directive axis's
  // long-standing boundary semantics rather than inventing a second rule.
  const overDirectiveBudget = totalDirectives > ceiling;
  const overByteBudget = totalBytes > byteCeiling;
  // Third axis, same strict `>` boundary semantics as the two above.
  const overGeneratedBudget = bySurface.generated.bytes > generatedByteCeiling;
  // Fourth axis, same strict `>` boundary. Folded into `overBudget` since
  // #1316, once consolidation brought the corpus back under its ceiling — see
  // DEFAULT_PATH_SCOPED_BYTE_CEILING's docblock for the calibration and the
  // revisit trigger.
  const overPathScopedBudget = bySurface.pathScoped.bytes > pathScopedByteCeiling;
  const overBudget = overDirectiveBudget || overByteBudget || overGeneratedBudget || overPathScopedBudget;

  // #1449: read off the untiered list — a defective file carries no meta, so
  // no tier gate drops it and `alwaysOnAll` holds every one of them.
  const defects = alwaysOnAll
    .filter((e) => e.defect === FRONTMATTER_NOT_AT_TOP)
    .map((e) => basename(e.path))
    .sort((a, b) => a.localeCompare(b));

  return {
    totalDirectives,
    totalBytes,
    perFile,
    ceiling,
    byteCeiling,
    generatedByteCeiling,
    pathScopedByteCeiling,
    overDirectiveBudget,
    overByteBudget,
    overGeneratedBudget,
    overPathScopedBudget,
    overBudget,
    severity: overBudget ? 'warn' : 'ok',
    bySurface,
    defects,
  };
}

/** Ledger event the backlog number below is read from (`reconcile/engine.mjs`). */
const RECONCILE_EVENT = 'orchestrator.reconcile.completed';

/**
 * Events-ledger window for the #1401 census (`events-retention-banner.mjs`):
 * `null` — {@link readLastReconcileCapped} wants the NEWEST reconcile record,
 * whose age no constant bounds; a pruned one reads as not measured (`null`,
 * rendered as absence), never as a measured `0`.
 */
export const REQUIRED_EVENTS_WINDOW_DAYS = null;

/**
 * Wall-clock budget for the backwards ledger walk. Deliberately small: this
 * runs inside a session-start probe whose own budget is 2 s, and the number it
 * fetches is DECORATION on a line that is already actionable without it.
 */
const RECONCILE_SCAN_BUDGET_MS = 150;

/**
 * `capped` from the most recent `orchestrator.reconcile.completed` record —
 * how many rule-eligible learnings the last /reconcile run held back.
 *
 * Three-state on purpose (`feedback_missing_measurement_looks_like_zero`):
 * `null` means NOT MEASURED (no ledger, no such record, unreadable source, or
 * the walk ran out of budget), which the caller must render as ABSENCE — never
 * as `0`, which is a measured "nothing waiting".
 *
 * @param {string|undefined} repoRoot
 * @returns {number|null}
 */
function readLastReconcileCapped(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot === '') return null;
  const filePath = eventsFilePath(repoRoot); // #1514 point 1: the repo's one ledger
  let capped = null;
  let scan;
  try {
    scan = scanEventsBackwards({
      filePath,
      budgetMs: RECONCILE_SCAN_BUDGET_MS,
      // Cheap raw-line pre-filter before JSON.parse — same reason as
      // `maintenance-due-banner.mjs`: parsing every line of a multi-MB ledger
      // to answer one question is the cost this option exists to avoid.
      filter: RECONCILE_EVENT,
      onRecord: (rec) => {
        if (rec?.event !== RECONCILE_EVENT) return false;
        capped = Number.isFinite(rec.capped) ? rec.capped : null;
        return true; // newest record wins; stop the walk
      },
    });
  } catch {
    return null; // never throw out of the banner wrapper
  }
  // A walk that did not finish has not proven anything about the backlog.
  if (scan.truncated || scan.unreadable.length > 0) return null;
  return capped;
}

/**
 * The #1419 early-warning line: the path-scoped ceiling is close, not broken.
 *
 * Reports the numbers the RULE judged (HR-106) — the same `pathScoped.bytes`
 * and ceiling `writeApprovedRules` will compare later — plus, when the ledger
 * carries one, how many learnings the last /reconcile run already held back.
 * The percentage is formatted locale-free so the same corpus renders the same
 * string on every host.
 *
 * @param {ReturnType<typeof computeInstructionBudget>} budget
 * @param {string|undefined} repoRoot
 * @returns {string}
 */
function formatNearPathScopedLine(budget, repoRoot) {
  const used = budget.bySurface.pathScoped.bytes;
  const ceiling = budget.pathScopedByteCeiling;
  const pct = ((used / ceiling) * 100).toFixed(1);
  const capped = readLastReconcileCapped(repoRoot);
  // Only a POSITIVE measured backlog is worth a clause; `0` and `null` both
  // add nothing the operator can act on, and printing `0` for `null` would be
  // the false-negative this helper's three-state contract exists to prevent.
  const backlog = typeof capped === 'number' && capped > 0 ? ` — ${capped} Learnings warten` : '';
  return (
    `path-scoped Regel-Decke zu ${pct} % belegt (${used}/${ceiling} B)${backlog} — ` +
    '/reconcile wird Learnings zurueckhalten'
  );
}

/**
 * The #1449 defect line: rule files whose frontmatter Claude Code never reads.
 * Names every file — the fix is per file (move the text above `---` below the
 * closing fence), so a count alone would send the operator hunting.
 *
 * @param {string[]} defects - basenames from `computeInstructionBudget().defects`
 * @returns {string}
 */
function formatFrontmatterDefectLine(defects) {
  return (
    `⚠ ${defects.length} rule(s) carry frontmatter that Claude Code ignores ` +
    `(text before the opening ---): ${defects.join(', ')} — they load always-on.`
  );
}

/**
 * Absolute path of the calibration CLI, resolved from THIS module's location.
 *
 * Why not `$CLAUDE_PLUGIN_ROOT` / `$PLUGIN_ROOT`: no sibling banner renders a
 * plugin root (they print repo-relative `node scripts/…`, which is wrong in a
 * consumer repo), and the env var can name a different install than the code
 * that is running (see `plugin-update-banner.mjs` § "Installed = the code that
 * is RUNNING"). The CLI ships next to this module, so this path always exists.
 */
export const CALIBRATE_CLI_PATH = fileURLToPath(new URL('../instruction-budget-calibrate.mjs', import.meta.url));

/**
 * The #1995 re-aimed line: an axis over a plugin default this repo never chose.
 *
 * The DEFAULT_* ceilings are the plugin repo's own growth ratchet; in a
 * consumer repo an "over" against them measured nothing about that repo and
 * fired on 15 of 32 consumer corpora (47 %, HR-101: a broken instrument). So
 * the remedy named here is calibration, never consolidation.
 *
 * @param {string[]} parts - "<axis> <measured> > <default>" clauses
 * @param {{ hostFile?: string | null, existingBlock?: { keys: string[] } | null }} where
 *   - the loaded config (`withExplicit` shape); see {@link formatCalibrateInstruction}
 * @returns {string}
 */
function formatUncalibratedLine(parts, where) {
  return (
    `⚠ Instruction budget not calibrated for this repo — ${parts.join(' · ')} (plugin defaults). ` +
    formatCalibrateInstruction(where)
  );
}

/**
 * The one "how to calibrate" sentence, shared by the banner, the calibrate CLI
 * and the `/reconcile` writer's budget refusal so the three never disagree.
 *
 * Names the file the loader reads (#1995 F4) and, when that file already has an
 * `instruction-budget:` block, says REPLACE and lists the keys it sets — the
 * loader reads only the first block, so a pasted second block is silently
 * ignored (#1995 F2).
 *
 * @param {{ hostFile?: string | null, existingBlock?: { keys: string[] } | null }} [where]
 * @returns {string}
 */
export function formatCalibrateInstruction(where = {}) {
  const run = `Run node "${CALIBRATE_CLI_PATH}"`;
  const hostFile = where?.hostFile ?? null;
  const block = where?.existingBlock ?? null;
  if (hostFile === null) {
    return `${run} and commit the printed block into ## Session Config of CLAUDE.md (or AGENTS.md).`;
  }
  if (block === null) {
    return `${run} and commit the printed block into ## Session Config in ${hostFile}.`;
  }
  const sets = block.keys.length > 0 ? `sets ${block.keys.join(', ')}` : 'sets no key';
  return (
    `${run} and replace the existing instruction-budget block in ${hostFile} (${sets}) with the printed one ` +
    '— only the first block is read, a second one is ignored.'
  );
}

/**
 * Banner wrapper — session-start Phase 4 convention.
 *
 * Reads `instruction-budget.{enabled,ceiling,byte-ceiling,mode}` from Session
 * Config (CLAUDE.md / AGENTS.md at `opts.repoRoot`, default process.cwd()):
 *   - `enabled: false` OR `mode: off` → returns null (silent no-op).
 *   - The config `ceiling` / `byte-ceiling` are used unless `opts.ceiling` /
 *     `opts.byteCeiling` are explicitly supplied (an explicit opt wins, keeping
 *     callers that pin a ceiling deterministic).
 *   - Config-load failure → graceful fallback `{enabled:true, ceiling:480,
 *     'byte-ceiling':121000, mode:warn}` so the probe still computes (mirrors
 *     the other probes).
 * Never throws.
 *
 * The message names WHICH axis breached (#931a) — a banner that only said
 * "over budget" would leave the operator guessing whether to prune bullets or
 * prose. It stays short because it renders at every session start: the breach
 * block is three lines, plus one line per extra finding (near-threshold,
 * frontmatter defect).
 *
 * @param {object} [opts]  forwarded to computeInstructionBudget.
 * @param {string} [opts.repoRoot] project root for the config read.
 * @param {number} [opts.ceiling]  explicit directive-ceiling override (wins over config).
 * @param {number} [opts.byteCeiling] explicit byte-ceiling override (wins over config).
 * @param {number} [opts.pathScopedByteCeiling] explicit path-scoped-ceiling override.
 * CALIBRATION (#1995). An axis is calibrated when this repo's own block sets its
 * key (`ceiling`, `byte-ceiling`, `generated-byte-ceiling`,
 * `path-scoped-byte-ceiling`) or the caller pins it via `opts`. A calibrated
 * axis over (or, path-scoped, near) its ceiling reports as below. An
 * UNCALIBRATED axis over a plugin default — or near it, path-scoped — never
 * says "Instruction budget over": it is folded into ONE "not calibrated" line
 * that names measured vs. default and the calibrate CLI. Both kinds can appear
 * in the same message, each in its own wording.
 *
 * @returns {{ severity: 'warn', message: string } | null}
 *   null when disabled / off / every axis comfortably under its ceiling OR on
 *   any read failure. Since #1316 each of the four axes — directives, bytes,
 *   generated, path-scoped — raises the banner on its own (see
 *   DEFAULT_PATH_SCOPED_BYTE_CEILING). Since #1419 the path-scoped axis ALSO
 *   raises it at {@link PATH_SCOPED_NEAR_THRESHOLD} of its ceiling, before the
 *   breach: that band used to be silent, and the ceiling then surfaced only
 *   inside `writeApprovedRules` — after the operator had approved rules it
 *   refused to write. Since #1449 a rule whose frontmatter is not on line 1
 *   raises it too (one line naming the files), whether or not any axis is
 *   close. The RETURN SHAPE is unchanged (`{severity:'warn', message}` |
 *   null), so `session-start-probes.mjs` needs no new vocabulary.
 */
export function checkInstructionBudget(opts = {}) {
  let cfg;
  try {
    cfg = loadInstructionBudgetConfig(opts.repoRoot, { withExplicit: true });
  } catch {
    cfg = {
      enabled: true,
      ceiling: DEFAULT_CEILING,
      'byte-ceiling': DEFAULT_BYTE_CEILING,
      'generated-byte-ceiling': DEFAULT_GENERATED_BYTE_CEILING,
      mode: 'warn',
      explicit: [],
    };
  }

  // Opt-out gates — return null without computing.
  if (!cfg.enabled || cfg.mode === 'off') return null;

  // An explicit ceiling opt wins over the config ceiling; otherwise use config.
  const ceiling = typeof opts.ceiling === 'number' ? opts.ceiling : cfg.ceiling;
  const byteCeiling =
    typeof opts.byteCeiling === 'number'
      ? opts.byteCeiling
      : typeof cfg['byte-ceiling'] === 'number'
        ? cfg['byte-ceiling']
        : DEFAULT_BYTE_CEILING;

  // Same precedence as the two axes above: explicit opt > Session Config >
  // module default. Config-key is optional, so a repo that never heard of this
  // axis still gets the measured default rather than `undefined`.
  const generatedByteCeiling =
    typeof opts.generatedByteCeiling === 'number'
      ? opts.generatedByteCeiling
      : typeof cfg['generated-byte-ceiling'] === 'number'
        ? cfg['generated-byte-ceiling']
        : DEFAULT_GENERATED_BYTE_CEILING;

  // Identical precedence chain to the generated axis above: explicit opt >
  // Session Config `path-scoped-byte-ceiling` > module default.
  const pathScopedByteCeiling =
    typeof opts.pathScopedByteCeiling === 'number'
      ? opts.pathScopedByteCeiling
      : typeof cfg['path-scoped-byte-ceiling'] === 'number'
        ? cfg['path-scoped-byte-ceiling']
        : DEFAULT_PATH_SCOPED_BYTE_CEILING;

  // #1995: an axis is CALIBRATED when its ceiling was chosen for this corpus —
  // set in this repo's own Session Config block, or pinned by the caller. Only
  // then is "over" a finding about the repo; otherwise it is a finding about
  // the plugin's default (measured on the plugin's own corpus).
  const explicit = Array.isArray(cfg.explicit) ? cfg.explicit : [];
  const calibrated = {
    directives: typeof opts.ceiling === 'number' || explicit.includes('ceiling'),
    bytes: typeof opts.byteCeiling === 'number' || explicit.includes('byte-ceiling'),
    generated:
      typeof opts.generatedByteCeiling === 'number' || explicit.includes('generated-byte-ceiling'),
    pathScoped:
      typeof opts.pathScopedByteCeiling === 'number' || explicit.includes('path-scoped-byte-ceiling'),
  };

  let budget;
  try {
    budget = computeInstructionBudget({
      ...opts,
      ceiling,
      byteCeiling,
      generatedByteCeiling,
      pathScopedByteCeiling,
    });
  } catch {
    return null; // never throw out of the banner wrapper
  }

  if (!budget) return null;

  // #1419 near-threshold stage. Strictly BELOW the hard test (a breach is
  // reported as a breach, never twice), and computed before the early return
  // so a corpus at 90–100 % of the path-scoped ceiling stops being silent —
  // that silence is the defect: the ceiling used to surface only inside
  // `writeApprovedRules`, after the operator had already approved rules.
  const nearPathScoped =
    !budget.overPathScopedBudget &&
    budget.pathScopedByteCeiling > 0 &&
    budget.bySurface.pathScoped.bytes >= budget.pathScopedByteCeiling * PATH_SCOPED_NEAR_THRESHOLD;

  // Split every finding by calibration (#1995). The breach and near lines below
  // see only CALIBRATED axes; the uncalibrated ones get one re-aimed line.
  const over = {
    directives: budget.overDirectiveBudget && calibrated.directives,
    bytes: budget.overByteBudget && calibrated.bytes,
    generated: budget.overGeneratedBudget && calibrated.generated,
    pathScoped: budget.overPathScopedBudget && calibrated.pathScoped,
  };
  const anyOver = over.directives || over.bytes || over.generated || over.pathScoped;
  const nearCalibrated = nearPathScoped && calibrated.pathScoped;

  const uncalibrated = [];
  if (budget.overDirectiveBudget && !calibrated.directives) {
    uncalibrated.push(`directives ${budget.totalDirectives} > ${budget.ceiling}`);
  }
  if (budget.overByteBudget && !calibrated.bytes) {
    uncalibrated.push(`always-on bytes ${budget.totalBytes} > ${budget.byteCeiling}`);
  }
  if (budget.overGeneratedBudget && !calibrated.generated) {
    uncalibrated.push(
      `generated rules ${budget.bySurface.generated.bytes} B > ${budget.generatedByteCeiling} B`,
    );
  }
  if (budget.overPathScopedBudget && !calibrated.pathScoped) {
    uncalibrated.push(
      `path-scoped rules ${budget.bySurface.pathScoped.bytes} B > ${budget.pathScopedByteCeiling} B`,
    );
  } else if (nearPathScoped && !calibrated.pathScoped) {
    const pct = ((budget.bySurface.pathScoped.bytes / budget.pathScopedByteCeiling) * 100).toFixed(1);
    uncalibrated.push(
      `path-scoped rules ${budget.bySurface.pathScoped.bytes} B = ${pct} % of ${budget.pathScopedByteCeiling} B`,
    );
  }
  const uncalibratedLine = uncalibrated.length > 0 ? formatUncalibratedLine(uncalibrated, cfg) : null;

  // #1449 — reported on its own line, never folded into `overBudget`.
  const defectLine =
    budget.defects.length > 0 ? formatFrontmatterDefectLine(budget.defects) : null;

  if (!anyOver && !nearCalibrated && !uncalibratedLine && !defectLine) return null;

  const nearLine = nearCalibrated ? formatNearPathScopedLine(budget, opts.repoRoot) : null;

  // No calibrated breach: one block per finding — the near-threshold line
  // carries the same remedy as the breach clause below (consolidate — never raise).
  if (!anyOver) {
    return {
      severity: 'warn',
      message: [
        ...(nearLine
          ? [
              `⚠ ${nearLine}.`,
              '  Consolidate generated rules per docs/rule-authoring.md § Consolidated rules; never raise the ceiling.',
            ]
          : []),
        ...(uncalibratedLine ? [uncalibratedLine] : []),
        ...(defectLine ? [defectLine] : []),
      ].join('\n'),
    };
  }

  // Name only the breached axes — listing a healthy axis would pad the line
  // without telling the operator anything they must act on.
  const axes = [];
  if (over.directives) {
    axes.push(`directives ${budget.totalDirectives} > ${budget.ceiling}`);
  }
  if (over.bytes) {
    axes.push(`bytes ${budget.totalBytes} > ${budget.byteCeiling}`);
  }
  if (over.generated) {
    // Reported with its FILE COUNT, because the actionable lever on this axis
    // is consolidating files, not trimming prose inside them (HR-106: the
    // banner reports the number the rule judged).
    axes.push(
      `generated rules ${budget.bySurface.generated.bytes} B over ` +
        `${budget.bySurface.generated.files} files > ${budget.generatedByteCeiling} B`,
    );
  }
  // A trigger in its own right since #1316. It carries its remedy inline
  // because the lever is not obvious from the number: consolidate generated
  // rules; raising the ceiling is the unfalsifiable move
  // DEFAULT_PATH_SCOPED_BYTE_CEILING's docblock rules out.
  if (over.pathScoped) {
    axes.push(
      `path-scoped rules ${budget.bySurface.pathScoped.bytes} B over ` +
        `${budget.bySurface.pathScoped.files} files > ${budget.pathScopedByteCeiling} B ` +
        '(consolidate generated rules per docs/rule-authoring.md § Consolidated rules; never raise the ceiling)',
    );
  }

  // `perFile` arrives sorted DESC by directive count. When ONLY the byte axis
  // broke, that ordering points at the wrong files — re-sort by bytes so the
  // Top-files line lists the ones actually responsible for the breach.
  const ranked =
    over.bytes && !over.directives
      ? [...budget.perFile].sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file))
      : budget.perFile;

  const top = ranked
    .slice(0, 3)
    .map((f) => `${f.file} (${f.count} dir, ${f.bytes} B)`)
    .join(', ');

  // The near-threshold line rides ALONGSIDE the breach line rather than inside
  // `axes`: the path-scoped axis is not over, and folding a healthy-but-close
  // axis into a sentence that says "over" would misreport which ceiling broke.
  const message = [
    `⚠ Instruction budget over — ${axes.join(' · ')} across ${budget.perFile.length} always-on rules.`,
    ...(nearLine ? [`  ${nearLine}.`] : []),
    `  Top files: ${top}`,
    '  See the instruction-budget audit (#687; archived in the private Meta-Vault) for the prune/demote list.',
    ...(uncalibratedLine ? [uncalibratedLine] : []),
    ...(defectLine ? [defectLine] : []),
  ].join('\n');

  return { severity: 'warn', message };
}
