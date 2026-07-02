#!/usr/bin/env node
/**
 * vault-mirror.mjs — JSONL-to-Markdown mirror for the Meta-Vault (Issue #14).
 *
 * Reads a JSONL file (one JSON object per line), produces Markdown notes with
 * valid vaultFrontmatterSchema frontmatter, and writes them into the vault.
 *
 * CLI usage:
 *   node vault-mirror.mjs --vault-dir <path> --source <jsonl-path> --kind <learning|session>
 *                         [--dry-run] [--strict-schema] [--no-commit] [--force]
 *                         [--session-id <id>]
 *                         [--quality-min-narrative-chars <int>]  (sessions only; default 400)
 *                         [--quality-min-confidence <float>]     (learnings only; default 0.5)
 *
 * Exit codes:
 *   0 — success (including idempotent no-op)
 *   1 — validation error (malformed JSON line, bad slug, etc.)
 *   2 — filesystem error
 *
 * Output: one JSON line per action on stdout:
 *   {"action":"created|updated|skipped-noop|skipped-handwritten|skipped-collision-resolved|skipped-invalid|skipped-quality-low","path":"...","kind":"...","id":"..."}
 *
 * Idempotency rules:
 *   1. File does not exist → create.
 *   2. File exists, has _generator marker, id matches → overwrite only if updated would advance; else skipped-noop.
 *   3. File exists, lacks _generator → skip (hand-written). Log to stderr.
 *   4. File exists, has _generator, id differs → collision-disambiguate by appending -<first8 of uuid>.
 *
 * Quality gate (PRD F1.2):
 *   Learnings with confidence < --quality-min-confidence emit `skipped-quality-low`.
 *   Sessions with rendered-narrative length < --quality-min-narrative-chars emit
 *   `skipped-quality-low`. Quality gate runs BEFORE --force; --force does NOT
 *   bypass the filter. Quality-skipped entries emit `path: null` and an
 *   additional `reason` field describing the violated threshold.
 *
 * Excluded sidecars (#502 + #506):
 *   vault-mirror operates EXCLUSIVELY on JSONL sources passed via --source.
 *   The following cross-session sidecars MUST NEVER be mirrored into the
 *   vault, even if a future refactor adds directory-walking. They live under
 *   `.orchestrator/` deliberately so they survive a session close without
 *   being copied into `50-sessions/`:
 *     - `.orchestrator/pending-dream.md` (auto-dream sidecar, PRD F2.2 / #502)
 *     - `.orchestrator/dialectic-pending.md` (auto-dialectic sidecar, PRD F2.5 / #506)
 *   The next session consumes these via `/memory-cleanup --apply-pending`
 *   and `/evolve --dialectic --apply`, respectively — vault-mirror has no
 *   role in their lifecycle.
 *
 * Part of session-orchestrator vault-mirror (Issue #14).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { processLearning, processSession } from './lib/vault-mirror/process.mjs';
import { autoCommitVaultMirror } from './lib/vault-mirror/auto-commit.mjs';
import { parseColumnFlags, CliFlagError } from './lib/cli-flags.mjs';
import { resolveRepoNamespace } from './lib/vault-mirror/namespace.mjs';
import { resolveCanonicalSuffixes } from './lib/named-vault-resolver.mjs';
import { loadOwnerConfig } from './lib/owner-yaml.mjs';

// ── Canonical-vault helpers (#600 D2 / #607 D2) ────────────────────────────────
// These are module-level (above the CLI bootstrap) so the module is import-safe
// for unit tests: importing scripts/vault-mirror.mjs from vitest pulls in these
// exported helpers WITHOUT running the CLI (the CLI bootstrap + main() are gated
// behind an import.meta.url entry-guard at the bottom). The canonical-vault
// guard usage lives in main(); see the rationale block there.

/**
 * Resolve the canonical vault suffix from an env override, defaulting to
 * `/agents/vault` when the override is missing or blank (whitespace-only).
 * Pure helper so the empty-/whitespace-string fallback is unit-testable without
 * mutating process.env (#607 D2). Returns the TRIMMED override when set, so a
 * value like `"  gitlab.example.com/agents/vault  "` matches as expected.
 * @param {string|undefined} envValue
 * @returns {string}
 */
export function _resolveCanonicalSuffix(envValue) {
  return envValue && envValue.trim() ? envValue.trim() : '/agents/vault';
}

// Kept for documentation; the guard now uses resolveCanonicalSuffixes() which
// generalises this to N suffixes. The `_` prefix satisfies the no-unused-vars rule.
const _CANONICAL_VAULT_SUFFIX = _resolveCanonicalSuffix(
  process.env.VAULT_MIRROR_CANONICAL_SUFFIX,
);

/**
 * Normalize a git remote URL to a host/path tail for canonical-suffix matching
 * (#607 D2 — exported for unit tests). Strips `.git`, the `git@host:` / scheme
 * prefixes, and trailing slashes.
 * @param {string} url
 * @returns {string}
 */
export function _normalizeRemote(url) {
  return String(url ?? '')
    .trim()
    .replace(/\.git$/, '')
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/+$/, '');
}

// ── CLI argument parsing ──────────────────────────────────────────────────────
//
// Migrated to scripts/lib/cli-flags.mjs (#510). Behaviour changes vs prior
// hand-rolled getArg() parser:
//   - Unknown flags now exit 1 instead of being SILENTLY IGNORED. This is an
//     intentional uniform reject policy per #510 — grep-verified that no
//     current caller passes unknown flags (3 invocation sites: session-end
//     Phase 1, evolve Phase, vault-mirror SKILL examples; all use known flags
//     only). See W2 STATUS for the grep evidence.
// Behaviour explicitly preserved:
//   - Wet-run is the DEFAULT (omitting --dry-run → live write). This script
//     stays divergent from the other 3 migration scripts on purpose; flipping
//     it to dry-run-default would break every existing invocation in
//     skills/session-end/, skills/evolve/, and skills/vault-mirror/.
//   - --help / -h prints to stdout and exits 0 BEFORE any required-flag check.
//   - Int/float coercion for --quality-min-* (strict — string input → exit 1).

// Entry-guard (#607 D2): run the CLI bootstrap (arg parsing, validation, and
// main()) ONLY when this file is invoked directly as a subprocess
// (`node vault-mirror.mjs ...`). When imported from a unit test, argv belongs to
// the test runner — parsing it would spuriously process.exit. The exported
// helpers above are unaffected by this guard.
const _isDirectInvocation =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (_isDirectInvocation) {
  let parsedFlags;
  try {
    parsedFlags = parseColumnFlags({
    knownBool: {
      help: { short: 'h', default: false },
      'dry-run': false,
      'strict-schema': false,
      'no-commit': false,
      force: false,
    },
    knownString: {
      'vault-dir': null,
      source: null,
      kind: null,
      'session-id': null,
      'vault-name': null,
      'quality-min-narrative-chars': null,
      'quality-min-confidence': null,
    },
  });
} catch (err) {
  if (err instanceof CliFlagError) {
    process.stderr.write(`vault-mirror: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const flagValues = parsedFlags.values;

// --help support: print usage and exit 0 (no other validation runs).
if (flagValues.help === true) {
  process.stdout.write(
    [
      'Usage: node vault-mirror.mjs --vault-dir <path> --source <jsonl-path> --kind <learning|session>',
      '                              [--dry-run] [--strict-schema] [--no-commit] [--force]',
      '                              [--session-id <id>]',
      '                              [--quality-min-narrative-chars <int>]',
      '                              [--quality-min-confidence <float>]',
      '',
      'Options:',
      '  --vault-dir <path>                    Absolute path to the Meta-Vault root (required).',
      '  --source <path>                       Path to a JSONL file to mirror (required).',
      '  --kind <learning|session>             Entry kind to process (required).',
      '  --dry-run                             Parse + render but write nothing.',
      '  --strict-schema                       Abort with exit 1 if any entry was skipped-invalid.',
      '  --no-commit                           Suppress the auto-commit phase (default if --session-id is omitted).',
      '  --force                               Re-render existing notes even when updated would not advance.',
      '                                        NOTE: --force does NOT bypass the quality gate (PRD F1.2).',
      '  --session-id <id>                     Opt-in: also auto-commit mirror artifacts on success.',
      '  --vault-name <name>                   Override the repo-derived namespace segment in the vault.',
      '                                        When set, mirrors write under <vault-name>/ instead of the',
      '                                        git-derived repo identifier. Maps to vault-integration.vault-name',
      '                                        in Session Config. Sanitised to a lowercase kebab slug.',
      '  --quality-min-narrative-chars <int>   Sessions: minimum rendered-narrative length (default 400).',
      '                                        Entries below the threshold emit "skipped-quality-low".',
      '  --quality-min-confidence <float>      Learnings: minimum confidence threshold (default 0.5).',
      '                                        Entries below the threshold emit "skipped-quality-low".',
      '',
      'See skills/vault-mirror/SKILL.md for full action semantics.',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const vaultDir = flagValues['vault-dir'];
const source = flagValues.source;
const kind = flagValues.kind;
const dryRun = flagValues['dry-run'] === true;
const strictSchema = flagValues['strict-schema'] === true;
const noCommit = flagValues['no-commit'] === true;
const force = flagValues.force === true;
const sessionIdArg = flagValues['session-id'];
const vaultName = flagValues['vault-name'] ?? null;

// Quality-gate thresholds (PRD F1.2). Parse as numbers; reject malformed input
// loudly so CI cannot accidentally pass a string ("400px") and silently fall
// back to NaN comparisons (NaN < anything === false → quality gate disabled).
const QUALITY_MIN_NARRATIVE_DEFAULT = 400;
const QUALITY_MIN_CONFIDENCE_DEFAULT = 0.5;

function parseIntFlag(name, raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== String(raw).trim()) {
    process.stderr.write(`vault-mirror: invalid integer for ${name}: "${raw}"\n`);
    process.exit(1);
  }
  return n;
}

function parseFloatFlag(name, raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) {
    process.stderr.write(`vault-mirror: invalid number for ${name}: "${raw}"\n`);
    process.exit(1);
  }
  return n;
}

const qualityMinNarrativeChars = parseIntFlag(
  '--quality-min-narrative-chars',
  flagValues['quality-min-narrative-chars'],
  QUALITY_MIN_NARRATIVE_DEFAULT,
);
const qualityMinConfidence = parseFloatFlag(
  '--quality-min-confidence',
  flagValues['quality-min-confidence'],
  QUALITY_MIN_CONFIDENCE_DEFAULT,
);

if (!vaultDir || !source || !kind) {
  process.stderr.write(
    'Usage: node vault-mirror.mjs --vault-dir <path> --source <jsonl-path> --kind <learning|session> [--dry-run] [--strict-schema] [--no-commit] [--force] [--session-id <id>] [--quality-min-narrative-chars <int>] [--quality-min-confidence <float>]\n',
  );
  process.exit(1);
}

if (kind !== 'learning' && kind !== 'session') {
  process.stderr.write(`vault-mirror: invalid --kind "${kind}" (expected learning or session)\n`);
  process.exit(1);
}

// ── Canonical Meta-Vault guard (#600 D2) ───────────────────────────────────────
//
// vault-dir-drift proximate cause: the existsSync(vaultDir) check below passes for
// ANY directory that happens to exist on disk. When a stray wrong-target path
// existed (e.g. a typo'd vault location), mirror writes succeeded SILENTLY into
// it — the wrong vault accumulated notes and the real Meta-Vault drifted.
//
// Defense: probe the vault-dir's git origin and refuse to mirror unless its URL
// ends with the canonical-vault path suffix (default `/agents/vault`; override
// via env VAULT_MIRROR_CANONICAL_SUFFIX, e.g. `<host>/agents/vault` for a strict
// host-qualified check). A wrong vault is a WHOLE-RUN failure (process.exit(2)),
// not a per-entry skip — mirroring even one note into the wrong place is the bug.
//
// `git remote get-url origin` exit codes (probed): 128 = not a git repo,
// 2 = git repo without an origin remote, 0 = prints the URL. Any non-zero exit or
// a non-matching URL fails closed.
//
// The VAULT_MIRROR_SKIP_CANONICAL_CHECK=1 escape hatch is load-bearing for the
// test suite: vault-mirror's own tests mirror into non-git tmp dirs and must
// bypass this network-of-trust check. It is NOT documented as an operator flag —
// production callers (session-end Phase 3.7, evolve) always target the real vault.
// Apply the same trim-as-truthy-probe pattern as #601 getConfinementRoot: a
// whitespace-only env override would otherwise short-circuit `||` and yield a
// meaningless suffix. Fail-safe (a non-matching suffix only widens rejection),
// but the bug class is recurring — fix at the source. The helpers + the
// CANONICAL_VAULT_SUFFIX const live near the top of the module (just after the
// imports) so they are import-safe and unit-testable; see _resolveCanonicalSuffix
// / _normalizeRemote there (#607 D2).

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(resolve(vaultDir))) {
    process.stderr.write(`vault-mirror: vault-dir not found: ${vaultDir}\n`);
    process.exit(2);
  }

  if (process.env.VAULT_MIRROR_SKIP_CANONICAL_CHECK !== '1') {
    const res = spawnSync('git', ['-C', resolve(vaultDir), 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
    });
    const canonicalSuffixes = resolveCanonicalSuffixes({
      ownerConfig: loadOwnerConfig().config,
      env: process.env,
    });
    const ok = res.status === 0 && canonicalSuffixes.some((s) => _normalizeRemote(res.stdout).endsWith(s));
    if (!ok) {
      const got = res.status === 0 ? res.stdout.trim() : 'no git origin';
      process.stderr.write(
        `vault-mirror: refusing to mirror — "${vaultDir}" is not the canonical Meta-Vault (expected git origin ending in one of: ${canonicalSuffixes.join(', ')}; got ${got})\n`,
      );
      process.exit(2);
    }
  }

  if (!existsSync(resolve(source))) {
    process.stderr.write(`vault-mirror: source file not found: ${source}\n`);
    process.exit(2);
  }

  const rl = createInterface({
    input: createReadStream(resolve(source), 'utf8'),
    crlfDelay: Infinity,
  });

  // Collect all lines first, then process sequentially to avoid mkdirSync/writeFileSync races
  const lines = [];
  for await (const line of rl) {
    lines.push(line);
  }

  let lineNum = 0;
  let skippedInvalidCount = 0;
  const ctx = {
    vaultDir,
    dryRun,
    kind,
    force,
    vaultName,
    qualityMinNarrativeChars,
    qualityMinConfidence,
  };

  for (const line of lines) {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (err) {
      process.stderr.write(`vault-mirror: malformed JSON on line ${lineNum}: ${err.message}\n`);
      process.exit(1);
    }

    try {
      if (kind === 'learning') {
        await processLearning(entry, lineNum, ctx);
      } else {
        await processSession(entry, lineNum, ctx);
      }
    } catch (err) {
      // Validation errors (missing required fields) → per-entry skip, not a global failure
      if (err.message.startsWith('vault-mirror:')) {
        process.stderr.write(`${err.message}\n`);
        const entryId = entry?.id ?? entry?.session_id ?? null;
        process.stdout.write(
          JSON.stringify({ action: 'skipped-invalid', path: null, kind, id: entryId }) + '\n',
        );
        skippedInvalidCount++;
        continue;
      }
      // #718: discriminate genuine filesystem/system errors (which must still
      // abort the whole run — a partially-written vault is worse than a loud
      // failure) from mapper crashes on malformed producer data (a native
      // TypeError/RangeError thrown while rendering ONE record, e.g. a shape
      // the mapper didn't defensively guard). Node system errors always carry
      // a non-empty `err.code` (EACCES/ENOSPC/EROFS/ENOENT/...) and/or
      // `err.syscall` — a plain TypeError/RangeError from JS-level property
      // access has neither, so this check is a reliable discriminator even in
      // --dry-run mode (no writes happen, so a mapper crash there can only be
      // a data-shape defect, never a real FS error).
      const isSystemError =
        (typeof err.code === 'string' && err.code.length > 0) || Boolean(err.syscall);
      if (!isSystemError) {
        process.stderr.write(
          `vault-mirror: mapper crash on line ${lineNum} (${err.message}) — record skipped\n`,
        );
        const entryId = entry?.id ?? entry?.session_id ?? null;
        process.stdout.write(
          JSON.stringify({
            action: 'skipped-invalid',
            path: null,
            kind,
            id: entryId,
            reason: 'mapper-crash',
          }) + '\n',
        );
        skippedInvalidCount++;
        continue;
      }
      // Unexpected filesystem errors → fatal
      process.stderr.write(`vault-mirror: filesystem error on line ${lineNum}: ${err.message}\n`);
      process.exit(2);
    }
  }

  // --strict-schema: abort with exit 1 when any entry was skipped-invalid.
  // Useful in CI to catch producer-side schema drift early (issue #249).
  if (strictSchema && skippedInvalidCount > 0) {
    process.stdout.write(
      JSON.stringify({ action: 'strict-schema-abort', skipped: skippedInvalidCount, kind }) + '\n',
    );
    process.stderr.write(
      `vault-mirror: --strict-schema: ${skippedInvalidCount} entries failed validation — exiting 1\n`,
    );
    process.exit(1);
  }

  // Auto-commit phase (issue #31): commit mirror artifacts so they don't pile up.
  // Opt-in: triggers only when --session-id is provided. Callers (session-end, evolve)
  // pass it explicitly; bare invocations stay quiet to preserve legacy behaviour.
  if (!dryRun && !noCommit && sessionIdArg) {
    autoCommitVaultMirror(resolve(vaultDir), sessionIdArg, resolveRepoNamespace({ vaultName }));
  }
}

  main().catch((err) => {
    process.stderr.write(`vault-mirror: unexpected error: ${err.message}\n`);
    process.exit(2);
  });
}
