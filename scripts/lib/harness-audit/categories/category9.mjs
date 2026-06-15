/**
 * category9.mjs — Category 9: Skill-Health Surfacing (weight: 8)
 *
 * Checks (3, max_points sum = 10):
 *   c9.1 skill-telemetry-hygiene  (max 4)
 *   c9.2 skill-scorer-wired       (max 3)
 *   c9.3 skill-health-advisory    (max 3)
 *
 * Surfaces whether a repo has adopted the #648 per-skill health pipeline:
 * L1 telemetry (skill-invocations.jsonl), the scorer module (score.mjs +
 * join.mjs), and the advisory verdict surface. The VERDICT content is ADVISORY
 * ONLY — it NEVER affects points. The firewall between "surfacing a diagnosis"
 * and "scoring a repo on it" is enforced here by construction.
 *
 * CRITICAL — no-adoption is a HEALTHY state, never a failure. A repo without
 * skill-health telemetry or the scorer module MUST score full points on every
 * check. "Insufficient signal" and "feature not adopted" are healthy states,
 * not defects. The clean-repo integration fixture has neither the module nor
 * any telemetry and must still score 10/10 here (it asserts overall ≥ 8).
 *
 * status field is only 'pass' / 'fail' — partial tiers emit a reduced-points
 * pass() (there is no 'partial' constructor in helpers.mjs).
 *
 * Stdlib only: node:fs, node:path, node:child_process. The advisory tally in
 * c9.3 imports the AUDITOR's OWN (trusted) join/score modules in a short-lived
 * worker subprocess and runs them over the TARGET repo's telemetry DATA files —
 * it never imports code rooted at the audited repo (review N2b: RCE-on-audit).
 * The worker is wrapped so any failure degrades to a structural pass — a broken
 * or empty target repo never throws out of runCategory9.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { pass, fail } from './helpers.mjs';

const TELEMETRY_REL = '.orchestrator/metrics/skill-invocations.jsonl';
const SESSIONS_REL = '.orchestrator/metrics/sessions.jsonl';
const SCORER_REL = 'scripts/lib/skill-health/score.mjs';
const JOIN_REL = 'scripts/lib/skill-health/join.mjs';

/**
 * Classify the lines of a skill-invocations.jsonl file.
 * A line is "valid" iff it parses as JSON AND carries a string `event` field
 * AND a `schema_version` key (the L1 writer contract).
 *
 * @param {string} text
 * @returns {{ total: number, valid: number, malformed: number }}
 */
function classifyTelemetryLines(text) {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  let valid = 0;
  let malformed = 0;
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (obj && typeof obj.event === 'string' && Object.prototype.hasOwnProperty.call(obj, 'schema_version')) {
      valid += 1;
    } else {
      malformed += 1;
    }
  }
  return { total: lines.length, valid, malformed };
}

export function runCategory9(root) {
  const checks = [];

  // c9.1 skill-telemetry-hygiene (max 4)
  //
  // ABSENT telemetry → full points: the skill-health feature is simply not
  // adopted, which is a healthy state. PRESENT telemetry → full points iff
  // every line is valid JSON with a known `event` + `schema_version`; reduced
  // points (with a quoted malformed-line count) when some lines are malformed.
  {
    const checkId = 'skill-telemetry-hygiene';
    const telemetryPath = join(root, TELEMETRY_REL);
    if (!existsSync(telemetryPath)) {
      checks.push(pass({
        checkId, points: 4, maxPoints: 4, path: TELEMETRY_REL,
        evidence: { present: false, total: 0, valid: 0, malformed: 0 },
        message: 'no skill-invocations telemetry yet (feature not adopted)',
      }));
    } else {
      let text;
      try {
        text = readFileSync(telemetryPath, 'utf8');
      } catch {
        text = null;
      }
      if (text === null) {
        // Present-but-unreadable: treat as not-adopted rather than penalize.
        checks.push(pass({
          checkId, points: 4, maxPoints: 4, path: TELEMETRY_REL,
          evidence: { present: true, readable: false, total: 0, valid: 0, malformed: 0 },
          message: 'skill-invocations telemetry present but unreadable (treated as not-adopted)',
        }));
      } else {
        const { total, valid, malformed } = classifyTelemetryLines(text);
        if (malformed === 0) {
          checks.push(pass({
            checkId, points: 4, maxPoints: 4, path: TELEMETRY_REL,
            evidence: { present: true, total, valid, malformed: 0 },
            message: `${valid}/${total} skill-invocation line(s) valid (event + schema_version), 0 malformed`,
          }));
        } else {
          checks.push(pass({
            checkId, points: 2, maxPoints: 4, path: TELEMETRY_REL,
            evidence: { present: true, total, valid, malformed },
            message: `${malformed} of ${total} skill-invocation line(s) malformed (${valid} valid)`,
          }));
        }
      }
    }
  }

  // c9.2 skill-scorer-wired (max 3)
  //
  // ABSENT scorer module → full points (scoring not adopted is healthy).
  // PRESENT → confirm it exports scoreSkillHealth via a string-grep; full
  // points on match, fail only when the module exists but the export is gone
  // (a genuine wiring regression).
  {
    const checkId = 'skill-scorer-wired';
    const scorerPath = join(root, SCORER_REL);
    if (!existsSync(scorerPath)) {
      checks.push(pass({
        checkId, points: 3, maxPoints: 3, path: SCORER_REL,
        evidence: { present: false, exportsScorer: false },
        message: 'skill-health scoring not adopted',
      }));
    } else {
      let src;
      try {
        src = readFileSync(scorerPath, 'utf8');
      } catch {
        src = null;
      }
      const exportRe = /export\s+function\s+scoreSkillHealth\b|export\s*\{[^}]*\bscoreSkillHealth\b/;
      if (src && exportRe.test(src)) {
        checks.push(pass({
          checkId, points: 3, maxPoints: 3, path: SCORER_REL,
          evidence: { present: true, exportsScorer: true },
          message: 'scripts/lib/skill-health/score.mjs exports scoreSkillHealth',
        }));
      } else {
        checks.push(fail({
          checkId, maxPoints: 3, path: SCORER_REL,
          evidence: { present: true, exportsScorer: false },
          message: 'score.mjs present but does not export scoreSkillHealth (wiring regression)',
        }));
      }
    }
  }

  // c9.3 skill-health-advisory (max 3) — ALWAYS PASSES.
  //
  // Advisory-only surface: compute the verdict distribution when both the join
  // + score modules exist AND telemetry is present, then put the verdict tally
  // in the check evidence/message as INFORMATIONAL output. Verdict CONTENT
  // never affects points — this check is structurally pass-only. Any import
  // failure, an absent module, or absent telemetry → still pass(3) with an
  // "insufficient signal" note.
  checks.push(buildAdvisoryCheck(root));

  return checks;
}

/**
 * Builds the c9.3 advisory check (ALWAYS a pass). Isolated so the worker-import
 * + scorer invocation can be wrapped in a single try/catch that never throws
 * out of runCategory9 on a broken or older target repo.
 *
 * @param {string} root
 * @returns {object} a pass() check result with points = 3
 */
function buildAdvisoryCheck(root) {
  const checkId = 'skill-health-advisory';
  const maxPoints = 3;

  const scorerPath = join(root, SCORER_REL);
  const joinPath = join(root, JOIN_REL);
  const telemetryPath = join(root, TELEMETRY_REL);

  // No module(s) or no telemetry → advisory surface has nothing to say, but
  // that is a healthy "insufficient signal" state. Pass full points.
  if (!existsSync(scorerPath) || !existsSync(joinPath) || !existsSync(telemetryPath)) {
    return pass({
      checkId, points: maxPoints, maxPoints, path: SCORER_REL,
      evidence: { computed: false, verdictTally: {} },
      message: 'no advisory verdicts (insufficient signal)',
    });
  }

  let tally;
  try {
    tally = computeAdvisoryTally(scorerPath, joinPath, telemetryPath, root);
  } catch {
    tally = null;
  }

  if (tally && tally.computed) {
    return pass({
      checkId, points: maxPoints, maxPoints, path: SCORER_REL,
      evidence: { computed: true, verdictTally: tally.verdictTally, skills: tally.skillCount },
      message: `advisory verdict tally: ${JSON.stringify(tally.verdictTally)} (informational, never scored)`,
    });
  }

  return pass({
    checkId, points: maxPoints, maxPoints, path: SCORER_REL,
    evidence: { computed: false, verdictTally: {} },
    message: 'no advisory verdicts (insufficient signal)',
  });
}

/**
 * Compute the advisory verdict tally by importing the AUDITOR's OWN (trusted)
 * join + score modules in a short-lived worker subprocess, running
 * joinSkillOutcomes → scoreSkillHealth over the TARGET repo's telemetry DATA
 * files, and tallying verdicts.
 *
 * SECURITY (review N2b): harness-audit can target an arbitrary repo, so we must
 * never `import()` CODE rooted at the audited `root` — that would execute the
 * target's modules during an audit (RCE-on-audit, a trust-model expansion). The
 * worker therefore imports the auditor's own `scripts/lib/skill-health/{join,score}.mjs`
 * (derived from THIS module's location, not from `root`) and feeds them only the
 * target's telemetry JSONL FILE paths as DATA arguments. The auditor runs only
 * TRUSTED code over UNTRUSTED data.
 *
 * runCategory* are synchronous by contract and joinSkillOutcomes is async, so a
 * subprocess is used to bridge the async/sync gap without making the whole
 * category async. The tally is purely INFORMATIONAL advisory output — any
 * failure returns { computed: false } and the caller passes full points anyway.
 *
 * @param {string} scorerPath    absolute path to score.mjs in the target root (existence-checked only)
 * @param {string} joinPath      absolute path to join.mjs in the target root (existence-checked only)
 * @param {string} telemetryPath absolute path to skill-invocations.jsonl (DATA)
 * @param {string} root          target repo root
 * @returns {{ computed: boolean, verdictTally?: Record<string,number>, skillCount?: number }}
 */
// NOTE: scorerPath/joinPath are intentionally unused inside this body — they are
// existence-checked by the caller (buildAdvisoryCheck) and retained in the signature
// for caller symmetry. The CODE imported here comes from the auditor's OWN modules
// (derived from import.meta.url below), never from the audited target (review N2b).
function computeAdvisoryTally(scorerPath, joinPath, telemetryPath, root) {
  const sessionsPath = join(root, SESSIONS_REL);
  // Import the AUDITOR's OWN trusted modules — derived from THIS file's location,
  // NEVER from the audited `root`. The target's join.mjs/score.mjs are existence-
  // checked by the caller but never imported (would execute target code → N2b).
  const joinUrl = new URL('../../skill-health/join.mjs', import.meta.url).href;
  const scoreUrl = new URL('../../skill-health/score.mjs', import.meta.url).href;

  const worker = `
    (async () => {
      try {
        const { joinSkillOutcomes } = await import(${JSON.stringify(joinUrl)});
        const { scoreSkillHealth } = await import(${JSON.stringify(scoreUrl)});
        const joined = await joinSkillOutcomes({
          invocationsPath: ${JSON.stringify(telemetryPath)},
          sessionsPath: ${JSON.stringify(sessionsPath)},
        });
        const rows = scoreSkillHealth({ bySkill: joined.bySkill });
        const tally = {};
        for (const r of rows) { tally[r.verdict] = (tally[r.verdict] || 0) + 1; }
        process.stdout.write(JSON.stringify({ ok: true, verdictTally: tally, skillCount: rows.length }));
      } catch {
        process.stdout.write(JSON.stringify({ ok: false }));
      }
    })();
  `;

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', worker], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status !== 0 || !result.stdout) return { computed: false };
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { computed: false };
  }
  if (!parsed || parsed.ok !== true) return { computed: false };
  return { computed: true, verdictTally: parsed.verdictTally || {}, skillCount: parsed.skillCount || 0 };
}
