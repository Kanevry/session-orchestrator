/**
 * gate-receipt.mjs — the Full Gate receipt (#1897, N4 of the CI efficiency PRD).
 *
 * A receipt says: the Full Gate passed on exactly this CONTENT TREE with
 * exactly this GATE DEFINITION. A later Full Gate on the same tree and
 * definition (the Quality wave, then session-end) reads it instead of running
 * the same suite again — visibly, as `reused_from`, never silently. A receipt is
 * a measurement, not an approval (ADR-002), and it never replaces a CI run.
 *
 * Content tree: the git tree hash of the working tree — tracked files plus
 * untracked files that are not ignored — built in a TEMPORARY index, so the
 * real index is never touched. On a clean tree it equals `HEAD^{tree}`, the key
 * other readers (pre-push, fenster) use. The PRD allows local receipts only on a
 * clean tree (Refute P5: a receipt must not confirm another tree); keying on the
 * content itself keeps that guarantee for the dirty tree SO's waves and
 * session-end run on, where nothing is committed yet.
 *
 * Fail-closed refusals (no tree, so no receipt is read or written), each one a
 * false green the Opus review of 4625a4f5 measured:
 *   - the gate does not run at the repo's top level (`npm test` and the policy
 *     file resolve from the working directory, which is not in the tree);
 *   - an index entry is assume-unchanged or skip-worktree, or sparse checkout
 *     is on (`add -A` skips such files, their edits never reach the tree);
 *   - `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY` or
 *     `GIT_INDEX_FILE` is inherited (a git hook context could hash another repo);
 *   - the repo has `.gitmodules` (a submodule enters the tree as a commit id,
 *     its dirty content would be invisible).
 *
 * NAMED CEILINGS (BV-004):
 *   - Ignored files are not in the tree (`node_modules`, `.env.local`, build
 *     caches) — the same as for a clean commit tree. Installed dependencies are
 *     covered only through the lockfile in the tree. Linked worktrees share the
 *     store, so a worktree missing an ignored install (a fresh one without
 *     `skills/vault-sync/node_modules`) can be answered by a green run of the
 *     same content in another worktree (re-review of fb64c9cd, LOW-1).
 *     REVISIT TRIGGER: such a case seen — then key the store per worktree
 *     (`--git-dir` instead of `--git-common-dir`).
 *   - Environment variables are not in the gate definition (`CI`, `NODE_OPTIONS`,
 *     `SO_*`): a suite that skips or tightens on one can be answered by a
 *     receipt from a run without it. Measured 2026-10-31: no test of this repo
 *     skips on an env var (`rg "skipIf\(.*process\.env|runIf\(.*process\.env"
 *     tests/` → 0). REVISIT TRIGGER: the first such test, or a consumer repo
 *     whose gate commands depend on env.
 *   - The store is SO-local until the navigator gate-run ledger (LSO#961) has
 *     a schema. REVISIT TRIGGER: that schema — then write and read there.
 *
 * Store: `<git common dir>/so-gate-receipts.jsonl`, append-only JSONL. Inside
 * the git dir it is never part of a tree, and all worktrees of a repo share it
 * (a receipt is keyed by content, so sharing is correct).
 *
 * Every function is fail-closed: on any error there is no tree, no receipt and
 * no write, and the caller runs the gate as before. None throws.
 */

import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from './native-command.mjs';

/** How long a receipt stands in for a run: one working day of a session. */
export const RECEIPT_TTL_MS = 12 * 60 * 60 * 1000;

const STORE_NAME = 'so-gate-receipts.jsonl';
const RECORD_VERSION = 1;
/** Past this size the store is rewritten with the receipts still inside the TTL. */
const STORE_COMPACT_BYTES = 2 * 1024 * 1024;

/** Inherited git variables that would point the hash at another repo or index. */
const FOREIGN_GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_INDEX_FILE'];

function git(repoRoot, args, env = process.env) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', env });
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : null;
}

/**
 * The content tree of `repoRoot`'s working tree, or null (see the refusals in
 * the module header).
 *
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function contentTree(repoRoot) {
  let tmp = null;
  try {
    if (FOREIGN_GIT_ENV.some((name) => (process.env[name] ?? '') !== '')) return null;
    const top = git(repoRoot, ['rev-parse', '--show-toplevel']);
    if (!top || realpathSync(top) !== realpathSync(repoRoot)) return null;
    if (existsSync(join(top, '.gitmodules'))) return null;
    // A fallback: sparse checkout marks the hidden files skip-worktree, which the
    // tag check below refuses as well.
    if (git(top, ['config', '--bool', 'core.sparseCheckout']) === 'true') return null;
    // `ls-files -v` tags an assume-unchanged entry in lower case, a
    // skip-worktree entry with `S`.
    const tags = git(top, ['ls-files', '-v']);
    if (tags === null || /^(?:[a-z]|S) /m.test(tags)) return null;
    const indexPath = git(top, ['rev-parse', '--git-path', 'index']);
    if (!indexPath) return null;
    tmp = mkdtempSync(join(tmpdir(), 'so-gate-receipt-'));
    const tmpIndex = join(tmp, 'index');
    // A copy keeps the stat cache, so `add -A` hashes only what changed.
    const realIndex = resolve(top, indexPath);
    if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    if (git(top, ['add', '-A'], env) === null) return null;
    const tree = git(top, ['write-tree'], env);
    return tree && /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
  } catch {
    return null;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * The hash of a gate definition: everything besides the tree that decides the
 * verdict (variant, the three commands, Node version, plugin version).
 *
 * @param {Record<string, string>} inputs
 * @returns {string}
 */
export function gateDefinition(inputs) {
  const canonical = JSON.stringify(Object.keys(inputs).sort().map((k) => [k, inputs[k]]));
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Path of the receipt store, or null outside a git repo.
 *
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function receiptStorePath(repoRoot) {
  const common = git(repoRoot, ['rev-parse', '--git-common-dir']);
  return common ? join(resolve(repoRoot, common), STORE_NAME) : null;
}

/**
 * May this Full Gate envelope become a receipt? Only a full-gate run whose three
 * checks each passed or were skipped, none of them killed, and no stub ran (an
 * echo stub is a failed gate, session-end Phase 2.0a). Any other status — also
 * an unknown one — refuses.
 *
 * @param {unknown} envelope
 * @returns {boolean}
 */
export function receiptWorthy(envelope) {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(envelope) || envelope.variant !== 'full-gate') return false;
  for (const name of ['typecheck', 'test', 'lint']) {
    const check = envelope[name];
    if (!isObj(check) || !['pass', 'skip'].includes(check.status) || check.timed_out === true) return false;
  }
  return isObj(envelope.stubbed) && Object.keys(envelope.stubbed).length === 0;
}

function readRecords(store) {
  if (!store || !existsSync(store)) return [];
  const records = [];
  for (const line of readFileSync(store, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.version === RECORD_VERSION) records.push(r);
    } catch { /* a torn line from a killed writer — skip it */ }
  }
  return records;
}

const fresh = (record, now, ttlMs) => {
  const at = Date.parse(record.at);
  return Number.isFinite(at) && at <= now && now - at <= ttlMs;
};

/**
 * The newest receipt for `tree` and `definition` inside the TTL, or null.
 *
 * @param {{ repoRoot: string, tree: string|null, definition: string, now?: number, ttlMs?: number }} opts
 * @returns {object|null}
 */
export function findReceipt({ repoRoot, tree, definition, now = Date.now(), ttlMs = RECEIPT_TTL_MS }) {
  try {
    if (!tree || !definition) return null;
    const records = readRecords(receiptStorePath(repoRoot));
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r.tree === tree && r.definition === definition && fresh(r, now, ttlMs) && receiptWorthy(r.envelope)) return r;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Append a receipt. Returns whether one was written.
 *
 * @param {{ repoRoot: string, tree: string|null, definition: string, envelope: object, sessionId?: string|null, now?: number }} opts
 * @returns {boolean}
 */
export function writeReceipt({ repoRoot, tree, definition, envelope, sessionId = null, now = Date.now() }) {
  try {
    if (!tree || !definition || !receiptWorthy(envelope)) return false;
    const store = receiptStorePath(repoRoot);
    if (!store) return false;
    if (existsSync(store) && statSync(store).size > STORE_COMPACT_BYTES) {
      // Temp file + rename: a reader never sees a truncated store. An append
      // racing the rewrite can still be lost — that costs a re-run, never a
      // false green.
      const kept = readRecords(store).filter((r) => fresh(r, now, RECEIPT_TTL_MS));
      const next = `${store}.${process.pid}.tmp`;
      writeFileSync(next, kept.map((r) => `${JSON.stringify(r)}\n`).join(''));
      renameSync(next, store);
    }
    const record = {
      version: RECORD_VERSION,
      tree,
      definition,
      at: new Date(now).toISOString(),
      host: hostname(),
      session_id: sessionId,
      envelope,
    };
    appendFileSync(store, `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}
