#!/usr/bin/env node
/**
 * validate-wave-scope.mjs — Validate .claude/wave-scope.json before enforcement hooks consume it.
 *
 * Part of v3.0 Bash→Node migration (Epic #124). Replaces validate-wave-scope.sh
 * which depended on scripts/lib/common.sh → scripts/lib/platform.sh (removed).
 *
 * Usage:
 *   node scripts/validate-wave-scope.mjs <path-to-wave-scope.json>
 *   cat wave-scope.json | node scripts/validate-wave-scope.mjs
 *   node scripts/validate-wave-scope.mjs --assert-subset <agent-filescope.json> < wave-scope.json
 *
 * Flags:
 *   --assert-subset <path>  After schema validation passes, read the agent
 *                           fileScope file (a JSON array of strings) and assert
 *                           it is a subset of wave-scope.allowedPaths (#796).
 *                           Fails (exit 1) with "missing: [...]" on violation.
 *   --expand-test-siblings  With --assert-subset: ALSO require allowedPaths to
 *                           grant the test sibling of every concrete production
 *                           file in the agent fileScope (#970). Default OFF.
 *                           Only ever ADDS a requirement — never relaxes the
 *                           subset assertion above.
 *                           GATED ON THE MANIFEST'S OWN `role`: the assertion
 *                           fires only for the roles where expansion fires
 *                           (scope-gate.mjs TEST_SIBLING_EXPANSION_ROLES), so
 *                           the caller may pass the flag unconditionally on
 *                           every pre-dispatch check. A skip is announced on
 *                           stderr as a WARN.
 *
 * Exit codes:
 *   0 — valid (validated JSON echoed to stdout)
 *   1 — invalid input / validation failure (error messages written to stderr)
 *   2 — I/O error (file not found, unreadable stdin, unreadable --assert-subset file)
 */

import path from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { warn } from './lib/common.mjs';
import {
  assertFileScopeSubset,
  assertTestSiblingCoverage,
  testSiblingExpansionApplies,
  TEST_SIBLING_EXPANSION_ROLES,
} from './lib/scope-gate.mjs';

/**
 * Write an error to stderr and exit with the given code.
 * @param {string} msg
 * @param {number} [code=1]
 * @returns {never}
 */
function die(msg, code = 1) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(code);
}

/**
 * Parse CLI flags out of argv, leaving positional args behind.
 *
 * Recognised: `--assert-subset <path>` (#796) and `--expand-test-siblings`
 * (#970). Everything else is treated as a positional argument (the
 * wave-scope.json file path), preserving legacy behaviour where argv[2] is the
 * input file.
 *
 * @param {string[]} argv - full process.argv
 * @returns {{ assertSubset: string|null, expandTestSiblings: boolean, positionals: string[] }}
 */
function parseArgs(argv) {
  const positionals = [];
  let assertSubset = null;
  let expandTestSiblings = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--expand-test-siblings') {
      expandTestSiblings = true;
    } else if (a === '--assert-subset') {
      assertSubset = argv[i + 1];
      if (assertSubset === undefined) {
        die('--assert-subset requires a file-path argument', 1);
      }
      i++; // consume the value
    } else {
      positionals.push(a);
    }
  }
  return { assertSubset, expandTestSiblings, positionals };
}

/**
 * Read raw input: from a file path arg or from stdin (fd 0).
 *
 * Exit codes used here:
 *   1 — bad argument (file path argument given but file not found)
 *   2 — unexpected I/O error (file exists but cannot be read, stdin failure)
 *
 * @param {string|undefined} arg - the positional wave-scope.json file path (or undefined for stdin)
 * @returns {string}
 */
function readInput(arg) {
  if (arg) {
    // Exit 1: file not found is a user/argument error
    if (!existsSync(arg) || !statSync(arg).isFile()) {
      die(`File not found: ${arg}`, 1);
    }
    // Exit 2: file exists but cannot be read is an I/O error
    try {
      return readFileSync(arg, 'utf8');
    } catch (err) {
      die(`Cannot read file ${arg}: ${err.message}`, 2);
    }
  }
  // Exit 2: stdin read failure is an I/O error
  try {
    return readFileSync(0, 'utf8');
  } catch (err) {
    die(`Cannot read stdin: ${err.message}`, 2);
  }
}

/**
 * Parse raw JSON input; exits 1 on parse failure.
 * @param {string} input
 * @returns {unknown}
 */
function parseJson(input) {
  try {
    return JSON.parse(input);
  } catch {
    die('Input is not valid JSON');
  }
}

/**
 * Validate required scalar fields: wave, role, enforcement.
 * @param {Record<string, unknown>} obj
 * @param {string[]} errors
 */
function validateRequired(obj, errors) {
  // wave — positive integer
  if (!('wave' in obj) || obj.wave === null || obj.wave === undefined) {
    errors.push('Missing required field: wave');
  } else if (typeof obj.wave !== 'number' || !Number.isInteger(obj.wave) || obj.wave <= 0) {
    errors.push(`wave must be a positive integer, got: ${JSON.stringify(obj.wave)}`);
  }

  // role — non-empty string
  const roleType = obj.role === null ? 'null' : typeof obj.role;
  if (!('role' in obj) || roleType !== 'string') {
    errors.push(`role must be a string, got type: ${roleType}`);
  } else if (obj.role.length === 0) {
    errors.push('role must be a non-empty string');
  }

  // enforcement — one of strict|warn|off
  const enfType = obj.enforcement === null ? 'null' : typeof obj.enforcement;
  if (!('enforcement' in obj) || enfType !== 'string') {
    errors.push(`enforcement must be a string, got type: ${enfType}`);
  } else if (!['strict', 'warn', 'off'].includes(obj.enforcement)) {
    errors.push(`enforcement must be one of: strict, warn, off — got: ${obj.enforcement}`);
  }
}

/**
 * Literal filesystem-root forms — POSIX "/" and the Windows equivalents "\"
 * and a bare drive root ("C:\", "C:\\", ...). Checked independently of
 * `path.isAbsolute()` because that primitive is platform-native: on a POSIX
 * host (this repo's dev/CI hosts) it never reports `C:\` as absolute, so a
 * Windows-literal-root entry would otherwise slip past every check below.
 * @type {ReadonlySet<string>}
 */
const FILESYSTEM_ROOT_LITERALS = new Set(['/', '\\']);
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:\\+$/;

/**
 * @param {string} entry
 * @returns {boolean}
 */
function isFilesystemRootLiteral(entry) {
  return FILESYSTEM_ROOT_LITERALS.has(entry) || WINDOWS_DRIVE_ROOT_RE.test(entry);
}

/**
 * Well-known top-level system/home directories. A FIXED DENYLIST (not a
 * segment-count threshold): the #792 legitimate grant
 * (`/private/tmp/<session>/scratchpad/**`) is itself a single-segment-deep
 * grant under an unusual root ("private"), so any segment-count heuristic
 * tight enough to catch `/etc/**` risks catching that too, or must be tuned
 * loosely enough to leave a gap. A fixed list of the directories a
 * hallucinated/mis-copied wave-scope entry could plausibly land on is
 * predictable, auditable in a one-line diff, and does not touch legitimate
 * deep grants under any other root.
 * @type {ReadonlySet<string>}
 */
const DENIED_ABSOLUTE_TOP_SEGMENTS = new Set([
  'etc',
  'Users',
  'home',
  'root',
  'bin',
  'sbin',
  'usr',
  'System',
  'var',
  'boot',
  'dev',
  'proc',
  'sys',
  'Library',
  'Applications',
  'Windows',
]);

/**
 * The top-level path segment of an absolute POSIX-style entry (the segment
 * immediately after the leading "/"), if it is on the denylist above.
 * @param {string} entry
 * @returns {string|null}
 */
function deniedTopSegment(entry) {
  const first = entry.split('/').filter(Boolean)[0];
  return first && DENIED_ABSOLUTE_TOP_SEGMENTS.has(first) ? first : null;
}

/**
 * Does this entry contain a glob wildcard? Mirrors this codebase's own glob
 * convention (`isGlobScopeEntry` in scripts/lib/scope-gate.mjs / #796): `*`
 * is the sole wildcard metachar used in allowedPaths/fileScope entries
 * throughout this repo (no `?`/`[]`/`{}` glob syntax is supported or tested
 * anywhere else in scope-gate.mjs or enforce-scope.mjs).
 * @param {string} entry
 * @returns {boolean}
 */
function hasWildcard(entry) {
  return entry.includes('*');
}

/**
 * Validate allowedPaths array: must exist, be an array of non-empty strings,
 * with no path-traversal segments. Absolute (out-of-repo) entries are a
 * SANCTIONED Gate 5b grant (#792) — WARN, not reject; see #870. A narrow
 * catastrophic subclass of absolute entries is instead a hard ERROR
 * (#870-followup security review, confidence 0.85): allowedPaths is not
 * hand-authored — wave-loop.md's Scope Manifest computes it PROGRAMMATICALLY
 * as the union of LLM-authored per-agent "Files:" scopes — so a
 * hallucinated/mis-copied/injected entry reaching one of these shapes must
 * hard-fail rather than rely on a stderr WARN nothing guarantees a human
 * reads before dispatch.
 * @param {Record<string, unknown>} obj
 * @param {string[]} errors
 * @param {string[]} warnings
 */
function validateAllowedPaths(obj, errors, warnings) {
  if (!('allowedPaths' in obj)) {
    errors.push('Missing required field: allowedPaths');
    return;
  }
  const ap = obj.allowedPaths;
  if (!Array.isArray(ap)) {
    errors.push(`allowedPaths must be an array, got type: ${ap === null ? 'null' : typeof ap}`);
    return;
  }
  for (const entry of ap) {
    if (typeof entry !== 'string' || entry.length === 0) {
      errors.push('allowedPaths contains empty string');
      continue;
    }
    // #870: an explicit absolute entry is a SANCTIONED out-of-repo grant — mirrors
    // hooks/enforce-scope.mjs Gate 5b (matchesAbsoluteAllowlist), which honours ANY
    // syntactically-absolute allowedPaths entry (path.isAbsolute) against the
    // realpath-resolved write candidate. Using `path.isAbsolute` (not a hand-rolled
    // `startsWith('/')`) keeps the same platform-native semantics Gate 5b uses.
    // WARN, not reject — the validator must not contradict the hook it validates
    // for (#792 / #870) — EXCEPT for the narrow catastrophic subclass below
    // (#870-followup), which hard-rejects regardless of what Gate 5b would do
    // with it: pre-flight validation exists precisely to catch a grant this bad
    // before the hook is ever consulted.
    if (path.isAbsolute(entry) || isFilesystemRootLiteral(entry)) {
      if (isFilesystemRootLiteral(entry)) {
        errors.push(
          `allowedPaths grants the entire filesystem root: ${entry} — refused unconditionally, this can never be a valid wave scope`,
        );
      } else {
        const denied = deniedTopSegment(entry);
        if (denied) {
          errors.push(
            `allowedPaths contains a well-known system/home directory grant: ${entry} (top-level segment "${denied}" is denylisted) — refused, scope a narrower path instead`,
          );
        } else if (!hasWildcard(entry)) {
          errors.push(
            `allowedPaths contains a bare absolute file grant with no wildcard: ${entry} — a single concrete out-of-repo file has no established legitimate use in this codebase; scope a glob instead`,
          );
        } else {
          warnings.push(
            `allowedPaths contains an absolute (out-of-repo) path: ${entry} — honoured by hooks/enforce-scope.mjs Gate 5b; verify this grant is intentional`,
          );
        }
      }
    }
    // Reject path traversal: any `../` segment. INDEPENDENT of the absolute checks
    // above — an absolute entry that ALSO contains `../` must still be rejected
    // here, unconditionally, even when it was already rejected above for a
    // different reason. (Such an entry could never actually match Gate 5b's
    // realpath-canonicalised candidate anyway, since realpath strips `..`
    // segments before Gate 5b ever compares it — see enforce-scope.mjs REQ-09 —
    // but validate-time rejection gives the operator immediate, actionable
    // feedback instead of leaving a silently-dead allowedPaths entry.)
    if (entry.includes('../')) {
      errors.push(`allowedPaths contains path traversal: ${entry}`);
    }
    // Warn on overly permissive glob patterns
    if (entry === '**/*' || entry === '*') {
      warnings.push(`allowedPaths contains overly permissive pattern: ${entry}`);
    }
  }
}

/**
 * Validate blockedCommands: must exist and be an array.
 * @param {Record<string, unknown>} obj
 * @param {string[]} errors
 */
function validateBlockedCommands(obj, errors) {
  if (!('blockedCommands' in obj)) {
    errors.push('Missing required field: blockedCommands');
    return;
  }
  if (!Array.isArray(obj.blockedCommands)) {
    const t = obj.blockedCommands === null ? 'null' : typeof obj.blockedCommands;
    errors.push(`blockedCommands must be an array, got type: ${t}`);
  }
}

/**
 * Validate optional gates field: if present must be an object of string→boolean entries.
 * @param {Record<string, unknown>} obj
 * @param {string[]} errors
 */
function validateGates(obj, errors) {
  if (!('gates' in obj)) return;
  const gates = obj.gates;
  if (gates === null || typeof gates !== 'object' || Array.isArray(gates)) {
    const t = gates === null ? 'null' : Array.isArray(gates) ? 'array' : typeof gates;
    errors.push(`gates must be an object, got type: ${t}`);
    return;
  }
  const bad = Object.entries(gates)
    .filter(([, v]) => typeof v !== 'boolean')
    .map(([k]) => k);
  if (bad.length > 0) {
    errors.push(`gates values must be booleans, invalid entries: ${bad.join(', ')}`);
  }
}

/**
 * Read the agent fileScope sidecar file and assert it is a subset of the
 * wave's allowedPaths union (#796). Exits on failure; returns on success.
 *
 * Exit codes:
 *   1 — fileScope file is not valid JSON, is not an array of strings, or the
 *       subset assertion fails (validation error)
 *   2 — fileScope file is missing / not a regular file / unreadable (I/O error)
 *
 * @param {Record<string, unknown>} obj - the already schema-validated wave-scope object
 * @param {string} fileScopePath - path to the agent fileScope JSON file
 * @param {boolean} [expandTestSiblings] - also assert #970 test-sibling coverage
 */
function assertSubsetOrDie(obj, fileScopePath, expandTestSiblings = false) {
  if (!existsSync(fileScopePath) || !statSync(fileScopePath).isFile()) {
    die(`Cannot read --assert-subset file: ${fileScopePath}`, 2);
  }
  let raw;
  try {
    raw = readFileSync(fileScopePath, 'utf8');
  } catch (err) {
    die(`Cannot read --assert-subset file ${fileScopePath}: ${err.message}`, 2);
  }
  let fileScope;
  try {
    fileScope = JSON.parse(raw);
  } catch {
    die(`--assert-subset file is not valid JSON: ${fileScopePath}`, 1);
  }
  if (!Array.isArray(fileScope) || !fileScope.every((e) => typeof e === 'string')) {
    die('--assert-subset file must be a JSON array of strings', 1);
  }
  const { ok, missing } = assertFileScopeSubset(fileScope, obj.allowedPaths);
  if (!ok) {
    die(`agent fileScope not ⊆ allowedPaths — missing: [${missing.join(', ')}]`, 1);
  }
  // #970 — opt-in, and deliberately AFTER the plain subset assertion so the
  // pre-existing failure mode keeps its exact message. This only ever adds a
  // requirement: the union must also grant each production file's test sibling,
  // or the agent is mechanically unable to update the test it just broke.
  //
  // The manifest's OWN `role` (already schema-validated as a non-empty string
  // above) gates it, through the same predicate the expander uses. That is what
  // lets the pre-dispatch command carry the flag unconditionally: on a Quality
  // phase-1 manifest — production files with tests deliberately excluded — an
  // ungated assertion would block every dispatch of that phase.
  if (expandTestSiblings) {
    if (!testSiblingExpansionApplies({ role: obj.role })) {
      warn(
        `--expand-test-siblings: skipped for role "${obj.role}" — test-sibling expansion applies only to [${TEST_SIBLING_EXPANSION_ROLES.join(', ')}] (scripts/lib/scope-gate.mjs)`,
      );
      return;
    }
    const sib = assertTestSiblingCoverage(fileScope, obj.allowedPaths, { role: obj.role });
    if (!sib.ok) {
      die(
        `allowedPaths does not grant the test sibling of every production file in the agent fileScope (#970) — missing: [${sib.missing.join(', ')}]. Re-run the Scope Manifest step: allowedPaths must be expandTestSiblings(union, { role }) — see skills/wave-executor/wave-loop.md § Scope Manifest #3`,
        1,
      );
    }
  }
}

/**
 * Main validation entry point. Reads input, validates, exits with appropriate code.
 * @param {string} input - raw JSON string
 * @param {string|null} [assertSubsetPath] - optional agent fileScope file for the #796 subset assertion
 * @param {boolean} [expandTestSiblings] - opt-in #970 test-sibling coverage assertion
 */
function validate(input, assertSubsetPath = null, expandTestSiblings = false) {
  const obj = parseJson(input);
  const errors = [];
  const warnings = [];

  validateRequired(obj, errors);
  validateAllowedPaths(obj, errors, warnings);
  validateBlockedCommands(obj, errors);
  validateGates(obj, errors);

  for (const w of warnings) {
    warn(w);
  }

  if (errors.length > 0) {
    for (const e of errors) {
      process.stderr.write(`ERROR: ${e}\n`);
    }
    process.exit(1);
  }

  // #796 — optional dispatch-time subset assertion (runs only after schema validation passes)
  if (assertSubsetPath) {
    assertSubsetOrDie(obj, assertSubsetPath, expandTestSiblings);
  }

  // Echo validated JSON to stdout (trailing newline normalised)
  process.stdout.write(input.endsWith('\n') ? input : input + '\n');
}

const { assertSubset, expandTestSiblings, positionals } = parseArgs(process.argv);
validate(readInput(positionals[0]), assertSubset, expandTestSiblings);
