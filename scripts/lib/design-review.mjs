/**
 * design-review.mjs — triggering and enforcement of the default-on design
 * review (#1452). Logic for `scripts/design-review.mjs`.
 *
 * Division of labour (agentic-designer#75): agentic-designer owns the design
 * knowledge (review contract, design-context schema, recipes); a shared package
 * in projects-baseline (#588) will own the model-free checks; this plugin owns
 * only WHEN a review runs and WHETHER close may proceed. Nothing here judges a
 * design.
 *
 * The close gate has three outcomes (decision D1 on #1452):
 *   - `pass`  — no UI changed, or every changed UI file is covered by a record.
 *   - `refuse` — UI files changed in this session AND a rendered result is
 *     possible AND no record covers them. The only blocking case.
 *   - `not-reviewable` / `unmeasured` — nothing can be rendered, or git could
 *     not say what changed. Exit 0 with a WARNING and a record written
 *     automatically, so the close is never refused for what nobody can review
 *     and never passes silently when nothing was measured.
 *
 * A record COVERS the UI files it was written for: each file is keyed by
 * sha256(path, blob hash) (D3), so a later change to a UI file re-arms the gate.
 * Records live in `design-review.jsonl` beside the events ledger, keyed by
 * worktree and branch as well as session id (a peer worktree's record never
 * counts), written with a newline guard and read back (a torn last line can no
 * longer swallow a record). The events ledger gets a slim
 * `orchestrator.design_review.recorded` event without free text or paths,
 * because the optional webhook forwards event payloads verbatim.
 */

import { createHash, randomUUID } from 'node:crypto';
import { accessSync, appendFileSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { eventsFilePath, sessionAttribution } from './events.mjs';
import { readLock } from './session-lock.mjs';
import { readProcessLocalSessionIds } from './session-identity/own-session.mjs';
import { spawnSync } from './native-command.mjs';
import { findPlaywrightConfigs, renderablePaths } from './ui-touch.mjs';

export const REVIEW_EVENT = 'orchestrator.design_review.recorded';

/** Outcomes a coordinator records; `unmeasured` is written by `check` only. */
export const REVIEW_STATUSES = Object.freeze(['reviewed', 'not-reviewable', 'owner-override']);
export const AUTO_STATUSES = Object.freeze(['not-reviewable', 'unmeasured', 'would-refuse']);

/** Close-gate modes: `warn` prints "would refuse" and exits 0 (the default; nothing switches it automatically, #1452). */
export const CLOSE_GATE_MODES = Object.freeze(['warn', 'refuse']);

/** Verdicts that judged nothing: a `reviewed` record with one is "not judged" (E3). */
export const NOT_JUDGED_VERDICTS = Object.freeze(['recapture', 'BLOCKED']);

/** Review rounds per surface and session before the decision goes to the owner. */
export const MAX_REVIEW_ROUNDS = 2;

export const DEFAULT_SURFACE = 'all';

export const REVIEWER_VERDICTS = Object.freeze({
  designer: ['ship', 'fix', 'rebuild', 'recapture'],
  'ux-evaluator': ['PROCEED', 'PROCEED_WITH_FOLLOWUPS', 'FIX_REQUIRED', 'BLOCKED'],
});

/** `/pricing/` and `pricing` are the same surface; `all` stays `all`. */
export function normalizeSurface(surface) {
  const s = typeof surface === 'string' ? surface.trim() : '';
  if (!s || s === DEFAULT_SURFACE) return DEFAULT_SURFACE;
  const path = `/${s.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  return path === '/' ? '/' : path.toLowerCase();
}

/**
 * Is there a rendered result the review can look at? Reviewable where the
 * test-runner's web driver can run: a Playwright config whose directory holds
 * the UI path (a root config holds all). Configs in excluded directories
 * (scaffolds, `node_modules`) do not count.
 *
 * @param {string} repoRoot
 * @param {string[]} [uiPaths]
 * @returns {{ reviewable: boolean, reason: string, configs: string[], renderable: string[] }}
 */
export function probeRenderedTarget(repoRoot, uiPaths = []) {
  const configs = findPlaywrightConfigs(repoRoot);
  const renderable = renderablePaths(uiPaths, configs);
  if (configs.length > 0) return { reviewable: true, reason: `web target (${configs.join(', ')})`, configs, renderable };
  return {
    reviewable: false,
    reason: 'no rendered result: no playwright.config.* in the repo, so nothing can be captured at 1440 and 390',
    configs: [],
    renderable: [],
  };
}

/**
 * Optional design inputs, detected defensively. Each is a path or `null`.
 *
 * @param {string} repoRoot
 * @param {{ homeDir?: string }} [opts]
 * @returns {{ design_context: string|null, review_contract: string|null }}
 */
export function findDesignInputs(repoRoot, opts = {}) {
  const home = opts.homeDir ?? homedir();
  const contextPath = join(repoRoot, 'docs', 'design', 'context.md');
  const contractRel = join('design-director', 'references', 'review.md');
  const contractCandidates = [
    join(repoRoot, 'skills', contractRel),
    join(repoRoot, '.claude', 'skills', contractRel),
    join(repoRoot, '.agents', 'skills', contractRel),
    join(home, '.claude', 'skills', contractRel),
    join(home, '.codex', 'skills', contractRel),
    join(home, '.agents', 'skills', contractRel),
  ];
  return {
    design_context: existsSync(contextPath) ? contextPath : null,
    review_contract: contractCandidates.find((p) => existsSync(p)) ?? null,
  };
}

/** Worktree toplevel (realpath) and branch — the key that keeps peer worktrees apart. */
export function readWorkTreeKey(repoRoot) {
  const run = (args) => {
    const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return r.status === 0 ? String(r.stdout).trim() : '';
  };
  let tree = run(['rev-parse', '--show-toplevel']) || repoRoot;
  try {
    tree = realpathSync(tree);
  } catch {
    /* keep */
  }
  return { tree, branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) || null, head: run(['rev-parse', 'HEAD']) || null };
}

/**
 * The ids this process may claim: its native session id plus the lock's ids
 * when the lock is confirmed as its own.
 */
export function readOwnIds(repoRoot) {
  const attribution = sessionAttribution(repoRoot);
  return new Set([
    ...readProcessLocalSessionIds(),
    ...[attribution.session_id, attribution.semantic_session_id].filter(Boolean),
  ]);
}

/**
 * Start of this session's window: an explicit value (STATE.md `started_at`),
 * else the session lock's `started_at`, else unknown (`null`). An explicit but
 * unparseable value is an input error for the caller, never silently ignored.
 *
 * @returns {{ sinceTime: string|null, source: 'explicit'|'lock'|'unknown', invalid?: true }}
 */
export function resolveSinceTime(repoRoot, sinceTime) {
  if (sinceTime !== undefined && sinceTime !== null) {
    const ms = Date.parse(String(sinceTime));
    if (Number.isNaN(ms)) return { sinceTime: null, source: 'explicit', invalid: true };
    return { sinceTime: new Date(ms).toISOString(), source: 'explicit' };
  }
  try {
    const lock = readLock({ repoRoot });
    if (lock && !Number.isNaN(Date.parse(lock.started_at))) {
      return { sinceTime: new Date(lock.started_at).toISOString(), source: 'lock' };
    }
  } catch {
    /* fall through */
  }
  return { sinceTime: null, source: 'unknown' };
}

/**
 * Cover keys of the given UI files in their CURRENT content:
 * `sha256(path \0 blob)[0:16]`, blob from `git hash-object`.
 *
 * @returns {string[]|null} `null` when git cannot hash them.
 */
export function coverKeys(repoRoot, paths) {
  if (paths.length === 0) return [];
  const r = spawnSync('git', ['hash-object', '--stdin-paths'], {
    cwd: repoRoot,
    input: `${paths.join('\n')}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.status !== 0) return null;
  const blobs = String(r.stdout).trim().split('\n');
  if (blobs.length !== paths.length) return null;
  return paths.map((p, i) => createHash('sha256').update(`${p}\0${blobs[i]}`).digest('hex').slice(0, 16));
}

/** `design-review.jsonl` beside the events ledger (one per repo, like the ledger). */
export function recordsFilePath(repoRoot) {
  return join(dirname(eventsFilePath(repoRoot)), 'design-review.jsonl');
}

/**
 * Parse JSONL, recovering records glued onto a torn line (`…{"id":…}`).
 *
 * @returns {{ readable: boolean, records: object[], torn: number }}
 */
export function readRecords(repoRoot) {
  const file = recordsFilePath(repoRoot);
  if (!existsSync(file)) return { readable: true, records: [], torn: 0 };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { readable: false, records: [], torn: 0 };
  }
  const records = [];
  let torn = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
      continue;
    } catch {
      torn += 1;
    }
    const at = line.lastIndexOf('{"id":');
    if (at > 0) {
      try {
        records.push(JSON.parse(line.slice(at)));
      } catch {
        /* unrecoverable */
      }
    }
  }
  return { readable: true, records, torn };
}

function endsWithNewline(file) {
  const fd = openSync(file, 'r');
  try {
    const { size } = fstatSync(fd);
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/**
 * Append one record (newline-guarded against a torn tail) and read it back.
 *
 * @returns {{ ok: true, record: object } | { ok: false, error: string }}
 */
export function appendRecord(repoRoot, fields) {
  const record = { id: randomUUID(), timestamp: new Date().toISOString(), ...fields };
  const file = recordsFilePath(repoRoot);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const lead = existsSync(file) && !endsWithNewline(file) ? '\n' : '';
    appendFileSync(file, `${lead}${JSON.stringify(record)}\n`);
  } catch (err) {
    return { ok: false, error: `cannot write ${file}: ${err?.code ?? err?.message ?? err}` };
  }
  const back = readRecords(repoRoot);
  if (!back.records.some((r) => r?.id === record.id)) {
    return { ok: false, error: `record not readable after write (${file})` };
  }
  return { ok: true, record };
}

/**
 * Pure: this worktree's and this session's records.
 *
 * Kept when: same worktree (a peer worktree's record never counts), not
 * provably another session's (ids, when both sides have them), and inside the
 * window when it is known. NOT keyed by branch: a branch switch or rename in
 * the same worktree keeps the coverage, which is bound to file content anyway.
 */
export function selectOwnReviews(records, { ownIds = new Set(), sinceTime = null, tree } = {}) {
  const since = sinceTime ? Date.parse(sinceTime) : null;
  return (Array.isArray(records) ? records : []).filter((rec) => {
    if (!rec || ![...REVIEW_STATUSES, ...AUTO_STATUSES].includes(rec.status)) return false;
    if (tree !== undefined && rec.tree !== tree) return false;
    if (since !== null && !(Date.parse(rec.timestamp) >= since)) return false;
    const recIds = [rec.session_id, rec.semantic_session_id].filter(Boolean);
    if (ownIds.size === 0 || recIds.length === 0) return true;
    return recIds.some((id) => ownIds.has(id));
  });
}

/**
 * Pure: completed review rounds per surface, or `null` when the window is
 * unknown (rounds cannot be told apart from an earlier session's).
 */
export function countRounds(reviews, { windowKnown = true } = {}) {
  if (!windowKnown) return null;
  const rounds = {};
  for (const rec of reviews) {
    if (rec.status !== 'reviewed') continue;
    const surface = normalizeSurface(rec.surface);
    rounds[surface] = (rounds[surface] ?? 0) + 1;
  }
  return rounds;
}

/** Pure: current cover keys not covered by any covering record. */
export function uncoveredKeys(keys, reviews) {
  const covered = new Set(
    reviews.filter((r) => REVIEW_STATUSES.includes(r.status)).flatMap((r) => (Array.isArray(r.covers) ? r.covers : [])),
  );
  return keys.filter((k) => !covered.has(k));
}

/**
 * Pure: may the session close?
 *
 * @param {object} input
 * @param {boolean} input.enabled
 * @param {{ ok: boolean, reason?: string, partial?: boolean }} input.changeSet
 * @param {string[]} input.uiPaths — UI files of the change set
 * @param {string[]|null} input.keys — their cover keys (`null` = not hashable)
 * @param {object[]} input.reviews — own records
 * @param {string[]} input.renderable — UI paths a Playwright config can render
 * @param {string} [input.reviewableReason]
 * @param {boolean} [input.ledgerReadable=true]
 * @param {boolean} [input.ledgerWritable=true]
 * @returns {{ verdict: 'pass'|'skip'|'refuse'|'not-reviewable'|'unmeasured', reason: string, uncovered: string[] }}
 *   `refuse` lists only the renderable uncovered paths; the CLI turns it into
 *   "would refuse" while the close gate runs in `warn` mode.
 */
export function evaluateCloseGate({ enabled, changeSet, uiPaths, keys, reviews, renderable, reviewableReason, ledgerReadable = true, ledgerWritable = true }) {
  if (!enabled) return { verdict: 'skip', reason: 'disabled', uncovered: [] };
  if (!changeSet?.ok) return { verdict: 'unmeasured', reason: `change set unknown (${changeSet?.reason ?? 'n/a'})`, uncovered: [] };
  if (uiPaths.length === 0) {
    if (changeSet.partial) {
      return { verdict: 'unmeasured', reason: 'session start unknown (no --since, --since-time or lock): commits on the default branch cannot be attributed to this session, so only the working tree was checked, and it has no UI change', uncovered: [] };
    }
    return { verdict: 'pass', reason: 'no-ui-touch', uncovered: [] };
  }
  if (keys === null) return { verdict: 'unmeasured', reason: 'UI files could not be hashed', uncovered: uiPaths };
  if (!ledgerReadable) return { verdict: 'unmeasured', reason: 'design-review records unreadable', uncovered: uiPaths };
  const missing = new Set(uncoveredKeys(keys, reviews));
  const uncovered = uiPaths.filter((_, i) => missing.has(keys[i]));
  if (uncovered.length === 0) return { verdict: 'pass', reason: 'covered', uncovered: [] };
  const canRender = new Set(renderable ?? []);
  const refusable = uncovered.filter((p) => canRender.has(p));
  if (refusable.length === 0) return { verdict: 'not-reviewable', reason: reviewableReason ?? 'no rendered result', uncovered };
  if (!ledgerWritable) return { verdict: 'unmeasured', reason: 'design-review records not writable, so no review can be recorded', uncovered: refusable };
  return { verdict: 'refuse', reason: 'no-review', uncovered: refusable };
}

/** Can a record be written? (file writable, or its directory when the file is absent) */
export function recordsWritable(repoRoot) {
  const file = recordsFilePath(repoRoot);
  try {
    accessSync(existsSync(file) ? file : dirname(file), constants.W_OK);
    return true;
  } catch {
    return !existsSync(file) && !existsSync(dirname(file));
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Screenshot evidence for a `reviewed` record: PNG files (by magic bytes,
 * non-empty) in `dir` or one level below, written at or after the session
 * window, not tracked by git. Returns their sha256 so the record names what
 * was looked at. A repo's `public/logo.png` or an empty `x.PNG` is no evidence.
 *
 * @param {string} dir
 * @param {{ repoRoot: string, sinceMs?: number|null }} opts
 * @returns {{ ok: boolean, pngs: Array<{ file: string, sha256: string }>, reason?: string }}
 */
export function checkEvidence(dir, { repoRoot, sinceMs = null }) {
  let candidates = [];
  try {
    if (!statSync(dir).isDirectory()) return { ok: false, pngs: [], reason: `${dir} is not a directory` };
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isFile()) candidates.push(p);
      else if (entry.isDirectory()) for (const n of readdirSync(p)) candidates.push(join(p, n));
    }
  } catch {
    return { ok: false, pngs: [], reason: `${dir} is unreadable` };
  }
  candidates = candidates.filter((p) => p.toLowerCase().endsWith('.png'));
  const tracked = new Set();
  if (candidates.length > 0) {
    const r = spawnSync('git', ['ls-files', '-z', '--full-name', '--', ...candidates], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status === 0) for (const t of String(r.stdout).split('\0').filter(Boolean)) tracked.add(join(repoRoot, t));
  }
  const pngs = [];
  for (const p of candidates) {
    try {
      const st = statSync(p);
      if (st.size <= PNG_MAGIC.length) continue;
      if (sinceMs !== null && st.mtimeMs < sinceMs) continue;
      let real = p;
      try { real = realpathSync(p); } catch { /* keep */ }
      if (tracked.has(p) || tracked.has(real)) continue;
      const buf = readFileSync(p);
      if (!buf.subarray(0, 8).equals(PNG_MAGIC)) continue;
      pngs.push({ file: p, sha256: createHash('sha256').update(buf).digest('hex') });
    } catch {
      /* skip */
    }
  }
  return pngs.length > 0
    ? { ok: true, pngs }
    : { ok: false, pngs: [], reason: 'no untracked, non-empty PNG written in this session' };
}
