#!/usr/bin/env node
/**
 * migrate-ids.mjs — one-time repair of the frontmatter `id` of notes the vault
 * mirror wrote before #1601/#1602.
 *
 * Why a separate pass: the mirror's hot path (`process.mjs`) never rewrites a
 * note because only its `id` is wrong. Its only rewrite is a full re-render
 * from the ledger record, and that re-render brought back plaintext that an
 * earlier run had masked to `[REDACTED]` (#1025) whenever the secret was
 * missing from the current env. That was the release-review finding HOCH 1 on
 * MR !148. This pass changes ONE line and nothing else.
 *
 * Contract:
 *  - Only notes with the vault-mirror `_generator` marker are considered, in
 *    `40-learnings/`, `50-sessions/` and their `90-archive/mirror/` copies,
 *    flat (`<zone>/<file>`) or namespaced (`<zone>/<ns>/<file>`). Month
 *    rollups are skipped (their id is not derived from the filename).
 *  - The new id is `noteIdFor(<ns>, <filename slug>)`: the same id the
 *    generator renders today. The namespace is the folder; a flat note uses
 *    its own `source-repo` (as `fmNamesSlug` in process.mjs does).
 *  - `schema` changes: the old id breaks the vault-sync schema (missing, over
 *    128 chars, all digits, not a kebab slug). Always planned.
 *  - `namespace` changes: the old id is the bare pre-#1602 slug. Planned only
 *    with `includeBare`, because it touches every older generated note once.
 *  - Two notes of the same layer (live, or `90-archive/`) that would end up
 *    with the same id are both left alone and reported as `conflicts`. A live
 *    note and its archive copy never conflict: the vault-sync validator does
 *    not check `90-archive/`, so blocking the live repair on its copy would
 *    leave the schema error in place.
 *  - A note whose frontmatter has no `id:` line is not planned (the one-line
 *    rewrite has no line to change); it is reported as `unrepairable`.
 *  - Apply replaces only the `id:` line inside the frontmatter
 *    (`withNoteId`), checks that nothing else changed, re-reads the file and
 *    skips it if it changed since the plan, and writes atomically: a tmp
 *    sibling in the same folder, then rename (`atomicWriteWithBackup`).
 *  - Apply refuses to write anything when the plan has more changes than
 *    `maxChanges`. The CLI requires `--max-changes` with `--apply`, so the
 *    count comes from a dry run first.
 *
 * Usage (dry run is the default and writes nothing):
 *   node scripts/lib/vault-mirror/migrate-ids.mjs --vault-dir PATH [--include-bare]
 *   node scripts/lib/vault-mirror/migrate-ids.mjs --vault-dir PATH [--include-bare] --apply --max-changes N
 *
 * Output: one JSON line per planned change ({path, from, to, reason}), then
 * one summary line. Paths are vault-relative. The `from` values are the
 * record needed to undo a run.
 *
 * Exit codes: 0 success · 1 usage error · 2 refused (over the cap), per-file
 * errors, or `unrepairable` notes left after --apply
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';

import { atomicWriteWithBackup } from '../io.mjs';
import { expandTilde } from '../common.mjs';
import { isMainModule } from '../is-main-module.mjs';
import { NOTE_ID_MAX_LENGTH, isValidSlug, noteIdFor, noteIdMatches, parseFrontmatter, slugifyIdSafe, withNoteId } from './utils.mjs';
import { ARCHIVE_ROOT, GENERATOR_MARKER, ROLLUP_PREFIX } from './retention.mjs';

const ZONES = ['40-learnings', '50-sessions'];
/** The vault-sync schema's id pattern (`skills/vault-sync/validator.mjs` slugRegex). */
const SCHEMA_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID_LINE = /^id:(.*)$/m;

/** Every `.md` of a zone root: flat files and one folder level below. */
function listZoneFiles(vaultDir, zoneRel) {
  const out = [];
  let top;
  try {
    top = readdirSync(join(vaultDir, zoneRel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of top) {
    if (ent.isFile() && ent.name.endsWith('.md')) out.push({ rel: `${zoneRel}/${ent.name}`, dirNs: '', name: ent.name });
    else if (ent.isDirectory()) {
      let inner;
      try {
        inner = readdirSync(join(vaultDir, zoneRel, ent.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of inner) {
        if (f.isFile() && f.name.endsWith('.md')) out.push({ rel: `${zoneRel}/${ent.name}/${f.name}`, dirNs: ent.name, name: f.name });
      }
    }
  }
  return out;
}

/**
 * Does the on-disk id break the vault-sync schema (`z.string().regex(slug).max(128)`)?
 * `cur` is the parseFrontmatter value (quotes stripped, always a string);
 * `raw` is the literal after `id:`. An unquoted `433` is a YAML NUMBER even
 * though parseFrontmatter hands it back as a string — the #1601 shape — so
 * the raw literal goes through a real YAML parse too.
 */
function idViolatesSchema(cur, raw) {
  if (typeof cur !== 'string' || cur.length > NOTE_ID_MAX_LENGTH || !SCHEMA_SLUG.test(cur)) return true;
  try {
    return typeof yaml.load(`id: ${raw}`)?.id !== 'string';
  } catch {
    return true;
  }
}

/** The leading frontmatter block, or null. */
function frontmatterHead(content) {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  return end === -1 ? null : content.slice(0, end);
}

/**
 * Plan the id migration. Read-only.
 *
 * @param {{ vaultDir: string, includeBare?: boolean }} opts
 * @returns {{ changes: Array<{path: string, from: string, to: string, reason: 'schema'|'namespace'}>,
 *   conflicts: Array<{path: string, to: string, reason: 'schema'|'namespace'}>, unrepairable: Array<{path: string, reason: 'no-id-line'}>,
 *   scanned: number, unrecognised: number, contents: Map<string, string> }}
 *   `contents` holds the bytes each change was planned against (apply compares them).
 */
export function planIdMigration({ vaultDir, includeBare = false }) {
  const candidates = [];
  // `<layer>:<id>` → count of notes that carry or would carry it. Counted per
  // layer: a live note and its archive copy share an id by design.
  const targets = new Map();
  const unrepairable = [];
  let scanned = 0;
  let unrecognised = 0;
  const zoneRoots = [...ZONES, ...ZONES.map((z) => `${ARCHIVE_ROOT}/${z}`)];
  for (const zoneRel of zoneRoots) {
    const layer = zoneRel.startsWith(`${ARCHIVE_ROOT}/`) ? 'archive' : 'live';
    for (const { rel, dirNs, name } of listZoneFiles(vaultDir, zoneRel)) {
      if (name.startsWith(ROLLUP_PREFIX)) continue;
      let content;
      try {
        content = readFileSync(join(vaultDir, rel), 'utf8');
      } catch {
        continue;
      }
      const fm = parseFrontmatter(content);
      if (!fm || fm['_generator'] !== GENERATOR_MARKER) continue;
      const head = frontmatterHead(content);
      if (head === null) continue;
      scanned += 1;
      const stem = name.slice(0, -'.md'.length);
      // The generator's id base: a learning's filename IS its slug; a session
      // file is named by the raw session id, which the renderer slugifies.
      const base = isValidSlug(stem) ? stem : (slugifyIdSafe(stem) ?? stem);
      const ns = dirNs || (typeof fm['source-repo'] === 'string' ? fm['source-repo'] : null);
      const to = noteIdFor(ns, base);
      const cur = typeof fm['id'] === 'string' ? fm['id'] : undefined;
      const rawLine = head.match(ID_LINE);
      if (!rawLine) {
        unrepairable.push({ path: rel, reason: 'no-id-line' });
        continue;
      }
      const from = rawLine[1].trim();
      const violates = idViolatesSchema(cur, from);
      let reason = null;
      if (violates) reason = 'schema';
      else if (cur !== to) {
        const bare = cur === base || cur === stem || noteIdMatches(cur, base, fm['source-repo']);
        if (bare && includeBare) reason = 'namespace';
        else if (!bare) unrecognised += 1;
      }
      const finalId = reason === null ? cur : to;
      if (typeof finalId === 'string') targets.set(`${layer}:${finalId}`, (targets.get(`${layer}:${finalId}`) ?? 0) + 1);
      if (reason !== null) candidates.push({ path: rel, from, to, reason, content, layer });
    }
  }
  const changes = [];
  const conflicts = [];
  const contents = new Map();
  for (const c of candidates) {
    if ((targets.get(`${c.layer}:${c.to}`) ?? 0) > 1) {
      conflicts.push({ path: c.path, to: c.to, reason: c.reason });
      continue;
    }
    changes.push({ path: c.path, from: c.from, to: c.to, reason: c.reason });
    contents.set(c.path, c.content);
  }
  return { changes, conflicts, unrepairable, scanned, unrecognised, contents };
}

/**
 * True when `next` differs from `content` in the frontmatter `id:` line only.
 * A belt against a future change to `withNoteId`, not an independent check:
 * it strips the line with the same `id:` pattern `withNoteId` rewrites, so it
 * only catches a `withNoteId` that starts touching anything else
 * (BV-002: data-loss prevention).
 */
function onlyIdLineChanged(content, next) {
  const strip = (s) => {
    const head = frontmatterHead(s);
    return head === null ? s : head.replace(ID_LINE, 'id:') + s.slice(head.length);
  };
  return strip(content) === strip(next);
}

/**
 * Apply a plan from {@link planIdMigration}.
 *
 * @param {ReturnType<typeof planIdMigration>} plan
 * @param {{ vaultDir: string, maxChanges: number, fs?: object }} opts
 *   `fs` is passed to `atomicWriteWithBackup` (test seam).
 * @returns {{ ok: boolean, refused?: 'over-limit', written: string[],
 *   skipped: Array<{path: string, reason: string}>, errors: Array<{path: string, error: string}> }}
 */
export function applyIdMigration(plan, { vaultDir, maxChanges, fs: injectedFs } = {}) {
  const written = [];
  const skipped = [];
  const errors = [];
  if (!Number.isInteger(maxChanges) || maxChanges < 0 || plan.changes.length > maxChanges) {
    return { ok: false, refused: 'over-limit', written, skipped, errors };
  }
  for (const change of plan.changes) {
    const abs = join(vaultDir, change.path);
    let content;
    try {
      content = readFileSync(abs, 'utf8');
    } catch (err) {
      errors.push({ path: change.path, error: err?.code ?? 'read-failed' });
      continue;
    }
    if (content !== plan.contents.get(change.path)) {
      skipped.push({ path: change.path, reason: 'changed-since-plan' });
      continue;
    }
    const next = withNoteId(content, change.to);
    if (next === content || !onlyIdLineChanged(content, next)) {
      skipped.push({ path: change.path, reason: 'not-a-single-line-change' });
      continue;
    }
    const res = atomicWriteWithBackup(abs, next, { tmpPrefix: '.vault-mirror-migrate-ids.tmp', ...(injectedFs ? { fs: injectedFs } : {}) });
    if (res.ok) written.push(change.path);
    else errors.push({ path: change.path, error: res.code ?? 'write-failed' });
  }
  return { ok: errors.length === 0, written, skipped, errors };
}

const HELP = `Usage: node scripts/lib/vault-mirror/migrate-ids.mjs --vault-dir PATH [--include-bare]
       [--apply --max-changes N]

Repairs the frontmatter id of vault-mirror notes (#1601/#1602). Dry run is the
default: it prints the planned changes and writes nothing. --apply needs
--max-changes N (take N from the dry run); a plan with more changes is refused.

  --include-bare   Also namespace ids that are valid but carry no repo prefix
`;

/**
 * @param {string[]} argv
 * @returns {{ vaultDir: string|null, apply: boolean, includeBare: boolean, maxChanges: number|null, help: boolean }}
 */
export function parseArgs(argv) {
  const args = { vaultDir: null, apply: false, includeBare: false, maxChanges: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--apply') args.apply = true;
    else if (a === '--include-bare') args.includeBare = true;
    else if (a === '--vault-dir') args.vaultDir = argv[++i] ?? null;
    else if (a === '--max-changes') {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) throw new Error(`invalid --max-changes "${raw}"`);
      args.maxChanges = n;
    } else throw new Error(`unknown argument "${a}"`);
  }
  return args;
}

if (isMainModule(import.meta.url)) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`migrate-ids: ${err.message}\n`);
    process.exit(1);
  }
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (!args.vaultDir) {
    process.stderr.write('migrate-ids: --vault-dir is required\n');
    process.exit(1);
  }
  if (args.apply && args.maxChanges === null) {
    process.stderr.write('migrate-ids: --apply needs --max-changes N (run without --apply first to see N)\n');
    process.exit(1);
  }
  const vaultDir = resolve(expandTilde(args.vaultDir));
  const plan = planIdMigration({ vaultDir, includeBare: args.includeBare });
  for (const c of plan.changes) process.stdout.write(`${JSON.stringify(c)}\n`);
  const summary = {
    mode: args.apply ? 'apply' : 'dry-run',
    scanned: plan.scanned,
    planned: plan.changes.length,
    conflicts: plan.conflicts,
    unrepairable: plan.unrepairable,
    unrecognised: plan.unrecognised,
  };
  if (plan.unrepairable.length > 0) {
    process.stderr.write(`migrate-ids: ${plan.unrepairable.length} note(s) have no id line and are not repaired; see "unrepairable"\n`);
  }
  if (!args.apply) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exit(0);
  }
  const res = applyIdMigration(plan, { vaultDir, maxChanges: args.maxChanges });
  process.stdout.write(`${JSON.stringify({ ...summary, ...res, written: res.written.length })}\n`);
  // A run that leaves schema violations behind (no id line, or a schema repair
  // blocked by a conflict) is not a success, even if every planned write landed.
  const schemaLeft = plan.unrepairable.length + plan.conflicts.filter((c) => c.reason === 'schema').length;
  process.exit(res.ok && schemaLeft === 0 ? 0 : 2);
}
