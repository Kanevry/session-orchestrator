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
 *   node scripts/validate-wave-scope.mjs --assert-disjoint <agent-scopes.json> < wave-scope.json
 *   node scripts/validate-wave-scope.mjs --union <agent-scopes.json> < wave-scope.json
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
 *   --assert-disjoint <p>   #1020. Read the wave's per-agent scope SIDECAR and
 *                           assert no file is claimed by two agents of the same
 *                           wave. Fails (exit 1) with one message per collision.
 *                           `knownFiles` for the glob∩glob stage comes from
 *                           `git ls-files` — spawned HERE, in the CLI layer,
 *                           because scripts/lib/scope-gate.mjs is hook-safe and
 *                           must not spawn a process (see its module header).
 *   --union <path>          #1020. QUERY MODE. Read the same sidecar, compute
 *                           `expandTestSiblings(unionFileScopes(scopes), {role})`
 *                           using the MANIFEST'S OWN `role`, and print the
 *                           resulting allowedPaths array as JSON on stdout.
 *                           Mechanical replacement for the "Collect all file
 *                           paths … Deduplicate entries" prose in
 *                           skills/wave-executor/wave-loop.md § Scope Manifest #3.
 *
 * ## SIDECAR FORMAT (both #1020 flags) — an ARRAY, never an object map
 *   [{ "id": "W2-C1", "files": ["scripts/a.mjs"] }, { "id": "W2-C4", "files": [...] }]
 * An object keyed by agent id would swallow a DUPLICATE agent id silently, and a
 * duplicated id is a real copy-paste failure mode (it hides one agent's scope
 * from every per-agent check). The array form keeps both records, and
 * `findScopeCollisions` reports the duplicate as its own finding.
 *
 * ## STDOUT CONTRACT (why --union suppresses the manifest echo)
 * Without `--union` this script writes EXACTLY ONE thing to stdout: the input
 * manifest, echoed back verbatim. Callers rely on that — `JSON.parse(stdout)`.
 * `--union` is the first mode that has something else to say, so it is a pure
 * QUERY MODE: it REPLACES the echo rather than adding to it, and stdout carries
 * only the computed allowedPaths array. Mixing both on stdout would break every
 * `JSON.parse(stdout)` caller; writing the union to a second sink would need a
 * file argument the caller must then read back. One JSON document per run, and
 * the flag decides which one.
 *
 * Exit codes:
 *   0 — valid (validated JSON echoed to stdout; with --union: the union array)
 *   1 — invalid input / validation failure (error messages written to stderr).
 *       A scope COLLISION is a validation finding, exactly like the #796 subset
 *       and #970 test-sibling violations — the collision-vs-subset distinction
 *       lives in the MESSAGE, not in a new exit code.
 *   2 — I/O error (file not found, unreadable stdin, unreadable sidecar file)
 */

import path from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { warn } from './lib/common.mjs';
import { MANIFEST_SESSION_KEYS } from './lib/session-identity/own-session.mjs';
import {
  assertFileScopeSubset,
  assertTestSiblingCoverage,
  testSiblingExpansionApplies,
  TEST_SIBLING_EXPANSION_ROLES,
  findScopeCollisions,
  unionFileScopes,
  // #1057 — the read-only-role predicate + THE list. Imported rather than
  // re-listed so the validator and hooks/enforce-scope.mjs cannot disagree about
  // which roles are allowed to grant zero paths.
  isReadOnlyWaveRole,
  READ_ONLY_WAVE_ROLES,
  // Aliased: `expandTestSiblings` is ALSO the name of the pre-existing
  // boolean parameter threaded through validate()/assertSubsetOrDie for the
  // #970 flag. Aliasing the import avoids shadowing that parameter rather than
  // renaming it — the #970 call path stays byte-identical.
  expandTestSiblings as expandScopeTestSiblings,
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
 * Read the value operand of a value-taking flag, REFUSING one that is itself a
 * flag. Used by the #1020 flags only.
 *
 * `--assert-subset` (#796) consumes `argv[i + 1]` BLIND, so
 * `--assert-subset --assert-disjoint x.json` reads `--assert-disjoint` as its
 * path value. That behaviour is deliberately left untouched — its no-value
 * message is pinned byte-for-byte by
 * tests/scripts/validate-wave-scope.test.mjs — but the flags added here do not
 * inherit it: a swallowed flag is silent (the mode never runs, and the caller
 * believes it did), whereas this refusal is loud and one line long.
 *
 * An EMPTY value is the same failure class and is refused for the same reason.
 * `--assert-disjoint ""` is what a failed `$(...)` capture of the materializer's
 * stdout produces; since the mode is gated on a truthy path, the empty string
 * silently skipped the collision check and still exited 0 (#1083).
 *
 * @param {string[]} argv
 * @param {number} i - index of the FLAG token
 * @param {string} flag - the flag name, for the error message
 * @returns {string}
 */
function flagValue(argv, i, flag) {
  const value = argv[i + 1];
  if (value === undefined || value === '' || value.startsWith('--')) {
    die(`${flag} requires a file-path argument`, 1);
  }
  return value;
}

/**
 * Parse CLI flags out of argv, leaving positional args behind.
 *
 * Recognised: `--assert-subset <path>` (#796), `--expand-test-siblings` (#970),
 * `--assert-disjoint <path>` and `--union <path>` (#1020). Everything else is
 * treated as a positional argument (the wave-scope.json file path), preserving
 * legacy behaviour where argv[2] is the input file.
 *
 * The #1020 branches sit BEFORE the positional fallback, as their own `else if`
 * arms: routed through the fallback instead, `--assert-disjoint` would be read
 * as a wave-scope.json path and the mode would never run.
 *
 * @param {string[]} argv - full process.argv
 * @returns {{ assertSubset: string|null, expandTestSiblings: boolean,
 *             assertDisjoint: string|null, union: string|null, positionals: string[] }}
 */
function parseArgs(argv) {
  const positionals = [];
  let assertSubset = null;
  let expandTestSiblings = false;
  let assertDisjoint = null;
  let union = null;
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
    } else if (a === '--assert-disjoint') {
      assertDisjoint = flagValue(argv, i, '--assert-disjoint');
      i++; // consume the value
    } else if (a === '--union') {
      union = flagValue(argv, i, '--union');
      i++; // consume the value
    } else {
      positionals.push(a);
    }
  }
  return { assertSubset, expandTestSiblings, assertDisjoint, union, positionals };
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
 * Shape-check ONE optional identifier field: present ⇒ a non-empty string.
 *
 * Returns whether the key was PRESENT at all (regardless of validity), so the
 * caller can distinguish "absent" from "present but malformed" — the two need
 * different treatment and only the first is a warning.
 *
 * An EMPTY string is an error rather than a second flavour of absent, for the
 * reason `sessionAttribution()` (scripts/lib/events.mjs) already states about
 * omitting the key: an empty id satisfies a truthiness check while attributing
 * to nothing. A reader comparing `manifest.session === <own session id>` would
 * then treat the manifest as FOREIGN (ignore it) where the writer meant
 * UNBOUND (enforce it) — the two dispositions are opposites, so the ambiguity
 * is not cosmetic. Absence is the only honest encoding of "not session-bound".
 *
 * @param {Record<string, unknown>} obj
 * @param {string} key
 * @param {string[]} errors
 * @returns {boolean} true when the key is present (valid or not)
 */
function validateOptionalSessionId(obj, key, errors) {
  if (!(key in obj) || obj[key] === undefined) return false;
  const value = obj[key];
  const t = value === null ? 'null' : typeof value;
  if (t !== 'string') {
    errors.push(`${key} must be a non-empty string, got type: ${t}`);
    return true;
  }
  if (/** @type {string} */ (value).length === 0) {
    errors.push(
      `${key} must be a non-empty string, got: "" — an empty id attributes to nothing; omit the key entirely to declare the manifest unbound`,
    );
  }
  return true;
}

/**
 * Validate the OPTIONAL session binding (#1123): `session_id` (the raw session
 * id of the session that WROTE this manifest) and its human-readable twin
 * `semantic_session_id`. Both come from one `sessionAttribution(repoRoot)`
 * call — see `skills/wave-executor/wave-loop.md` § Scope Manifest. The
 * pre-#1153 spellings `session` / `semantic_session` are still ACCEPTED here
 * (read side only, until the next minor release) — key names come from
 * `MANIFEST_SESSION_KEYS` so the writer and every reader share one list.
 *
 * Deliberately NOT part of {@link validateRequired}, and that is a compatibility
 * constraint rather than a preference: `wave-scope.json` is a shared
 * working-copy artefact, every manifest written before #1123 lacks the field,
 * and the pre-union skeleton of § Scope Manifest 3.3 is fed through this very
 * validator before the union exists. Requiring it would reject manifests the
 * documented procedure itself produces. The absent case therefore WARNS — the
 * flip to an error belongs to a later release, once no legacy writer remains.
 *
 * @param {Record<string, unknown>} obj
 * @param {string[]} errors
 * @param {string[]} warnings
 */
function validateSession(obj, errors, warnings) {
  let present = false;
  MANIFEST_SESSION_KEYS.current.forEach((key, i) => {
    const legacyKey = MANIFEST_SESSION_KEYS.legacy[i];
    const hasCurrent = validateOptionalSessionId(obj, key, errors);
    const hasLegacy = validateOptionalSessionId(obj, legacyKey, errors);
    // Both spellings of the SAME slot, disagreeing, is the one case the reader
    // cannot resolve honestly: it silently prefers `key` and drops the other
    // id, so a manifest that names two different sessions would classify as
    // `own` for one of them. Name it here rather than let the preference decide.
    if (hasCurrent && hasLegacy && obj[key] !== obj[legacyKey]) {
      errors.push(
        `${key} and legacy ${legacyKey} are both present with DIFFERENT values — ` +
          'a manifest binds to exactly one session; drop the legacy key (accepted on ' +
          'the read side only, until the next minor release, #1153)',
      );
    }
    if (i === 0) present = hasCurrent || hasLegacy;
  });
  if (!present) {
    warnings.push(
      'no session field — manifest is not session-bound (legacy, #1123), so every session sharing this ' +
        'working copy is enforced against it. The writer derives it from sessionAttribution() — see ' +
        'skills/wave-executor/wave-loop.md § Scope Manifest.',
    );
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
  // #1057 — an empty union under a WRITABLE role. WARN, never error, and the
  // distinction is measured rather than stylistic: `skills/wave-executor/wave-loop.md`
  // § Scope Manifest deliberately feeds a skeleton with `"allowedPaths": []`
  // through THIS validator in `--assert-disjoint` and `--union` mode, BEFORE the
  // union exists to be written. An error would break the documented procedure
  // that produces the very field it complains about.
  //
  // Named ceiling (BV-004): the warning therefore also fires on that legitimate
  // skeleton run — one stderr line on a happy path, accepted because the
  // alternative is a mode-conditional warning, i.e. a second place that has to
  // enumerate the modes correctly. Revisit if a third empty-skeleton mode lands.
  if (ap.length === 0 && typeof obj.role === 'string' && obj.role.trim().length > 0
      && !isReadOnlyWaveRole(obj.role)) {
    warnings.push(
      `allowedPaths is empty for role "${obj.role}" — every write in this wave will be DENIED by ` +
      `hooks/enforce-scope.mjs. Empty is intentional only for a read-only role ` +
      `(${READ_ONLY_WAVE_ROLES.join(', ')}); for a writable role it usually means the coordinator's ` +
      `--union step did not complete. Expected while validating the pre-union skeleton; otherwise ` +
      `re-run --union and rewrite the manifest.`,
    );
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
 * Read + shape-check the per-agent scope SIDECAR shared by `--assert-disjoint`
 * and `--union` (#1020). Exits on any defect; returns the records on success.
 *
 * Exit codes mirror {@link assertSubsetOrDie} exactly: 2 for I/O (missing, not a
 * regular file, unreadable), 1 for every content defect.
 *
 * ## Why the shape check is STRICTER than the library's tolerance
 * `findScopeCollisions` / `unionFileScopes` are fail-closed and never throw:
 * they SKIP a member that is not an object, and treat a missing `files` as `[]`.
 * That is right for a hook-hot-path primitive and wrong for a CLI. A sidecar
 * that spells the key `file:` instead of `files:` would then contribute nothing
 * and both modes would report success on a scope that silently vanished — a
 * path the operator NAMED and the tool did not honour. The absent-input guard
 * belongs in the CLI layer (recorded learning, conf 0.80: a tolerant reader
 * cannot carry a CLI's absent-input guard), so `files` is REQUIRED here.
 *
 * `id` is deliberately NOT required: scope-gate's `normalizeAgentScopes` runs a
 * record with no usable id as `<unnamed#i>` rather than dropping it, precisely
 * because an unreviewed scope is the one that collides. Requiring it here would
 * reject exactly the input that contract was written to keep.
 *
 * @param {string} sidecarPath
 * @param {string} flag - the flag name, for error messages
 * @returns {Array<{id?: string, files: string[]}>}
 */
function readAgentScopesOrDie(sidecarPath, flag) {
  if (!existsSync(sidecarPath) || !statSync(sidecarPath).isFile()) {
    die(`Cannot read ${flag} file: ${sidecarPath}`, 2);
  }
  let raw;
  try {
    raw = readFileSync(sidecarPath, 'utf8');
  } catch (err) {
    die(`Cannot read ${flag} file ${sidecarPath}: ${err.message}`, 2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    die(`${flag} file is not valid JSON: ${sidecarPath}`, 1);
  }
  if (!Array.isArray(parsed)) {
    const t = parsed === null ? 'null' : typeof parsed;
    die(
      `${flag} file must be a JSON array of {id, files} records, got type: ${t} — an object map would silently swallow a duplicate agent id`,
      1,
    );
  }
  for (let i = 0; i < parsed.length; i++) {
    const rec = parsed[i];
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      die(`${flag} file entry #${i} must be an object with a "files" array`, 1);
    }
    if (!Array.isArray(rec.files) || !rec.files.every((f) => typeof f === 'string')) {
      die(`${flag} file entry #${i} ("${rec.id ?? '<unnamed>'}") must have a "files" string array`, 1);
    }
  }
  return parsed;
}

/**
 * The repo's tracked files, for {@link findScopeCollisions}' glob∩glob witness
 * stage. Spawned HERE and injected as a parameter because
 * `scripts/lib/scope-gate.mjs` is hook-safe (pure, sync, no I/O, no spawn) and
 * `hooks/enforce-scope.mjs` reaches it on a hot path.
 *
 * An unavailable git (not a repo, git missing, huge output) is NOT an error:
 * the library documents `knownFiles` as optional — stage 3a simply has fewer
 * witnesses and the prefix fallback of stage 3b carries the load. Silent by
 * design: a WARN here would print on the success path of a mode whose contract
 * is "quiet when clean".
 *
 * @returns {string[]}
 */
function knownRepoFiles() {
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 };
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], opts).trim();
    if (!root) return [];
    // -z: NUL-separated. Without it git QUOTES paths containing non-ASCII or
    // special characters, and a quoted path would never match a scope entry.
    return execFileSync('git', ['ls-files', '-z'], { ...opts, cwd: root })
      .split('\0')
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

/**
 * Assert that no file is claimed by two agents of the SAME wave (#1020).
 * Exits 1 with one message per collision (plus one per duplicate agent id);
 * returns silently when the wave is clean.
 *
 * @param {string} sidecarPath
 */
function assertDisjointOrDie(sidecarPath) {
  const agentScopes = readAgentScopesOrDie(sidecarPath, '--assert-disjoint');
  const { ok, collisions, duplicateIds } = findScopeCollisions(agentScopes, {
    knownFiles: knownRepoFiles(),
  });
  if (ok) return;

  // Duplicate ids FIRST: they are a malformed plan, and a reader who fixes them
  // may well change which collisions remain.
  for (const id of duplicateIds) {
    process.stderr.write(
      `ERROR: duplicate agent id in ${sidecarPath}: "${id}" — ids must be unique per wave; a copy-paste duplicate hides one agent's scope from every per-agent check\n`,
    );
  }
  for (const c of collisions) {
    process.stderr.write(
      `ERROR: wave scope collision (${c.kind}): agents "${c.a}" and "${c.b}" both claim [${c.evidence.join(', ')}]\n`,
    );
  }
  process.stderr.write(
    `ERROR: ${collisions.length} scope collision(s), ${duplicateIds.length} duplicate id(s) — every file must belong to exactly ONE agent per wave (#1020; .claude/rules/parallel-sessions.md § Decision Tree)\n`,
  );
  process.exit(1);
}

/**
 * QUERY MODE (#1020): print `expandTestSiblings(unionFileScopes(scopes), {role})`
 * as JSON on stdout, using the MANIFEST'S own role. Replaces the manifest echo —
 * see the STDOUT CONTRACT note in the file header.
 *
 * @param {Record<string, unknown>} obj - the already schema-validated wave-scope object
 * @param {string} sidecarPath
 */
function emitUnion(obj, sidecarPath) {
  const agentScopes = readAgentScopesOrDie(sidecarPath, '--union');
  const allowedPaths = expandScopeTestSiblings(unionFileScopes(agentScopes), { role: obj.role });
  process.stdout.write(`${JSON.stringify(allowedPaths, null, 2)}\n`);
}

/**
 * Main validation entry point. Reads input, validates, exits with appropriate code.
 * @param {string} input - raw JSON string
 * @param {string|null} [assertSubsetPath] - optional agent fileScope file for the #796 subset assertion
 * @param {boolean} [expandTestSiblings] - opt-in #970 test-sibling coverage assertion
 * @param {string|null} [assertDisjointPath] - optional per-agent scope sidecar for the #1020 collision check
 * @param {string|null} [unionPath] - optional per-agent scope sidecar for the #1020 union query mode
 */
function validate(
  input,
  assertSubsetPath = null,
  expandTestSiblings = false,
  assertDisjointPath = null,
  unionPath = null,
) {
  const obj = parseJson(input);
  const errors = [];
  const warnings = [];

  validateRequired(obj, errors);
  validateSession(obj, errors, warnings);
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

  // #1020 — collision check runs AFTER the #796/#970 assertions, for the same
  // reason #970 runs after #796 (see assertSubsetOrDie): a manifest that
  // violates BOTH the subset relation and disjointness must keep the older,
  // byte-pinned subset message. Only ever ADDS a failure mode.
  if (assertDisjointPath) {
    assertDisjointOrDie(assertDisjointPath);
  }

  // #1020 QUERY MODE — replaces the echo below; see the STDOUT CONTRACT note in
  // the file header. Last, so every assertion above still gates it.
  if (unionPath) {
    emitUnion(obj, unionPath);
    return;
  }

  // Echo validated JSON to stdout (trailing newline normalised)
  process.stdout.write(input.endsWith('\n') ? input : input + '\n');
}

const { assertSubset, expandTestSiblings, assertDisjoint, union, positionals } = parseArgs(
  process.argv,
);
validate(readInput(positionals[0]), assertSubset, expandTestSiblings, assertDisjoint, union);
