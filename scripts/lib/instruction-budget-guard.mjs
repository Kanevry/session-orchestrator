/**
 * instruction-budget-guard.mjs — #687 / #877 (FA2)
 *
 * Lightweight directive-budget guard for always-on `.claude/rules/*.md`.
 *
 * Sums the always-on directive count across the rule files that the
 * rule-loader classifies as always-on (no `globs:` frontmatter, and no
 * `paths:` alias either — issue #795: `paths:`-scoped rules are NOT
 * always-on and must not inflate this count) and warns when the total
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
 * Cross-references:
 * - "2026-06-20 instruction-budget audit" (#668 / #687; archived in the private Meta-Vault)
 * - scripts/lib/rule-loader.mjs (always-on classification + tier-gate SSOT)
 * - scripts/lib/qg-command-drift-banner.mjs (banner-shape convention)
 * - scripts/lib/ci-status-banner.mjs (never-throws convention)
 * - issue #877 (FA2 — byte dimension + surface split)
 * - SISTER GUARD / KNOWN DIVERGENCE (#906.3): the projects-baseline repo
 *   (resolved via `plan-baseline-path` / owner.yaml `baseline-path`) ships
 *   `scripts/check-instruction-budget.sh` under rule CCU-009c. It measures the
 *   SAME `.claude/rules/*.md` corpus and its total is NOT comparable to ours —
 *   it diverges on BOTH axes, in OPPOSITE directions:
 *     (a) MEMBERSHIP — it classifies a file as path-scoped only on a `paths:`
 *         frontmatter key, so this repo's `globs:`-scoped rules stay inside ITS
 *         always-on set: 26 files where `loadApplicableRules` yields 12 here.
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
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadApplicableRules, parseGlobsFrontmatter } from './rule-loader.mjs';

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
 * The CONCLUSION stands, on a wider base: firing rate is 0 of 3, not 0 of 2 —
 * the guard would not have fired at any of the three states this repo has
 * recorded. What does NOT stand is the headroom claim it rested on. The live
 * corpus is **2,427 B** below the historical peak, not 13,649 B: a single
 * /reconcile wave of the size this one just absorbed puts the generated corpus
 * back at its worst recorded state, and the ceiling still would not notice.
 * "Decorative" is therefore an understatement of the gap, not an overstatement
 * — which strengthens the case for the operator decision this block defers,
 * and changes none of its terms. Still tracked rather than silently patched:
 * raising OR lowering a threshold inside a population fix is exactly the
 * conflation this comment exists to end.
 */
export const DEFAULT_GENERATED_BYTE_CEILING = 124000;

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
 * {@link DEFAULT_GENERATED_BYTE_CEILING} does NOT currently meet (0 of 3).
 * This is also why it is not re-derived upward off the live number: a ceiling
 * placed above 134,969 would be silent on all three states, i.e. the same
 * unfalsifiable shape, obtained by the threshold-patch move
 * `development.md` § Guard & Threshold Design forbids.
 *
 * ⚠ DELIBERATELY NOT FOLDED INTO `overBudget`. `overPathScopedBudget` is
 * computed, returned, and named — but it does not flip the aggregate verdict
 * and does not by itself raise the session-start banner. Two reasons, and both
 * are conditions, not preferences:
 *
 *  1. The corpus is over this ceiling TODAY. Folding it in would turn the
 *     aggregate verdict red on the current tree, which `tests/rules/` asserts
 *     against — the exceedance would be reported as a code defect when it is
 *     a corpus fact.
 *  2. Whether the CORPUS must shrink or the CEILING must move is an operator
 *     decision. Making the guard block on it would decide that question by
 *     omission, which is the same conflation the #1297 block above ends.
 *
 * The fold-in becomes correct as soon as EITHER holds: the path-scoped corpus
 * drops back under 124,000 (then the flag is a live, silent-today guard and
 * folding it in costs nothing), OR the operator sets a deliberate ceiling for
 * this population via `path-scoped-byte-ceiling` in Session Config. Until one
 * of those, the honest state is measured-and-visible, not blocking.
 *
 * Re-derive (never merely raise) with
 * `computeInstructionBudget({repoRoot}).bySurface.pathScoped`.
 */
export const DEFAULT_PATH_SCOPED_BYTE_CEILING = 124000;

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
 * @param {string} repoRoot
 * @returns {{ enabled: boolean, ceiling: number, 'byte-ceiling': number, mode: 'warn' | 'off' }}
 */
export function loadInstructionBudgetConfig(repoRoot) {
  const fallback = {
    enabled: true,
    ceiling: DEFAULT_CEILING,
    'byte-ceiling': DEFAULT_BYTE_CEILING,
    mode: 'warn',
  };

  let content = null;
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const file = join(repoRoot ?? process.cwd(), name);
    try {
      if (existsSync(file)) {
        content = readFileSync(file, 'utf8');
        break;
      }
    } catch {
      // unreadable — try the next candidate
    }
  }
  if (typeof content !== 'string') return fallback;

  try {
    return _parseInstructionBudget(content, fallback);
  } catch {
    return fallback;
  }
}

/**
 * Parse the `instruction-budget:` block out of raw markdown content.
 * Independent helper (testable without disk IO).
 *
 * A `defaults` object that predates the `byte-ceiling` key (#931a) is tolerated:
 * the missing entry falls back to `DEFAULT_BYTE_CEILING` rather than yielding
 * `undefined`, so an older caller can never disable the byte axis by omission.
 *
 * @param {string} content - full file contents
 * @param {{ enabled: boolean, ceiling: number, 'byte-ceiling'?: number, mode: 'warn' | 'off' }} [defaults]
 * @returns {{ enabled: boolean, ceiling: number, 'byte-ceiling': number, mode: 'warn' | 'off' }}
 */
export function _parseInstructionBudget(content, defaults) {
  const base = defaults ?? {
    enabled: true,
    ceiling: DEFAULT_CEILING,
    'byte-ceiling': DEFAULT_BYTE_CEILING,
    mode: 'warn',
  };
  const baseByteCeiling =
    typeof base['byte-ceiling'] === 'number' ? base['byte-ceiling'] : DEFAULT_BYTE_CEILING;
  if (typeof content !== 'string' || content === '') {
    return { ...base, 'byte-ceiling': baseByteCeiling };
  }

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  let keyIndent = 0;
  const blockLines = [];

  for (const rawLine of lines) {
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

  if (blockLines.length === 0) return { ...base, 'byte-ceiling': baseByteCeiling };

  let enabled = base.enabled;
  let ceiling = base.ceiling;
  let byteCeiling = baseByteCeiling;
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
          if (Number.isFinite(n) && n > 0) ceiling = n;
        }
        break;
      }
      case 'byte-ceiling': {
        // Same shape as `ceiling` above — integer, strictly positive, malformed
        // or non-positive values silently keep the default (#931a).
        if (/^-?\d+$/.test(v)) {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) byteCeiling = n;
        }
        break;
      }
      case 'mode':
        // Only `off` silences; any other value (incl. `warn`) surfaces the banner.
        mode = v.toLowerCase() === 'off' ? 'off' : 'warn';
        break;
    }
  }

  return { enabled, ceiling, 'byte-ceiling': byteCeiling, mode };
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
function isMachineGeneratedRule(meta) {
  if (!meta || typeof meta !== 'object') return false;
  return (
    meta['auto-generated'] === true ||
    Object.prototype.hasOwnProperty.call(meta, 'learning-key') ||
    Object.prototype.hasOwnProperty.call(meta, 'expires-at')
  );
}

/**
 * Single-pass scan of `.claude/rules/*.md` producing the TWO corpus measures
 * this guard's third axis needs, which #1297 proved are NOT the same set:
 *
 *   - `generated`  — rules carrying a reconciliation provenance marker
 *     ({@link isMachineGeneratedRule}). This is the population
 *     {@link DEFAULT_GENERATED_BYTE_CEILING} is a ceiling FOR: the thing that
 *     grows on its own, without anyone deciding to add a rule.
 *   - `pathScoped` — every rule with `globs:` (or its `paths:` alias, #795),
 *     i.e. the complement of the always-on set the three tier surfaces measure.
 *     A real quantity, and the one this axis USED to report under the name
 *     `generated` — see the ceiling's docblock for what that cost.
 *
 * The two overlap but neither contains the other by construction: a
 * hand-written rule can be path-scoped (3 of them are here), and a generated
 * rule could in principle carry a `host-class` activation axis instead of
 * `globs:`.
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
    let globs;
    let meta;
    try {
      ({ globs, meta } = parseGlobsFrontmatter(content));
    } catch {
      continue;
    }
    const bytes = countContentBytes(content);
    if (isMachineGeneratedRule(meta)) {
      generated.files += 1;
      generated.bytes += bytes;
    }
    // `globs === null` → always-on, already counted by the tier surfaces.
    if (globs !== null) {
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
 * }}
 *   perFile is sorted DESC by count. On missing/unreadable dir →
 *   { totalDirectives: 0, totalBytes: 0, perFile: [], ceiling, byteCeiling,
 *     overDirectiveBudget: false, overByteBudget: false, overBudget: false,
 *     severity: 'ok', bySurface: { coordinator: 0, wave: 0, always: 0,
 *     generated: {bytes:0,files:0}, pathScoped: {bytes:0,files:0} } }.
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
 *   this to choose its Top-files sort key).
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
 *     bySurface.pathScoped === {bytes, files} of every rule with `globs:`
 *       (or its `paths:` alias) — the complement of the always-on set, and
 *       the number an operator reproduces from `ls .claude/rules/` (HR-106).
 *       Judged against {@link DEFAULT_PATH_SCOPED_BYTE_CEILING} into
 *       `overPathScopedBudget`, which is REPORTED but deliberately not an
 *       `overBudget` term (see that constant's docblock).
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
    // PRIMARY totals (see doc above).
    allEntries = loadApplicableRules({ rulesDir, scopePaths: [] });
    waveEntries = loadApplicableRules({ rulesDir, scopePaths: [], context: 'wave' });
    coordinatorEntries = loadApplicableRules({ rulesDir, scopePaths: [], context: 'coordinator' });
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
    // `globs:` would be always-on and therefore counted in both.
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
  // Fourth axis, same strict `>` boundary. NOT an `overBudget` term — see
  // DEFAULT_PATH_SCOPED_BYTE_CEILING's docblock for the two conditions under
  // which folding it in becomes correct. It is measured and reported so the
  // exceedance is falsifiable (HR-105) without deciding, by omission, whether
  // the corpus or the ceiling has to move.
  const overPathScopedBudget = bySurface.pathScoped.bytes > pathScopedByteCeiling;
  const overBudget = overDirectiveBudget || overByteBudget || overGeneratedBudget;

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
  };
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
 *     'byte-ceiling':114000, mode:warn}` so the probe still computes (mirrors
 *     the other probes).
 * Never throws.
 *
 * The message names WHICH axis breached (#931a) — a banner that only said
 * "over budget" would leave the operator guessing whether to prune bullets or
 * prose. It stays at three lines because it renders at every session start.
 *
 * @param {object} [opts]  forwarded to computeInstructionBudget.
 * @param {string} [opts.repoRoot] project root for the config read.
 * @param {number} [opts.ceiling]  explicit directive-ceiling override (wins over config).
 * @param {number} [opts.byteCeiling] explicit byte-ceiling override (wins over config).
 * @param {number} [opts.pathScopedByteCeiling] explicit path-scoped-ceiling override.
 * @returns {{ severity: 'warn', message: string } | null}
 *   null when disabled / off / every BLOCKING axis at-or-under ceiling OR on
 *   any read failure. The path-scoped axis is not a blocking axis: it appends
 *   a `(not blocking)` clause to a banner some other axis already raised, and
 *   never raises one on its own (see DEFAULT_PATH_SCOPED_BYTE_CEILING).
 */
export function checkInstructionBudget(opts = {}) {
  let cfg;
  try {
    cfg = loadInstructionBudgetConfig(opts.repoRoot);
  } catch {
    cfg = {
      enabled: true,
      ceiling: DEFAULT_CEILING,
      'byte-ceiling': DEFAULT_BYTE_CEILING,
      'generated-byte-ceiling': DEFAULT_GENERATED_BYTE_CEILING,
      mode: 'warn',
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

  if (!budget || !budget.overBudget) return null;

  // Name only the breached axes — listing a healthy axis would pad the line
  // without telling the operator anything they must act on.
  const axes = [];
  if (budget.overDirectiveBudget) {
    axes.push(`directives ${budget.totalDirectives} > ${budget.ceiling}`);
  }
  if (budget.overByteBudget) {
    axes.push(`bytes ${budget.totalBytes} > ${budget.byteCeiling}`);
  }
  if (budget.overGeneratedBudget) {
    // Reported with its FILE COUNT, because the actionable lever on this axis
    // is consolidating files, not trimming prose inside them (HR-106: the
    // banner reports the number the rule judged).
    axes.push(
      `generated rules ${budget.bySurface.generated.bytes} B over ` +
        `${budget.bySurface.generated.files} files > ${budget.generatedByteCeiling} B`,
    );
  }
  // Reported only ALONGSIDE a breach that already raised this banner — never
  // as its trigger. `overPathScopedBudget` is true on the current corpus, so
  // making it a trigger would put this line on every single session start,
  // which `.claude/rules/host-resources.md` HR-101 calls a broken instrument
  // rather than a warning. Named `(not blocking)` so the operator can tell it
  // apart from the axes that did decide the verdict.
  if (budget.overPathScopedBudget) {
    axes.push(
      `path-scoped rules ${budget.bySurface.pathScoped.bytes} B over ` +
        `${budget.bySurface.pathScoped.files} files > ${budget.pathScopedByteCeiling} B (not blocking)`,
    );
  }

  // `perFile` arrives sorted DESC by directive count. When ONLY the byte axis
  // broke, that ordering points at the wrong files — re-sort by bytes so the
  // Top-files line lists the ones actually responsible for the breach.
  const ranked =
    budget.overByteBudget && !budget.overDirectiveBudget
      ? [...budget.perFile].sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file))
      : budget.perFile;

  const top = ranked
    .slice(0, 3)
    .map((f) => `${f.file} (${f.count} dir, ${f.bytes} B)`)
    .join(', ');

  const message = [
    `⚠ Instruction budget over — ${axes.join(' · ')} across ${budget.perFile.length} always-on rules.`,
    `  Top files: ${top}`,
    '  See the instruction-budget audit (#687; archived in the private Meta-Vault) for the prune/demote list.',
  ].join('\n');

  return { severity: 'warn', message };
}
