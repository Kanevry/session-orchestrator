/**
 * prune.mjs — plan and apply the retention rules to the EXISTING mirror zones
 * (`40-learnings/`, `50-sessions/`) of a vault. Issue #1513.
 *
 * The mirror (`process.mjs`) stops producing ballast from now on; this module
 * cleans up what it produced before. Same rules, same module for them:
 * `./retention.mjs`.
 *
 * ## What it decides, per mirror-owned note (one reason per note)
 *
 * | reason                 | zone      | action  | rule |
 * |------------------------|-----------|---------|------|
 * | `duplicate`            | both      | archive | same normalised insight (learnings), or the same note id already at the relocation target; the canonical copy is kept |
 * | `superseded`           | learnings | archive | same slug modulo hyphens (pre-#725 / post-#725 slug of one subject) with a different insight — the newest `updated` is kept; or the mirror already marked it `archived-reason: superseded` |
 * | `expired`              | learnings | archive | frontmatter `expires:` before today, or already marked `archived-reason: expired` |
 * | `metrics-only-session` | sessions  | archive | `## Notes` free text below `min-narrative-chars`; its row is written to the month rollup FIRST |
 * | `namespace-alias`      | both      | move    | the namespace folder is an alias of another (explicit `--alias`, or the same name modulo hyphens where only the other one has hyphens) |
 * | `flat-relocate`        | both      | move    | a flat legacy note (no namespace folder) whose `source-repo` names its namespace |
 *
 * Canonical copy of a duplicate group, in this order: sits in its own
 * namespace folder > sits in any namespace folder > carries `source-record` >
 * more hyphens in the file name (the post-#725 slug) > newer `updated` >
 * path order.
 *
 * ## What it never does
 *
 * - Touch a note without `_generator: session-orchestrator-vault-mirror@1`
 *   (hand-written notes), a rollup, or anything outside the two zones.
 * - Delete. `archive` moves the note to `90-archive/mirror/<zone>/<same path>`
 *   with `status: archived` + `archived-reason`; `move` renames inside the zone.
 *   Git sees renames; history stays.
 * - Write anything in plan mode. {@link applyPrune} is the only write path.
 *
 * Idempotent: after an apply, the archived notes are out of the zones, the
 * moved notes sit where the plan computes them, and the rollups already hold
 * their rows — a second plan is empty.
 *
 * @module scripts/lib/vault-mirror/prune
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { parseFrontmatter, subjectToSlug } from './utils.mjs';
import {
  GENERATOR_MARKER,
  ROLLUP_PREFIX,
  archivePathFor,
  markArchived,
  noteInsightKey,
  noteNarrativeChars,
  renderRollup,
  rollupRelPath,
  rollupRowFromNote,
} from './retention.mjs';

export const ZONES = Object.freeze(['40-learnings', '50-sessions']);
export const MANIFEST_SCHEMA = 'vault-mirror-prune/1';

const dehyphen = (s) => String(s).replace(/-/g, '');
const hyphens = (s) => (String(s).match(/-/g) || []).length;

/**
 * Read every mirror-owned note of both zones. Depth: `<zone>/<file>` (flat) or
 * `<zone>/<ns>/<file>`; anything deeper is not a mirror layout and is ignored.
 */
function readZoneNotes(vaultDir) {
  const notes = [];
  let handwritten = 0;
  for (const zone of ZONES) {
    const zoneAbs = join(vaultDir, zone);
    let top;
    try {
      top = readdirSync(zoneAbs, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = [];
    for (const ent of top) {
      if (ent.isFile() && ent.name.endsWith('.md')) files.push({ dirNs: '', name: ent.name });
      else if (ent.isDirectory()) {
        let inner;
        try {
          inner = readdirSync(join(zoneAbs, ent.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const f of inner) if (f.isFile() && f.name.endsWith('.md')) files.push({ dirNs: ent.name, name: f.name });
      }
    }
    for (const { dirNs, name } of files) {
      const rel = dirNs ? `${zone}/${dirNs}/${name}` : `${zone}/${name}`;
      if (name.startsWith(ROLLUP_PREFIX)) continue;
      let content;
      try {
        content = readFileSync(join(vaultDir, rel), 'utf8');
      } catch {
        continue;
      }
      const fm = parseFrontmatter(content);
      if (!fm || fm['_generator'] !== GENERATOR_MARKER) {
        handwritten += 1;
        continue;
      }
      notes.push({ rel, zone, dirNs, name, base: name.slice(0, -3), fm, content });
    }
  }
  return { notes, handwritten };
}

/**
 * Namespace alias resolver: explicit map first, then the hyphen rule — `ns`
 * maps to a sibling folder (in either zone) with the same name modulo hyphens
 * when `ns` has fewer hyphens (the directory-name fallback of the namespace
 * resolver drops them; the remote-derived name keeps them).
 */
function makeAliasResolver(notes, explicit) {
  const present = new Set(notes.map((n) => n.dirNs).filter(Boolean));
  for (const to of Object.values(explicit)) present.add(to);
  const byKey = new Map();
  for (const ns of [...present].sort()) {
    const k = dehyphen(ns);
    const cur = byKey.get(k);
    if (cur === undefined || hyphens(ns) > hyphens(cur)) byKey.set(k, ns);
  }
  const auto = {};
  for (const ns of present) {
    const target = byKey.get(dehyphen(ns));
    if (target !== ns && hyphens(target) > hyphens(ns)) auto[ns] = target;
  }
  const resolveNs = (ns) => {
    if (!ns) return ns;
    if (Object.hasOwn(explicit, ns)) return explicit[ns];
    return auto[ns] ?? ns;
  };
  const used = {};
  for (const ns of present) if (resolveNs(ns) !== ns) used[ns] = resolveNs(ns);
  return { resolveNs, aliases: used };
}

function canonicalRank(a, b) {
  const own = (n) => (n.dirNs !== '' && n.dirNs === n.effNs ? 1 : 0);
  const inNs = (n) => (n.dirNs !== '' ? 1 : 0);
  const rec = (n) => (n.fm['source-record'] ? 1 : 0);
  return (
    own(b) - own(a) ||
    inNs(b) - inNs(a) ||
    rec(b) - rec(a) ||
    hyphens(b.base) - hyphens(a.base) ||
    String(b.fm.updated ?? '').localeCompare(String(a.fm.updated ?? '')) ||
    a.rel.localeCompare(b.rel)
  );
}

/**
 * Plan the prune. Reads only.
 *
 * @param {object} opts
 * @param {string} opts.vaultDir absolute vault root
 * @param {string} opts.today `YYYY-MM-DD`
 * @param {number} [opts.minNarrativeChars=400]
 * @param {Record<string,string>} [opts.aliases] explicit namespace aliases
 * @returns {{actions: object[], counts: Record<string, number>, aliases: Record<string,string>, handwritten: number, rollups: Record<string, object[]>}}
 */
export function planPrune({ vaultDir, today, minNarrativeChars = 400, aliases = {} }) {
  if (typeof vaultDir !== 'string' || vaultDir.length === 0) throw new TypeError('planPrune: vaultDir is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today))) throw new TypeError(`planPrune: today must be YYYY-MM-DD, got ${today}`);
  const root = resolve(vaultDir);
  const { notes, handwritten } = readZoneNotes(root);
  const { resolveNs, aliases: usedAliases } = makeAliasResolver(notes, aliases);

  for (const n of notes) {
    const sourceRepo = n.fm['source-repo'] ? subjectToSlug(n.fm['source-repo']) : '';
    n.effNs = n.dirNs ? resolveNs(n.dirNs) : resolveNs(sourceRepo);
  }

  /** @type {Map<string, {reason: string, keep?: string}>} */
  const decided = new Map();
  const decide = (n, reason, keep) => {
    if (!decided.has(n.rel)) decided.set(n.rel, keep ? { reason, keep } : { reason });
  };

  // ── learnings: duplicate → superseded → expired ────────────────────────────
  const learnings = notes.filter((n) => n.zone === '40-learnings' && n.fm.type === 'learning');
  const byInsight = new Map();
  for (const n of learnings) {
    n.insightKey = noteInsightKey(n.content);
    if (!n.insightKey) continue;
    if (!byInsight.has(n.insightKey)) byInsight.set(n.insightKey, []);
    byInsight.get(n.insightKey).push(n);
  }
  for (const group of byInsight.values()) {
    if (group.length < 2) continue;
    const buckets = new Map();
    for (const n of group) {
      if (!buckets.has(n.effNs)) buckets.set(n.effNs, []);
      buckets.get(n.effNs).push(n);
    }
    const named = [...buckets.keys()].filter(Boolean).sort();
    for (const ns of named) {
      const sorted = buckets.get(ns).sort(canonicalRank);
      for (const n of sorted.slice(1)) decide(n, 'duplicate', sorted[0].rel);
    }
    const unnamed = (buckets.get('') ?? []).sort(canonicalRank);
    if (named.length > 0) {
      const keeper = buckets.get(named[0])[0];
      for (const n of unnamed) decide(n, 'duplicate', keeper.rel);
    } else {
      for (const n of unnamed.slice(1)) decide(n, 'duplicate', unnamed[0].rel);
    }
  }

  const bySlug = new Map();
  for (const n of learnings) {
    if (decided.has(n.rel)) continue;
    const k = `${n.effNs}\0${dehyphen(n.base)}`;
    if (!bySlug.has(k)) bySlug.set(k, []);
    bySlug.get(k).push(n);
  }
  for (const group of bySlug.values()) {
    if (group.length < 2) continue;
    const sorted = group.sort(
      (a, b) => String(b.fm.updated ?? '').localeCompare(String(a.fm.updated ?? '')) || canonicalRank(a, b),
    );
    for (const n of sorted.slice(1)) decide(n, 'superseded', sorted[0].rel);
  }

  for (const n of learnings) {
    const marked = n.fm.status === 'archived' ? n.fm['archived-reason'] : '';
    if (marked === 'superseded' || marked === 'expired') decide(n, marked);
    else if (/^\d{4}-\d{2}-\d{2}/.test(String(n.fm.expires ?? '')) && String(n.fm.expires).slice(0, 10) < today) {
      decide(n, 'expired');
    }
  }

  // ── sessions: metrics-only → rollup + archive ──────────────────────────────
  /** @type {Record<string, object[]>} rollup rel path → rows */
  const rollups = {};
  const sessions = notes.filter((n) => n.zone === '50-sessions' && n.fm.type === 'session');
  const unparseable = new Set();
  for (const n of sessions) {
    if (noteNarrativeChars(n.content) >= minNarrativeChars) continue;
    const row = rollupRowFromNote(n.content, { id: n.base });
    if (row === null) {
      unparseable.add(n.rel);
      continue;
    }
    const rollup = rollupRelPath(n.effNs, row.date.slice(0, 7));
    (rollups[rollup] ??= []).push(row);
    decided.set(n.rel, { reason: 'metrics-only-session', rollup });
  }

  // ── relocation of the survivors: alias folder / flat legacy layout ─────────
  const existingRel = new Set(notes.map((n) => n.rel));
  const claimed = new Set();
  const actions = [];
  for (const n of notes) {
    const d = decided.get(n.rel);
    if (d) {
      actions.push({ path: n.rel, reason: d.reason, action: 'archive', target: archivePathFor(n.rel), ...(d.keep ? { keep: d.keep } : {}), ...(d.rollup ? { rollup: d.rollup } : {}) });
      continue;
    }
    if (unparseable.has(n.rel)) {
      actions.push({ path: n.rel, reason: 'metrics-only-session', action: 'keep', note: 'no date or id to roll up' });
      continue;
    }
    if (!n.effNs || n.effNs === n.dirNs) continue;
    const reason = n.dirNs ? 'namespace-alias' : 'flat-relocate';
    const target = `${n.zone}/${n.effNs}/${n.name}`;
    if (claimed.has(target) || existingRel.has(target)) {
      const twin = notes.find((m) => m.rel === target);
      if (twin && twin.fm.id === n.fm.id && !decided.has(twin.rel)) {
        actions.push({ path: n.rel, reason: 'duplicate', action: 'archive', target: archivePathFor(n.rel), keep: target });
      } else {
        actions.push({ path: n.rel, reason, action: 'keep', note: `relocation target taken: ${target}` });
      }
      continue;
    }
    claimed.add(target);
    actions.push({ path: n.rel, reason, action: 'move', target });
  }

  actions.sort((a, b) => a.path.localeCompare(b.path));
  const counts = {};
  for (const a of actions) {
    const k = `${a.reason}:${a.action}`;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return { actions, counts, aliases: usedAliases, handwritten, rollups };
}

/** Refuse anything that is not a regular, non-symlink file inside the vault. */
function assertInside(root, rel) {
  const abs = resolve(root, rel);
  if (!abs.startsWith(`${root}${sep}`)) throw new Error(`refusing ${rel}: outside the vault`);
  return abs;
}

function assertRegularFile(abs, rel) {
  const st = lstatSync(abs);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`refusing ${rel}: not a regular file`);
}

/**
 * Apply a plan. THE ONLY WRITE PATH. Rollups first, so a metrics-only session
 * is archived only after its row exists. Re-checks the generator marker of
 * every note right before touching it (the vault may have moved since the
 * plan). Per-path failures are collected, never thrown.
 *
 * @param {ReturnType<typeof planPrune>} plan
 * @param {{vaultDir: string}} ctx
 * @returns {{archived: number, moved: number, rollupsWritten: number, errors: Array<{path: string, error: string}>}}
 */
export function applyPrune(plan, { vaultDir }) {
  const root = resolve(vaultDir);
  const errors = [];
  let archived = 0;
  let moved = 0;
  let rollupsWritten = 0;
  const failedRollups = new Set();

  for (const [rel, rows] of Object.entries(plan.rollups ?? {})) {
    try {
      const abs = assertInside(root, rel);
      let existing = null;
      if (existsSync(abs)) {
        assertRegularFile(abs, rel);
        existing = readFileSync(abs, 'utf8');
        if (parseFrontmatter(existing)?.['_generator'] !== GENERATOR_MARKER) throw new Error('rollup exists and is not mirror-owned');
      }
      const ns = rel.split('/').length === 3 ? rel.split('/')[1] : '';
      const month = rel.match(/_rollup-(\d{4}-\d{2})\.md$/)[1];
      const next = renderRollup(existing, rows, { ns, month });
      if (next !== existing) {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, next, 'utf8');
        rollupsWritten += 1;
      }
    } catch (err) {
      failedRollups.add(rel);
      errors.push({ path: rel, error: err?.message ?? String(err) });
    }
  }

  for (const a of plan.actions ?? []) {
    if (a.action !== 'archive' && a.action !== 'move') continue;
    try {
      if (a.rollup && failedRollups.has(a.rollup)) throw new Error(`rollup ${a.rollup} was not written`);
      const src = assertInside(root, a.path);
      const dst = assertInside(root, a.target);
      assertRegularFile(src, a.path);
      const content = readFileSync(src, 'utf8');
      if (parseFrontmatter(content)?.['_generator'] !== GENERATOR_MARKER) throw new Error('no longer mirror-owned');
      mkdirSync(dirname(dst), { recursive: true });
      if (a.action === 'move') {
        if (existsSync(dst)) throw new Error(`target exists: ${a.target}`);
        renameSync(src, dst);
        moved += 1;
        continue;
      }
      const next = markArchived(content, a.reason);
      if (existsSync(dst)) {
        if (readFileSync(dst, 'utf8') !== next) throw new Error(`archive target exists with other content: ${a.target}`);
      } else {
        writeFileSync(dst, next, { encoding: 'utf8', flag: 'wx' });
      }
      unlinkSync(src);
      archived += 1;
    } catch (err) {
      errors.push({ path: a.path, error: err?.message ?? String(err) });
    }
  }
  return { archived, moved, rollupsWritten, errors };
}
