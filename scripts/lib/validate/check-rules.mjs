#!/usr/bin/env node
// check-rules.mjs — Validate .claude/rules/*.md files against two invariants:
//
// (1) AUTO-GENERATED rules (`auto-generated: true` — FA4 #697 backstop for the
//     reconcile emitter brandmauer in scripts/lib/reconcile/emitter.mjs ~line
//     193). HARD-FAIL, exit-code-driving:
//       (a) never-always-on: must have at least one activation axis — a
//           non-empty `globs` array OR a `host-class` key. A rule that is
//           always-on (globs null/absent AND no host-class) is a budget
//           violation (#668 / #687).
//           SPECIAL CASE (#892 QA Defect — the auto-generated twin of #880 QA
//           Defect 1) — an EMPTY `globs` array (`globs: []`) is NOT the
//           "no axis" case and is NOT always-on: rule-loader.mjs
//           unconditionally excludes on `globs.length === 0` (~line 526)
//           AFTER gating runs, so the rule never loads in ANY context — even
//           one where a co-present `host-class:` key would otherwise satisfy
//           the axis. Before #892 this branch silently mis-reported (or, when
//           paired with `host-class:`, silently missed entirely) this case
//           under the inverted "always-on" FAIL message. This gets its own
//           distinct FAIL, fired independent of `host-class`, because
//           `host-class` cannot rescue an empty globs array from that
//           unconditional exclusion — mirrors the handwritten branch's
//           identical `hasEmptyGlobs` fix below.
//       (b) learning-key must be present (traceability back to the emitter source).
//       (c) expires-at must be present (auto-generated rules must have a TTL).
//     Plus, ahead of the auto/handwritten split and binding on EVERY rule file
//     regardless of cohort:
//       (d) the frontmatter must PARSE (#1015). An unparseable file used to be
//           skipped as "not auditable"; rule-loader.mjs, however, treats a
//           parse error as always-on with empty meta, so the skipped file is
//           exactly the one that loads everywhere and clears every gate. See
//           the inline rationale at the parse site below.
//       (e) HARNESS-PARITY (#1108): a rule that expresses a path restriction
//           must express it in `paths:`, because `paths:` is the ONLY key
//           Claude Code's own rule loader reads. Its documentation
//           (code.claude.com/docs/en/memory § "Path-specific rules") is
//           explicit: rules are scoped "using YAML frontmatter with the
//           `paths` field", and "rules without a `paths` field are loaded
//           unconditionally and apply to all files". `globs:` is the CURSOR
//           field name. A `globs:`-only rule is therefore scoped for
//           rule-loader.mjs (#795 alias) and for Cursor, yet ALWAYS-ON for
//           Claude Code — the rule *looks* scoped everywhere it is inspected
//           and is silently loaded everywhere it is used.
//           Measured 2026-08-22 before the fix: 16 of 31 rule files carried
//           `globs:` and 0 carried `paths:`, so all 31 loaded unconditionally
//           — 186,993 bytes ≈ 46,700 tokens per dispatch, 72,195 of them
//           unwanted (testing.md alone is 36,431 bytes and carries
//           `tier: wave-only`, i.e. is explicitly meant to be conditional).
//           This check is the recurrence guard for that fix, not the fix.
//           It is formulated as a PARITY check rather than a presence check,
//           which folds two defects into one invariant: the rule must load in
//           the SAME contexts under Claude Code's loader (which reads
//           `paths:`, treating absence as always-on) as under rule-loader.mjs
//           (which reads `globs:` and falls back to `paths:` — #795, globs
//           wins). Two ways to violate it:
//             - `globs:` present and non-empty, `paths:` ABSENT → always-on
//               in Claude Code.
//             - both present with DIFFERENT pattern sets → Claude Code scopes
//               on one list, rule-loader.mjs and Cursor on the other.
//           Order and duplicates are irrelevant (a glob list is matched
//           any-of), so the comparison is over the sorted unique set.
//           NOT flagged: `paths:` alone. It is the form the native
//           documentation prescribes and the form the primary downstream
//           consumer uses exclusively (projects-baseline: 26 rule files, all
//           `paths:`, 0 `globs:` — rule-loader.mjs module doc). The
//           `globs:`-is-canonical preference for VENDORED rules is a separate,
//           warn-level concern already owned by
//           scripts/lib/validate-vendored-rules.mjs (~:289, issue #742) and is
//           deliberately not duplicated here.
//           NOT flagged either: an EMPTY `globs: []`. That shape is already
//           owned — with an accurate, opposite message — by the dedicated
//           empty-globs branches below (#880 QA Defect 1 / #892), and firing
//           a second, contradictory-sounding finding ("never loads" beside
//           "always-on in Claude Code") on one file is exactly the confusion
//           those fixes went out of their way to remove. The parity check
//           therefore requires a NON-EMPTY `globs:` list; populating it is the
//           prescribed remedy for `globs: []`, at which point parity binds.
//
// (2) HANDWRITTEN rules (no `auto-generated: true` — #880 FA5, WARN-only,
//     NEVER affects the exit code). The auto-generated brandmauer above only
//     binds the MACHINE author (the reconcile emitter) — a human authoring a
//     rule file by hand bypasses it entirely. #880's finding: several
//     handwritten rules in this repo carry only a `tier:` axis (no
//     `globs`/`paths`/`host-class`) and no periodic-review marker, and nothing
//     in the system ever prompts a re-review. This second, symmetric check
//     extends the SAME invariant shape to handwritten rules, starting in WARN
//     mode — a hard gate is a later, deliberate step (see
//     docs/rule-authoring.md § "Handwritten Rule Review Date (#880 FA5)").
//     A handwritten rule is flagged when it is missing EITHER:
//       (a) an activation axis — a non-empty `globs`/`paths` array, a
//           `host-class` key, OR a `tier` key. `tier:` counts: rule-loader.mjs
//           `applyGates()` honours it as a real load-context gate (excludes
//           `coordinator-only` rules from wave context and vice versa) — see
//           docs/rule-authoring.md § "Tier gating (issue #692)".
//           SPECIAL CASE — an EMPTY `globs`/`paths` array (`globs: []`) is
//           NOT the "no axis" case and is NOT always-on: rule-loader.mjs
//           unconditionally excludes on `globs.length === 0` AFTER gating
//           runs, so the rule never loads in any context — even one where a
//           co-present `tier:`/`host-class:` key would otherwise satisfy the
//           axis. This branch gets its own distinct WARN, fired independent
//           of `tier`/`host-class`, because neither can rescue an empty
//           globs array from that unconditional exclusion (#880 QA Defect 1
//           fix — see the FAIL/WARN inversion this replaced in git blame).
//       (b) a `review-date` key (ISO 8601 date) — a periodic-review marker,
//           DELIBERATELY DISTINCT from `expires-at`. rule-loader.mjs treats
//           `expires-at` as a live EXPIRY gate (`applyGates`): reusing it on a
//           hand-authored always-on safety rule (e.g. security.md) would make
//           that rule silently stop loading the day the date passes — an
//           unacceptable behaviour change for a metadata-only review marker.
//           `review-date` is inert: it is NOT in rule-loader.mjs's
//           SCALAR_META_KEYS allowlist (contract-locked, not modified by
//           #880), so `parseGlobsFrontmatter()` never surfaces it and
//           `loadApplicableRules()` never gates on it — it is parsed only by
//           THIS script, via the local `hasFrontmatterKey()` helper below.
//
// Usage: check-rules.mjs <plugin-root>
// Outputs lines of the form "  PASS: ..." / "  FAIL: ..." / "  WARN: ...".
// Exit 0 = all AUTO-GENERATED invariants plus the two cohort-independent
// invariants (d) frontmatter-parses and (e) harness-parity are satisfied (WARN
// lines from the handwritten check NEVER affect the exit code); exit 1 = at
// least one FAIL.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGlobsFrontmatter } from '../rule-loader.mjs';

const [, , pluginRoot] = process.argv;

if (!pluginRoot) {
  console.error('Usage: check-rules.mjs <plugin-root>');
  process.exit(1);
}

const RULES_DIR = join(pluginRoot, '.claude', 'rules');

let passed = 0;
let failed = 0;
let warned = 0;

function pass(msg) {
  console.log(`  PASS: ${msg}`);
  passed++;
}

function fail(msg) {
  console.log(`  FAIL: ${msg}`);
  failed++;
}

function warn(msg) {
  console.log(`  WARN: ${msg}`);
  warned++;
}

// ---------------------------------------------------------------------------
// Local frontmatter helper for the `review-date` key (#880 FA5). Deliberately
// NOT routed through rule-loader.mjs's `parseGlobsFrontmatter()` — that
// module is contract-locked and its SCALAR_META_KEYS allowlist does not (and
// should not) recognise `review-date`, per the module-doc rationale above.
// This is a minimal, self-contained frontmatter-block scan mirroring
// rule-loader.mjs's own FRONTMATTER_RE, not a general YAML parser.
// ---------------------------------------------------------------------------
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Returns true when the frontmatter block of `contents` contains a top-level
 * `key:` line carrying a non-empty value.
 *
 * @param {string} contents - raw file contents
 * @param {string} key - frontmatter key name (no colon)
 * @returns {boolean}
 */
function hasFrontmatterKey(contents, key) {
  const match = FRONTMATTER_RE.exec(contents);
  if (!match) return false;
  const keyRe = new RegExp(`^${key}:\\s*(\\S.*)?$`, 'm');
  const keyMatch = keyRe.exec(match[1]);
  return Boolean(keyMatch && keyMatch[1] && keyMatch[1].trim() !== '');
}

// ---------------------------------------------------------------------------
// Per-key list access for the harness-parity check (#1108).
//
// `parseGlobsFrontmatter()` deliberately COLLAPSES `globs:` and `paths:` into
// one value ("callers never see which key produced the value" — rule-loader.mjs
// module doc, #795 precedence). The parity check needs both lists separately,
// and re-deriving list parsing here would be a second frontmatter parser — the
// exact drift class that produced #840. So instead of re-parsing, the OTHER key
// is MASKED to a name the parser ignores (any key that is neither globs/paths
// nor in SCALAR_META_KEYS is dropped without error, and its indented `  - x`
// continuation lines are skipped as "another block's continuation"), and the
// SAME parser then returns the surviving key's list verbatim — flow style,
// block style, quote stripping and provenance-header tolerance included.
//
// Masking cannot make a parseable file unparseable: it renames a key, so the
// line keeps its colon. Callers reach this only for files that already parsed.
// ---------------------------------------------------------------------------
const MASKED_KEY_PREFIX = 'x-check-rules-masked-';

/**
 * Returns the value of exactly ONE of the two scope keys, ignoring the other —
 * `null` when that key is absent, `[]` when present but empty.
 *
 * @param {string} contents - raw file contents (must already parse)
 * @param {'globs'|'paths'} key - the key whose list to return
 * @returns {string[] | null}
 */
function scopeKeyValue(contents, key) {
  const other = key === 'globs' ? 'paths' : 'globs';
  const masked = contents.replace(
    new RegExp(`^${other}:`, 'gm'),
    `${MASKED_KEY_PREFIX}${other}:`,
  );
  return parseGlobsFrontmatter(masked).globs;
}

/** Sorted, de-duplicated copy — glob lists are matched any-of, so neither
 * order nor repetition changes which files a rule applies to. */
function normalizePatterns(list) {
  return [...new Set(list)].sort();
}

/**
 * Harness-parity verdict for one rule file (#1108) — see module doc (e).
 *
 * @param {string} contents - raw file contents (must already parse)
 * @returns {{ ok: true } | { ok: false, kind: 'missing-paths'|'divergent', globs: string[], paths: string[] | null }}
 */
function checkHarnessParity(contents) {
  const globs = scopeKeyValue(contents, 'globs');
  // Only a NON-EMPTY globs list expresses a path restriction. Absent globs →
  // whatever `paths:` says is what every loader sees. Empty globs → owned by
  // the dedicated empty-globs branches, which prescribe populating it.
  if (!Array.isArray(globs) || globs.length === 0) return { ok: true };

  const paths = scopeKeyValue(contents, 'paths');
  if (paths === null) return { ok: false, kind: 'missing-paths', globs, paths };

  const same =
    JSON.stringify(normalizePatterns(globs)) === JSON.stringify(normalizePatterns(paths));
  return same ? { ok: true } : { ok: false, kind: 'divergent', globs, paths };
}

// ============================================================================
// Check: .claude/rules/ rule invariants
// ============================================================================
console.log('--- Check: .claude/rules/ auto-generated rule invariants ---');

// If the rules directory doesn't exist, there's nothing to validate — all pass.
if (!existsSync(RULES_DIR)) {
  pass('no .claude/rules/ directory found — nothing to validate');
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed, ${warned} warned`);
  process.exit(0);
}

let mdFiles;
try {
  mdFiles = readdirSync(RULES_DIR).filter((f) => f.endsWith('.md'));
} catch (err) {
  console.error(`  tool-error: cannot read rules directory: ${err.message}`);
  process.exit(2);
}

if (mdFiles.length === 0) {
  pass('no .md rule files found — nothing to validate');
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed, ${warned} warned`);
  process.exit(0);
}

// Parse every rule file once, splitting into the auto-generated and
// handwritten cohorts. Malformed frontmatter → a cohort-independent hard FAIL
// (#1015). It was previously skipped from BOTH checks ("neither PASS'd nor
// FAIL'd"); see the parse site below for why that abstention was a blind spot.
const autoGeneratedEntries = [];
const handwrittenEntries = [];

for (const name of mdFiles.sort()) {
  const filePath = join(RULES_DIR, name);
  let contents;
  try {
    contents = readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`  tool-error: cannot read ${filePath}: ${err.message}`);
    continue;
  }

  let parsed;
  try {
    parsed = parseGlobsFrontmatter(contents);
  } catch (err) {
    // MALFORMED FRONTMATTER IS A HARD FAIL (#1015) — it used to `continue`.
    //
    // The skip looked like a neutral abstention ("not auditable by either
    // branch") but was in fact this validator's single blind spot, and it was
    // blind to precisely the worst state. rule-loader.mjs catches the SAME
    // throw (~:500-507), falls back to `globs = null, meta = {}, parseError =
    // true`, and then (~:519-530) pushes the entry with `alwaysOn: true`.
    // Empty meta means applyGates() has nothing to gate on, so the file also
    // clears tier/host-class/mode/EXPIRY gating by design ("a rule is never
    // silently dropped"). Net effect: the one file this branch declined to
    // audit is the one file the loader loads ALWAYS-ON, in every context,
    // forever — the exact state the never-always-on invariant (#668/#687)
    // exists to forbid, and the landing state of a frontmatter-injection whose
    // payload happens to be colon-less (an injected `\n` + a line with no `:`).
    // Unparseable therefore means UNSAFE, not "unknown": FAIL, never skip.
    fail(
      `.claude/rules/${name} — frontmatter does not parse (${err.message}) — rule-loader.mjs treats a parse ` +
        'error as ALWAYS-ON with EMPTY meta, so this file loads in every context and clears every gate ' +
        '(no expiry, no tier, no host-class, no mode). Fix the frontmatter or remove the file.',
    );
    continue;
  }

  const { globs, meta } = parsed;
  const rel = `.claude/rules/${name}`;

  // (e) HARNESS-PARITY (#1108) — cohort-independent, like the parse check
  // above: `paths:` is the only scope key Claude Code's own loader reads, so a
  // `globs:`-only or divergently-scoped rule loads differently there than it
  // does under rule-loader.mjs. Emitted here, in file order, and recorded on
  // the entry so the cohort branches below suppress their PASS line — a file
  // must never both PASS and FAIL.
  const parity = checkHarnessParity(contents);
  if (!parity.ok && parity.kind === 'missing-paths') {
    fail(
      `${rel} — declares globs: (${parity.globs.length} pattern(s)) but no paths: — Claude Code's native rule ` +
        'loader reads ONLY the `paths` frontmatter field and treats a rule without it as unconditional ' +
        '("rules without a paths field are loaded unconditionally and apply to all files" — ' +
        'code.claude.com/docs/en/memory § Path-specific rules). `globs:` is the Cursor field name, so this rule ' +
        'is scoped for rule-loader.mjs and Cursor but loads ALWAYS-ON in Claude Code — a silent instruction-budget ' +
        'failure (#1108). Add a paths: key carrying the same patterns as globs: (keep globs: — it stays the ' +
        'canonical form for vendored rules, validate-vendored-rules.mjs #742).',
    );
  } else if (!parity.ok && parity.kind === 'divergent') {
    fail(
      `${rel} — globs: and paths: declare DIFFERENT pattern sets (globs: ${JSON.stringify(parity.globs)} vs ` +
        `paths: ${JSON.stringify(parity.paths)}) — Claude Code's native loader scopes on paths:, while ` +
        'rule-loader.mjs and Cursor scope on globs: (globs: wins silently when both are present, #795). The rule ' +
        'therefore loads in different contexts on different harnesses (#1108). Make the two lists carry the same ' +
        'patterns — order and duplicates are irrelevant.',
    );
  }

  if (meta['auto-generated'] === true) {
    autoGeneratedEntries.push({ rel, globs, meta, parityOk: parity.ok });
  } else {
    handwrittenEntries.push({ rel, globs, meta, contents, parityOk: parity.ok });
  }
}

// ---------------------------------------------------------------------------
// Auto-generated branch (FA4 #697) — UNCHANGED behaviour, hard-fail.
// ---------------------------------------------------------------------------
for (const { rel, globs, meta, parityOk } of autoGeneratedEntries) {
  // (a) never-always-on: must have at least one activation axis.
  // globs is one of: null (no frontmatter / no globs key), [] (key present
  // but EMPTY — the #892 QA-Defect special case, see module doc), or a
  // populated array. host-class absent → no host-class axis.
  const hasEmptyGlobs = Array.isArray(globs) && globs.length === 0;
  const hasGlobs = Array.isArray(globs) && globs.length > 0;
  const hasHostClass = Object.prototype.hasOwnProperty.call(meta, 'host-class');

  if (hasEmptyGlobs) {
    // An empty globs array is NOT "no axis at all" and is NOT "always-on" —
    // it is the opposite: rule-loader.mjs's unconditional globs.length === 0
    // exclusion (~line 526) fires AFTER gating, so this rule never loads in
    // ANY context, even one that also carries a host-class: key. Fire
    // independent of hasHostClass — host-class cannot rescue an empty globs
    // array from that unconditional exclusion (#892 QA Defect fix — see the
    // module doc for the full rule-loader.mjs citation and the identical
    // handwritten-branch fix this mirrors, #880 QA Defect 1).
    fail(
      `${rel} — auto-generated rule has an empty globs array (globs: []) — this rule matches NOTHING and never ` +
        'loads in ANY context, even one that also carries a host-class: key (rule-loader.mjs excludes on ' +
        'globs.length === 0 unconditionally, after gating runs). This is the OPPOSITE of "always-on" but still ' +
        'violates the never-always-on invariant (#668/#687) because the rule never activates at all. Populate ' +
        'globs: with real patterns or remove the file.',
    );
  } else if (!hasGlobs && !hasHostClass) {
    fail(
      `${rel} — auto-generated rule is always-on (no activation axis: globs is absent AND host-class absent). ` +
        'This violates the never-always-on invariant (#668/#687). Add a globs filter or host-class axis.',
    );
  }

  // (b) learning-key must be present.
  if (!Object.prototype.hasOwnProperty.call(meta, 'learning-key')) {
    fail(`${rel} — auto-generated rule is missing required frontmatter key: learning-key`);
  }

  // (c) expires-at must be present.
  if (!Object.prototype.hasOwnProperty.call(meta, 'expires-at')) {
    fail(`${rel} — auto-generated rule is missing required frontmatter key: expires-at`);
  }

  // Emit a PASS line only when the rule satisfies ALL three invariants: a
  // genuine activation axis (a NON-EMPTY globs array, or host-class — NEVER
  // an empty globs array, which is dead-not-passing regardless of host-class)
  // AND learning-key AND expires-at. When any failed, the FAIL line(s) above
  // already emitted.
  // `parityOk` joins the conjunction for the same reason `hasEmptyGlobs` does:
  // its FAIL already emitted above, and a file must never both PASS and FAIL.
  const lkOk = Object.prototype.hasOwnProperty.call(meta, 'learning-key');
  const eaOk = Object.prototype.hasOwnProperty.call(meta, 'expires-at');
  if (!hasEmptyGlobs && (hasGlobs || hasHostClass) && lkOk && eaOk && parityOk) {
    pass(`${rel} — auto-generated rule satisfies all invariants`);
  }
}

if (autoGeneratedEntries.length === 0) {
  pass('no auto-generated rules found — nothing to validate');
}

// ---------------------------------------------------------------------------
// Handwritten branch (#880 FA5) — WARN-only, non-fatal, never affects exit code.
// ---------------------------------------------------------------------------
console.log('');
console.log(
  '--- Check: .claude/rules/ handwritten-rule activation + review-date (warn mode, #880) ---',
);

for (const { rel, globs, meta, contents, parityOk } of handwrittenEntries) {
  // `globs` (the merged globs/paths value from parseGlobsFrontmatter — #795
  // alias, `globs:` wins when both are present) is one of:
  //   - null                     → neither key present
  //   - [] (Array, length 0)     → key present but EMPTY
  //   - [...] (Array, length>0)  → key present and populated
  const hasEmptyGlobs = Array.isArray(globs) && globs.length === 0;
  const hasGlobsAxis = Array.isArray(globs) && globs.length > 0;
  const hasHostClassAxis = Object.prototype.hasOwnProperty.call(meta, 'host-class');
  const hasTierAxis = Object.prototype.hasOwnProperty.call(meta, 'tier');
  const hasAxis = hasGlobsAxis || hasHostClassAxis || hasTierAxis;
  const hasReviewDate = hasFrontmatterKey(contents, 'review-date');

  if (hasEmptyGlobs) {
    // An empty globs/paths array is NOT the same condition as "no axis at
    // all", and it is NOT "always-on" — it is the opposite. Per
    // rule-loader.mjs's loadApplicableRules() (~line 526): once frontmatter
    // parses, tier/host-class/mode/expiry gating (applyGates) runs FIRST and
    // can only ADD exclusions; if the rule survives that gating, the loader
    // THEN unconditionally excludes it when `globs.length === 0` ("matches
    // nothing (intentionally scoped out)") — this check fires regardless of
    // whether a tier:/host-class: key would otherwise have satisfied the
    // axis requirement. So a rule with `globs: []` never loads in ANY
    // context, even one paired with `tier: always`. Always warn with the
    // accurate "dead rule" message here, independent of `hasAxis` — a
    // co-present tier:/host-class: key cannot rescue an empty globs array
    // from this unconditional exclusion, so it must not suppress the warning
    // either (#880 QA Defect 1 fix).
    warn(
      `${rel} — handwritten rule has an empty globs/paths array (globs: [] or paths: []) — this rule matches ` +
        'NOTHING and never loads in ANY context, even one that also carries a tier:/host-class: key ' +
        '(rule-loader.mjs excludes on globs.length === 0 unconditionally, after gating runs). This is the ' +
        'OPPOSITE of "always-on". If this is a deliberately disabled rule, consider removing the file instead; ' +
        'otherwise populate globs:/paths: with real patterns.',
    );
  } else if (!hasAxis) {
    warn(
      `${rel} — handwritten rule has no activation axis (globs/paths/host-class/tier all absent) — loads ` +
        'always-on in every context. Not a build failure yet (warn mode, #880); add a tier: or globs: axis ' +
        'if this rule should be scoped.',
    );
  }

  if (!hasReviewDate) {
    warn(
      `${rel} — handwritten rule is missing a review-date (no periodic-review marker). ` +
        'See docs/rule-authoring.md § "Handwritten Rule Review Date (#880 FA5)".',
    );
  }

  // `parityOk` joins the conjunction for the same reason `hasEmptyGlobs` does
  // (#1108): its FAIL already emitted in the parse loop, and a file must never
  // both PASS and FAIL. This is the one place a handwritten rule's PASS is
  // withheld for a HARD-fail reason — the parity invariant is cohort-
  // independent by construction, so it is not part of this branch's
  // deliberately warn-only posture.
  if (!hasEmptyGlobs && hasAxis && hasReviewDate && parityOk) {
    pass(`${rel} — handwritten rule has an activation axis and a review-date`);
  }
}

if (handwrittenEntries.length === 0) {
  // Deliberately NOT routed through pass() — this is bookkeeping, not an
  // audited invariant, and must not inflate the `passed` count that
  // auto-generated-only fixtures assert an exact value against.
  console.log('  (no handwritten rules found — nothing to check)');
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${warned} warned`);

process.exit(failed > 0 ? 1 : 0);
