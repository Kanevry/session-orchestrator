#!/usr/bin/env node
// check-auq-clarity.mjs — Ratchet guard for the AUQ question corpus (#1107).
//
// ## Why this file exists
//
// Wave 2 of #1107 built a deterministic measurer for the operator-facing
// AskUserQuestion corpus (`scripts/lib/auq/` + `scripts/auq-audit.mjs`); wave 3
// used it to bring the corpus from 21/72 to 72/72 clean. The measurer had zero
// callers — no npm script, no gate, no skill phase invoked it. That is this
// repo's documented systemic failure class ("built, documented, tested, never
// switched on"), and without a caller the corpus silently rots back.
//
// This validator is that caller. It is a RATCHET, not a cleanup order: the
// corpus stands at 0 broken hurdles today, so the check is green today and goes
// red exactly when someone lands a NEW question that breaks a hard limit.
//
// ## What it gates on — and, deliberately, what it does not
//
// It gates on the two HARD LIMITS only (`HURDLES` in scripts/lib/auq/schema.mjs):
//
//   H1  header at most 12 Unicode CODE POINTS (the tool truncates past that —
//       the operator never sees the rest)
//   H2  2-4 options PER QUESTION (never per block), and a `(Recommended)`
//       marker only on index 0
//
// It does NOT gate on the eight weighted criteria K1-K8 or on the resulting
// score. Their measured false-positive rates run 14%-25% (module head of
// scripts/lib/auq/clarity.mjs); a gate built on them would object to roughly
// every fourth CORRECT question, and a validator that cries wolf gets switched
// off — taking every true finding with it. H1 and H2 are the only two with a
// measured false-positive rate of 0%. That asymmetry is the whole design:
// a narrow gate that survives beats a broad gate that gets disabled.
//
// Score, grades and the K1-K8 findings remain available on demand via
// `node scripts/auq-audit.mjs .` — reported, never enforced.
//
// ## It measures nothing itself
//
// Every judgement comes from the existing modules: `parseRepo()` finds the
// templates (across ALL six populations, including `.cursor/rules/*.mdc`, which
// is the only surface a Cursor operator ever sees), `scoreBlocks()` scores them,
// and `HURDLES` names the limits. A second implementation of the criteria here
// would be the start of divergence — the two copies would disagree the first
// time a threshold moves, and the disagreement would be silent.
//
// Direct import rather than spawning `scripts/auq-audit.mjs --json`: the audit
// CLI emits a >1 MB envelope that would have to be re-parsed, and its exit code
// speaks a different dialect (3 = hard limit broken under `--strict`) than the
// 0/1/2 this validator family uses. Importing skips both translations.
//
// ## Language
//
// Comments and structural output are English, matching the 35 sibling
// validators in this directory. Quoted finding text is German because it comes
// verbatim from clarity.mjs, where it is written for the operator on purpose —
// re-wording it here would be exactly the second copy this file avoids.
//
// Usage: check-auq-clarity.mjs <plugin-root> [--file <repo-relative-path>]...
//
// `--file` restricts the corpus to the named files and bypasses `git ls-files`.
// Its purpose is testability: the default enumeration is git-backed, so inside a
// throwaway fixture directory (no git) the corpus would otherwise be empty. The
// orchestrator never passes it.
//
// Outputs lines of the form "  PASS: ..." / "  FAIL: ..." / "  WARN: ..." plus a
// "Results: N passed, M failed" line so the validate-plugin orchestrator's
// PASS:/FAIL: tally counts it.
//
// Exit codes:
//   0 — clean (no question breaks a hard limit)
//   1 — at least one question breaks a hard limit, or the corpus is empty
//   2 — tool error (missing arg / unreadable root)

import { parseRepo } from '../auq/parse.mjs';
import { scoreBlocks } from '../auq/clarity.mjs';
import { HURDLES, HURDLE_IDS, POPULATIONS } from '../auq/schema.mjs';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Splits argv into the plugin root and the optional `--file` restriction list.
 *
 * Deliberately NOT exported: this module's body runs the check on import, so an
 * importing test would trigger a `process.exit()` instead of getting a function.
 * Argument handling is covered through the subprocess, like the sibling checks.
 *
 * @param {string[]} argv - arguments after `node <script>`
 * @returns {{root: string|null, files: string[], error: string|null}}
 */
function parseCheckArgs(argv) {
  let root = null;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { root, files, error: '--file needs a repo-relative path' };
      }
      files.push(value);
      i++;
      continue;
    }
    if (arg.startsWith('--')) return { root, files, error: `unknown flag: ${arg}` };
    if (root === null) root = arg;
  }
  return { root, files, error: null };
}

const parsed = parseCheckArgs(process.argv.slice(2));

if (parsed.error) {
  console.error(`Usage: check-auq-clarity.mjs <plugin-root> [--file <path>]... (${parsed.error})`);
  process.exit(2);
}
if (!parsed.root) {
  console.error('Usage: check-auq-clarity.mjs <plugin-root> [--file <path>]...');
  process.exit(2);
}

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

// ============================================================================
// Check: AUQ hard limits (H1/H2) across the whole question corpus
// ============================================================================
console.log('--- Check: AUQ question corpus hard limits (H1 header, H2 options) ---');

let repo;
try {
  repo = parseRepo({
    repoRoot: parsed.root,
    ...(parsed.files.length > 0 ? { files: parsed.files } : {}),
  });
} catch (err) {
  console.error(`  tool-error: cannot parse the AUQ corpus: ${err?.message ?? String(err)}`);
  process.exit(2);
}

// Read warnings are surfaced, never swallowed: each one is a template that
// silently left the corpus, and a shrinking corpus is how this guard would fade
// to a decoy without anyone noticing. WARN (not FAIL) matches the sibling
// convention and never touches the exit code.
for (const w of repo.warnings) warn(`AUQ corpus: ${w}`);

const scores = scoreBlocks(repo.blocks);

// --- Anti-decoy guard -------------------------------------------------------
// A validator that is wired up but measures nothing is indistinguishable from a
// green one, and that is precisely the failure this file was written to end. An
// empty corpus therefore FAILS rather than passing vacuously: it means the
// enumeration broke (git unavailable, corpus prefixes moved, `--file` pointed
// outside the corpus), never that the repo is clean.
if (scores.length === 0) {
  fail(
    'the AUQ corpus is empty — 0 questions found, so this check measured nothing. ' +
      'Either the file enumeration broke (git ls-files unavailable, or scripts/lib/auq/parse.mjs ' +
      'corpus prefixes no longer match the tree) or a --file argument pointed outside the corpus. ' +
      'A silently empty corpus is a decoy gate, not a clean repo.',
  );
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed, ${warned} warned`);
  process.exit(1);
}

// --- The two hard limits ----------------------------------------------------
// Note what is NOT consulted here: `score.points`, `score.grade`, and
// `score.findings[].severity === 'warn'`. Only `hurdlesBroken` drives the exit
// code. This is also what makes the `optionCountUnknown` case correct by
// construction: three-plus templates in the corpus end in an ellipsis rather
// than a full option list, so their true option count is UNKNOWN. clarity.mjs
// records that as a warn-level note and deliberately breaks NO hurdle for it
// ("not checkable" is not "violated"). Keying on `hurdlesBroken` inherits that
// judgement; keying on findings would invent violations that do not exist.
const brokenByHurdle = new Map(HURDLE_IDS.map((id) => [id, []]));

for (const score of scores) {
  for (const id of score.hurdlesBroken) {
    if (!brokenByHurdle.has(id)) brokenByHurdle.set(id, []);
    brokenByHurdle.get(id).push(score);
  }
}

/**
 * The operator-facing reason a question broke a hurdle, taken verbatim from the
 * finding clarity.mjs already produced.
 *
 * Filtered on the finding's OWN `hurdle` tag, not on the hurdle's criterion.
 * The criterion filter this used to carry over-reached: K6 produces four
 * finding classes (description length, label length, payload size, option
 * count) and only the last one breaks H2, so a FAIL line here could name a
 * description that is 186 characters long — a finding that breaks nothing —
 * while the real option-count break sat behind it. The same over-reach was
 * measured in `hooks/pre-auq-clarity.mjs` and is fixed there too; both
 * consumers had reconstructed a mapping that `clarity.mjs` already knew.
 *
 * The criterion path stays as a fallback so an older scorer that emits
 * untagged findings degrades to the previous behaviour instead of producing a
 * silent empty reason. Found by this session's architecture review (W4-Q7).
 *
 * @param {import('../auq/schema.mjs').AuqScore} score
 * @param {string} hurdleId
 * @returns {string}
 */
function reasonFor(score, hurdleId) {
  const criterion = HURDLES[hurdleId]?.criterion;
  const tagged = score.findings.filter((f) => f.hurdle === hurdleId && f.severity === 'fail');
  const pool = tagged.length > 0
    ? tagged
    : score.findings.filter((f) => f.criterion === criterion && f.severity === 'fail');
  const messages = pool.map((f) => f.message);
  return messages.length > 0 ? messages.join(' ') : '(no message recorded)';
}

for (const id of HURDLE_IDS) {
  const offenders = brokenByHurdle.get(id) ?? [];
  const hurdle = HURDLES[id];

  if (offenders.length === 0) {
    // Deliberately reports the DENOMINATOR too. A "0 violations" line is equally
    // true of a corpus of zero questions, which is the state the anti-decoy
    // guard above exists to catch — printing what was actually measured keeps
    // the two distinguishable at a glance.
    pass(
      `${id} (${hurdle.title}) — 0 of ${scores.length} questions break this limit ` +
        `[${hurdle.rule}]`,
    );
    continue;
  }

  for (const score of offenders) {
    fail(
      `${score.file}:${score.line} (question ${score.questionIndex + 1}) breaks hard limit ${id} ` +
        `— ${hurdle.title}. ${reasonFor(score, id)} See .claude/rules/ask-via-tool.md (AUQ-003) ` +
        'and run `node scripts/auq-audit.mjs .` for the full report.',
    );
  }
}

// --- Corpus census (informational) ------------------------------------------
// Deliberately NOT routed through pass(): this is bookkeeping, not an audited
// invariant, and must not inflate the passed count the orchestrator tallies.
//
// It is printed because the most plausible way this guard degrades is by
// quietly narrowing to `.md`. The six populations include `.cursor/rules/*.mdc`
// — the only surface a Cursor operator ever sees — and runtime questions inside
// `.mjs`. A checker that read markdown only would hand those a clean bill of
// health while never opening them; a per-population line makes that visible
// instead of invisible.
const census = POPULATIONS.map((p) => `${p}:${repo.corpus[p] ?? 0}`).join(' ');
console.log(`  (corpus: ${scores.length} questions in ${repo.blocks.length} blocks — ${census})`);

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed, ${warned} warned`);

process.exit(failed > 0 ? 1 : 0);
