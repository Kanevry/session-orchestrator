#!/usr/bin/env node
/**
 * vault-mirror-prune.mjs — CLI for the mirror-zone retention prune (#1513).
 *
 * Applies the vault-mirror retention rules to the notes the mirror wrote
 * BEFORE those rules existed: expired / superseded / duplicate learnings,
 * metrics-only session notes (rolled up first), namespace-alias folders and
 * flat legacy notes. All decisions live in `scripts/lib/vault-mirror/prune.mjs`
 * (rules table in its header) and `retention.mjs`; this file is argv parsing,
 * the manifest, output and exit codes.
 *
 * SAFETY: dry run is the DEFAULT and writes nothing — not even the manifest
 * unless `--manifest` names a path. `--apply` moves files (archive → under
 * `90-archive/mirror/`), never deletes a note's content, never touches a note
 * without the mirror's `_generator` marker.
 *
 * Usage:
 *   node scripts/vault-mirror-prune.mjs --vault-dir PATH [--apply]
 *     [--manifest PATH] [--now ISO] [--min-narrative-chars N]
 *     [--alias FROM=TO ...] [--json]
 *
 * Exit codes: 0 success · 1 usage error · 2 apply finished with per-path errors
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expandTilde, redactHomeDir } from './lib/common.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { MANIFEST_SCHEMA, applyPrune, planPrune } from './lib/vault-mirror/prune.mjs';

const HELP = `Usage: node scripts/vault-mirror-prune.mjs --vault-dir PATH [--apply] [--manifest PATH]
       [--now ISO] [--min-narrative-chars N] [--alias FROM=TO ...] [--json]

Plans (default) or applies the vault-mirror retention rules to 40-learnings/
and 50-sessions/ of a vault. Only notes carrying the vault-mirror _generator
marker are considered; hand-written notes are never touched.

Options:
  --vault-dir PATH          Vault root (required; no host-local default on purpose)
  --apply                   Write: rollups, then archive moves to 90-archive/mirror/, then renames
  --manifest PATH           Write the JSON manifest (path, reason, action, target) there
  --now ISO                 Injected clock for the expiry check (default: now)
  --min-narrative-chars N   Session narrative gate (default 400, as vault-mirror.quality)
  --alias FROM=TO           Explicit namespace alias (repeatable); the hyphen rule applies without it
  --json                    Print the summary as one JSON line

Exit codes: 0 success  1 usage error  2 apply finished with per-path errors
`;

function usageError(msg) {
  process.stderr.write(`vault-mirror-prune: ${msg}\n`);
  process.exit(1);
}

export function parseArgs(argv) {
  const args = { vaultDir: null, apply: false, manifest: null, now: null, minNarrativeChars: 400, aliases: {}, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) usageError(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--help' || a === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (a === '--vault-dir') args.vaultDir = value();
    else if (a === '--apply') args.apply = true;
    else if (a === '--dry-run') args.apply = false;
    else if (a === '--manifest') args.manifest = value();
    else if (a === '--now') {
      args.now = value();
      if (!Number.isFinite(Date.parse(args.now))) usageError(`--now is not a date: ${args.now}`);
    } else if (a === '--min-narrative-chars') {
      const raw = value();
      if (!/^\d+$/.test(raw)) usageError(`--min-narrative-chars must be a non-negative integer, got ${raw}`);
      args.minNarrativeChars = Number(raw);
    } else if (a === '--alias') {
      const m = /^([a-z0-9][a-z0-9-]*)=([a-z0-9][a-z0-9-]*)$/.exec(value());
      if (!m) usageError('--alias expects FROM=TO with lowercase kebab namespaces');
      args.aliases[m[1]] = m[2];
    } else if (a === '--json') args.json = true;
    else usageError(`unknown argument ${a}`);
  }
  if (!args.vaultDir) usageError('--vault-dir is required');
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const vaultDir = resolve(expandTilde(args.vaultDir));
  const today = new Date(args.now ? Date.parse(args.now) : Date.now()).toISOString().slice(0, 10);
  const plan = planPrune({ vaultDir, today, minNarrativeChars: args.minNarrativeChars, aliases: args.aliases });

  const manifest = {
    schema: MANIFEST_SCHEMA,
    generated_at: new Date().toISOString(),
    today,
    dry_run: !args.apply,
    min_narrative_chars: args.minNarrativeChars,
    aliases: plan.aliases,
    skipped_handwritten: plan.handwritten,
    counts: plan.counts,
    rollups: Object.fromEntries(Object.entries(plan.rollups).map(([k, rows]) => [k, rows.length])),
    actions: plan.actions,
  };
  let applied = null;
  if (args.apply) {
    applied = applyPrune(plan, { vaultDir });
    // The apply result belongs in the manifest: notes written beside an
    // occupied archive target (`suffixed`) and per-path errors.
    manifest.applied = applied;
  }
  if (args.manifest) writeFileSync(resolve(expandTilde(args.manifest)), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const summary = {
    dry_run: !args.apply,
    counts: plan.counts,
    rollups: Object.keys(plan.rollups).length,
    aliases: plan.aliases,
    skipped_handwritten: plan.handwritten,
    ...(applied ? { applied: { ...applied, suffixed: applied.suffixed.length, errors: applied.errors.length } } : {}),
  };
  if (args.json) process.stdout.write(JSON.stringify(summary) + '\n');
  else {
    process.stdout.write(`vault-mirror-prune ${args.apply ? 'APPLY' : 'dry run'} (today ${today})\n`);
    for (const [k, n] of Object.entries(plan.counts).sort()) process.stdout.write(`  ${k.padEnd(36)} ${n}\n`);
    process.stdout.write(`  rollup notes                         ${Object.keys(plan.rollups).length}\n`);
    for (const [from, to] of Object.entries(plan.aliases)) process.stdout.write(`  alias ${from} -> ${to}\n`);
    if (applied) {
      process.stdout.write(`  applied: archived ${applied.archived}, moved ${applied.moved}, rollups written ${applied.rollupsWritten}, suffixed ${applied.suffixed.length}, errors ${applied.errors.length}\n`);
    }
  }
  if (applied && applied.errors.length > 0) {
    for (const e of applied.errors.slice(0, 20)) process.stderr.write(`vault-mirror-prune: ${e.path}: ${redactHomeDir(e.error)}\n`);
    return 2;
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
