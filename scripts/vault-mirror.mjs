#!/usr/bin/env node
/**
 * vault-mirror.mjs — JSONL-to-Markdown mirror for the Meta-Vault (Issue #14).
 *
 * Reads a JSONL file (one JSON object per line), produces Markdown notes with
 * valid vaultFrontmatterSchema frontmatter, and writes them into the vault.
 *
 * CLI usage:
 *   node vault-mirror.mjs --vault-dir <path> --source <jsonl-path> --kind <learning|session> [--dry-run]
 *
 * Exit codes:
 *   0 — success (including idempotent no-op)
 *   1 — validation error (malformed JSON line, bad slug, etc.)
 *   2 — filesystem error
 *
 * Output: one JSON line per action on stdout:
 *   {"action":"created|updated|skipped-noop|skipped-handwritten|skipped-collision-resolved","path":"...","kind":"...","id":"..."}
 *
 * Idempotency rules:
 *   1. File does not exist → create.
 *   2. File exists, has _generator marker, id matches → overwrite only if updated would advance; else skipped-noop.
 *   3. File exists, lacks _generator → skip (hand-written). Log to stderr.
 *   4. File exists, has _generator, id differs → collision-disambiguate by appending -<first8 of uuid>.
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

const vaultDir = getArg('--vault-dir');
const source = getArg('--source');
const kind = getArg('--kind');
const dryRun = args.includes('--dry-run');
const strictSchema = args.includes('--strict-schema');
const noCommit = args.includes('--no-commit');
const force = args.includes('--force');
const sessionIdArg = getArg('--session-id');

if (!vaultDir || !source || !kind) {
  process.stderr.write(
    'Usage: node vault-mirror.mjs --vault-dir <path> --source <jsonl-path> --kind <learning|session> [--dry-run] [--strict-schema] [--no-commit] [--force] [--session-id <id>]\n',
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
  const ctx = { vaultDir, dryRun, kind, force };

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
