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
// Exit 0 = all AUTO-GENERATED invariants satisfied (WARN lines from the
// handwritten check NEVER affect the exit code); exit 1 = at least one
// auto-generated FAIL.

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
// handwritten cohorts. Malformed frontmatter → skipped from BOTH checks
// (matches pre-#880 behaviour: a rule whose frontmatter cannot be parsed is
// neither PASS'd nor FAIL'd).
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
  } catch {
    // Malformed frontmatter — not auditable by either branch, skip.
    continue;
  }

  const { globs, meta } = parsed;
  const rel = `.claude/rules/${name}`;

  if (meta['auto-generated'] === true) {
    autoGeneratedEntries.push({ rel, globs, meta });
  } else {
    handwrittenEntries.push({ rel, globs, meta, contents });
  }
}

// ---------------------------------------------------------------------------
// Auto-generated branch (FA4 #697) — UNCHANGED behaviour, hard-fail.
// ---------------------------------------------------------------------------
for (const { rel, globs, meta } of autoGeneratedEntries) {
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
  const lkOk = Object.prototype.hasOwnProperty.call(meta, 'learning-key');
  const eaOk = Object.prototype.hasOwnProperty.call(meta, 'expires-at');
  if (!hasEmptyGlobs && (hasGlobs || hasHostClass) && lkOk && eaOk) {
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

for (const { rel, globs, meta, contents } of handwrittenEntries) {
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

  if (!hasEmptyGlobs && hasAxis && hasReviewDate) {
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
