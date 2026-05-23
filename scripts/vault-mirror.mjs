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

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';

import { processLearning, processSession } from './lib/vault-mirror/process.mjs';
import { autoCommitVaultMirror } from './lib/vault-mirror/auto-commit.mjs';

// ── CLI argument parsing ──────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

// --help support: print usage and exit 0 (no other validation runs).
if (args.includes('--help') || args.includes('-h')) {
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

const vaultDir = getArg('--vault-dir');
const source = getArg('--source');
const kind = getArg('--kind');
const dryRun = args.includes('--dry-run');
const strictSchema = args.includes('--strict-schema');
const noCommit = args.includes('--no-commit');
const force = args.includes('--force');
const sessionIdArg = getArg('--session-id');

// Quality-gate thresholds (PRD F1.2). Parse as numbers; reject malformed input
// loudly so CI cannot accidentally pass a string ("400px") and silently fall
// back to NaN comparisons (NaN < anything === false → quality gate disabled).
const QUALITY_MIN_NARRATIVE_DEFAULT = 400;
const QUALITY_MIN_CONFIDENCE_DEFAULT = 0.5;

function parseIntFlag(name, fallback) {
  const raw = getArg(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== String(raw).trim()) {
    process.stderr.write(`vault-mirror: invalid integer for ${name}: "${raw}"\n`);
    process.exit(1);
  }
  return n;
}

function parseFloatFlag(name, fallback) {
  const raw = getArg(name);
  if (raw === undefined) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) {
    process.stderr.write(`vault-mirror: invalid number for ${name}: "${raw}"\n`);
    process.exit(1);
  }
  return n;
}

const qualityMinNarrativeChars = parseIntFlag(
  '--quality-min-narrative-chars',
  QUALITY_MIN_NARRATIVE_DEFAULT,
);
const qualityMinConfidence = parseFloatFlag(
  '--quality-min-confidence',
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(resolve(vaultDir))) {
    process.stderr.write(`vault-mirror: vault-dir not found: ${vaultDir}\n`);
    process.exit(2);
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
        const entryId = entry.id ?? entry.session_id ?? null;
        process.stdout.write(
          JSON.stringify({ action: 'skipped-invalid', path: null, kind, id: entryId }) + '\n',
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
    autoCommitVaultMirror(resolve(vaultDir), sessionIdArg);
  }
}

main().catch((err) => {
  process.stderr.write(`vault-mirror: unexpected error: ${err.message}\n`);
  process.exit(2);
});
