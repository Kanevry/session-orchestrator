/**
 * gate-receipt.mjs — the Full Gate receipt (#1897, N4 of the CI efficiency PRD).
 *
 * A receipt says: the Full Gate passed on exactly this CONTENT TREE with
 * exactly this GATE DEFINITION. A later Full Gate on the same tree and
 * definition (the Quality wave, then session-end, via `--receipt`) reads it
 * instead of running the same suite again — visibly, as `reused_from`, never
 * silently. The pre-push hook reads only `pushed-tree` records (`--receipt-check`,
 * ceiling C12) and writes them (`--receipt-record`, or the remote router). A
 * receipt is a measurement, not an approval (ADR-002), and it never replaces a
 * CI run.
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
 *
 * Store: `<git common dir>/so-gate-receipts.jsonl`, append-only JSONL. Inside
 * the git dir it is never part of a tree, and all worktrees of a repo share it
 * (a receipt is keyed by content, so sharing is correct).
 *
 * Navigator gate-run ledger (LSO#961, schema v1): on a CLEAN tree the Full Gate
 * is also read from and written to the host's navigator ledger as gate
 * `so:full-gate`, so a receipt carries across repos' readers (pre-push,
 * fenster) and sessions. The SO-local store is read first; navigator is asked
 * only on a local miss. Without navigator (public users) nothing changes.
 * NAMED CEILINGS (BV-004):
 *   - C1 A reuse writes nothing to navigator: navigator has no time window and
 *     counts an entry carrying `quittung_gelesen` as a receipt, so a written
 *     reuse would extend a receipt forever. REVISIT TRIGGER: the navigator
 *     reader ignores `quittung_gelesen` entries or gains a window.
 *   - C2 A navigator hit has no suite counts (the ledger stores none); the
 *     synthesized envelope omits them (absent, never zero). REVISIT TRIGGER:
 *     the ledger schema gains counts.
 *   - C3 `dateien` is `{}`: every gate input is either in the tree or in
 *     `befehl` (the canonical definition string). REVISIT TRIGGER: the first
 *     gate input outside the tree and not in `befehl`.
 *   - C4 The gate_def recipe (sha256 over RFC 8785 JSON of `{befehl, dateien}`)
 *     is pinned to navigator 0.1.0's vectors (tests/lib/gate-receipt.test.mjs).
 *     REVISIT TRIGGER: a navigator release that changes `gate-run def-hash`.
 *   - C5 SO enforces the 12 h window on navigator hits, measured from the run
 *     START (`zeit`), not its end. REVISIT TRIGGER: gates long enough that the
 *     difference matters, or navigator gaining its own window.
 *   - C7 Only `--receipt` runs read from or write to navigator (the Quality
 *     wave and session-end). Pre-push never touches navigator: `--receipt-check`
 *     and `--receipt-record` neither read nor write it, and the remote router
 *     does not call it. REVISIT TRIGGER: another reader wants every Full Gate.
 *   - C8 Navigator is called only on a clean tree (content tree ==
 *     `HEAD^{tree}`): its key is the commit tree. REVISIT TRIGGER: navigator
 *     accepting content trees of uncommitted work.
 *
 * Pre-push reader (`run-quality-gate.mjs --receipt-check`):
 *   - C9 The pre-push reader accepts the any-node key (`gateDefinitionAnyNode`,
 *     the definition with `node: 'any'`), because the pre-push router already
 *     accepts a green run from any gate host regardless of its Node version
 *     (hosts measured 2026-11-03: m5 v26.13.0, win-wsl v24.21.0, M4 v24.22.1).
 *     The Quality wave and session-end keep comparing the full definition, and
 *     only `pushed-tree` records carry `definition_any_node` (it has no other
 *     reader).
 *     REVISIT TRIGGER: a test that behaves differently across Node majors, or
 *     a gate host whose Node major the CI image does not use.
 *   - C10 The store can live outside the checkout the tree was hashed in
 *     (pre-push hashes a temp clone and stores in the real repo, passed as
 *     `--ledger-root`). Content keys are global git object ids, so this is
 *     sound. REVISIT TRIGGER: a store reader that also trusts `host` or
 *     `session_id` for a decision.
 *   - C11 `--receipt-check` and `--receipt-record` never consult the
 *     navigator ledger: navigator's gate_def hashes the full definition, Node
 *     version included, and a navigator entry carries no provenance (C12).
 *     REVISIT TRIGGER: navigator gaining an any-node gate definition.
 *   - C12 Provenance: pre-push accepts only records with `context: 'pushed-tree'`
 *     — written after a run that tested exactly the pushed commit in an
 *     isolated checkout (the hook's temp clone via `--receipt-record`, or the
 *     remote router after it checked out the SHA on a clean tracked tree). The
 *     working copy differs from that clone in gitignored files and unscrubbed
 *     env, and a suite can be green in one and red in the other
 *     (`.claude/rules/toolchain-and-build.md`). So a green session-end run in
 *     the working copy does NOT spare the following push its suite. REVISIT
 *     TRIGGER: the working-copy Full Gate gaining the hook's isolation (temp
 *     clone), or a measured rate of identical-tree pushes after session-end
 *     that justifies it.
 *     `--receipt-record` tells the hook's clone from a working copy only by
 *     shape: the cwd must be a STANDALONE repository (git dir = common dir,
 *     {@link isStandaloneCheckout}) and the `--ledger-root` store must be a
 *     different STORE ({@link isForeignReceiptStore}) — every linked worktree
 *     shares its main checkout's common dir, so a directory comparison let a
 *     working copy mint a pushed-tree record into the store the hook reads.
 *     Ceiling: a SECOND full clone used as a working copy still passes both
 *     checks; no directory test can tell it from the hook's clone. REVISIT
 *     TRIGGER: a receipt minted outside the hook observed in the store, or the
 *     hook gaining a per-run nonce it passes to the record step.
 *   - C13 A red re-run does not cancel a green receipt (#1909). No red run
 *     writes anything `findReceipt` reads (`writeReceipt` refuses any envelope
 *     that is not fully green), and `findReceipt` scans from the end and returns
 *     the newest matching green record, so a green receipt stays valid for its
 *     12 h window even if a later run on the same tree and definition went red.
 *     The receipt-reading paths (`--receipt`, `--receipt-check`) run the suite
 *     only after a miss, so a red cannot follow a valid green on the same key
 *     from them; only a run that reads no receipts can (mainly
 *     `npm run quality-gate`, which writes nothing). Measured 2026-11-03: over
 *     342 pushed Full Gate runs (2026-10-07 to 2026-11-03), 292 trees, 20
 *     re-runs within 12 h after a green: 0 went red; all 14 trees with both
 *     outcomes went red first, then green. Whether navigator's `receipt read`
 *     honours a later `rot` over an earlier `gruen` is decided there (LSO#961).
 *     REVISIT TRIGGER: a measured green-to-red on the same tree and the same
 *     gate definition within 12 h (map `pushed_sha` of the
 *     `orchestrator.quality_gate.passed`/`.failed` events to `<sha>^{tree}` and
 *     group; working-copy runs carry no tree id).
 *
 * Every function is fail-closed: on any error there is no tree, no receipt and
 * no write, and the caller runs the gate as before. None throws.
 */

import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from './native-command.mjs';
import { atomicWriteWithBackup, envelopeToError } from './io.mjs';

/** How long a receipt stands in for a run: one working day of a session. */
export const RECEIPT_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Provenance of a receipt from a run on exactly the pushed commit in an
 * isolated checkout — the only records the pre-push reader accepts (C12).
 */
export const PUSHED_TREE_CONTEXT = 'pushed-tree';

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
  return createHash('sha256').update(gateDefinitionCanonical(inputs)).digest('hex');
}

/**
 * The gate definition with the Node version neutralised: `node` is replaced
 * by the literal marker `'any'`, which no real `process.version` equals, so
 * this hash can never collide with a with-node definition. It is the key ONLY
 * the pre-push reader uses (ceiling C9); the Quality wave and session-end keep
 * comparing the full {@link gateDefinition}.
 *
 * @param {Record<string, string>} inputs
 * @returns {string}
 */
export function gateDefinitionAnyNode(inputs) {
  return gateDefinition({ ...inputs, node: 'any' });
}

/**
 * The canonical string a gate definition hashes — also the navigator `befehl`.
 *
 * @param {Record<string, string>} inputs
 * @returns {string}
 */
export function gateDefinitionCanonical(inputs) {
  return JSON.stringify(Object.keys(inputs).sort().map((k) => [k, inputs[k]]));
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
 * Is `repoRoot` a standalone repository — its git dir IS its common dir — and
 * not a linked worktree (ceiling C12)? The pre-push hook's temp clone always
 * is. Fail-closed: any error answers false.
 *
 * @param {string} repoRoot
 * @returns {boolean}
 */
export function isStandaloneCheckout(repoRoot) {
  try {
    const gitDir = git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-dir']);
    const common = git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!gitDir || !common) return false;
    return realpathSync(gitDir) === realpathSync(common);
  } catch {
    return false;
  }
}

/**
 * Does `storeRoot` resolve to a different receipt store than `repoRoot`
 * (ceiling C12)? Compares the resolved directories that hold the stores, so a
 * linked worktree and its main checkout count as the SAME store. Fail-closed:
 * any error, or either side outside git, answers false.
 *
 * @param {string} storeRoot
 * @param {string} repoRoot
 * @returns {boolean}
 */
export function isForeignReceiptStore(storeRoot, repoRoot) {
  try {
    const a = receiptStorePath(storeRoot);
    const b = receiptStorePath(repoRoot);
    if (!a || !b) return false;
    return realpathSync(dirname(a)) !== realpathSync(dirname(b));
  } catch {
    return false;
  }
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
 * `repoRoot` only locates the store (its git common dir), so a caller may pass
 * the real repo root while `tree` was hashed in another checkout (ceiling C10).
 *
 * With `anyNode: true`, `definition` is a {@link gateDefinitionAnyNode} hash and
 * is compared against the record's `definition_any_node`. A record without that
 * field (every record written before it existed) never matches — fail-closed.
 *
 * With `context` set, a record matches only if its `context` equals it; a
 * record without the field never matches (ceiling C12).
 *
 * @param {{ repoRoot: string, tree: string|null, definition: string, anyNode?: boolean, context?: string|null, now?: number, ttlMs?: number }} opts
 * @returns {object|null}
 */
export function findReceipt({ repoRoot, tree, definition, anyNode = false, context = null, now = Date.now(), ttlMs = RECEIPT_TTL_MS }) {
  try {
    if (!tree || !definition) return null;
    const records = readRecords(receiptStorePath(repoRoot));
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      const key = anyNode ? r.definition_any_node : r.definition;
      if (context !== null && r.context !== context) continue;
      if (r.tree === tree && key === definition && fresh(r, now, ttlMs) && receiptWorthy(r.envelope)) return r;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Append a receipt. Returns whether one was written.
 *
 * `definitionAnyNode` (a {@link gateDefinitionAnyNode} hash) is stored as
 * `definition_any_node` only when given — never as null or empty. `host`
 * defaults to this machine; a caller recording a REMOTE run names its host.
 * `repoRoot` only locates the store (ceiling C10). `context` (provenance,
 * ceiling C12; `'pushed-tree'` is the only value in use) is stored only when
 * given as a non-empty string.
 *
 * @param {{ repoRoot: string, tree: string|null, definition: string, definitionAnyNode?: string|null, context?: string|null, envelope: object, sessionId?: string|null, host?: string, now?: number }} opts
 * @returns {boolean}
 */
export function writeReceipt({ repoRoot, tree, definition, definitionAnyNode = null, context = null, envelope, sessionId = null, host = hostname(), now = Date.now() }) {
  try {
    if (!tree || !definition || !receiptWorthy(envelope)) return false;
    const store = receiptStorePath(repoRoot);
    if (!store) return false;
    if (existsSync(store) && statSync(store).size > STORE_COMPACT_BYTES) {
      // Temp file + rename via the shared writer (Windows retry, tmp cleanup,
      // #1865): a reader never sees a truncated store. An append racing the
      // rewrite can still be lost — that costs a re-run, never a false green.
      // A failed compaction throws into the catch below, as it always did.
      const kept = readRecords(store).filter((r) => fresh(r, now, RECEIPT_TTL_MS));
      const res = atomicWriteWithBackup(store, kept.map((r) => `${JSON.stringify(r)}\n`).join(''));
      if (!res.ok) throw envelopeToError(res);
    }
    const record = {
      version: RECORD_VERSION,
      tree,
      definition,
      ...(typeof definitionAnyNode === 'string' && definitionAnyNode !== '' ? { definition_any_node: definitionAnyNode } : {}),
      ...(typeof context === 'string' && context !== '' ? { context } : {}),
      at: new Date(now).toISOString(),
      host,
      session_id: sessionId,
      envelope,
    };
    appendFileSync(store, `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Navigator gate-run ledger (LSO#961 schema v1) — see the module header.
// ---------------------------------------------------------------------------

/** The gate name SO's Full Gate carries in the navigator ledger. */
export const NAVIGATOR_GATE = 'so:full-gate';

/** Ledger name rule for `repo` and `host` (navigator schema v1). */
const LEDGER_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const HEX_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const NAVIGATOR_TIMEOUT_MS = 5000;

const isLedgerName = (v) => typeof v === 'string' && v.length <= 100 && LEDGER_NAME.test(v);

/**
 * Navigator's `gate_def`: sha256 over the RFC 8785 canonical JSON of
 * `{befehl, dateien: {}}`. For one string and an empty object that is
 * `JSON.stringify` with the keys in sorted order (C3, C4).
 *
 * @param {string} befehl
 * @returns {string}
 */
export function navigatorGateDef(befehl) {
  return createHash('sha256').update(JSON.stringify({ befehl, dateien: {} })).digest('hex');
}

/**
 * `HEAD^{tree}` and `HEAD`, or null.
 *
 * @param {string} repoRoot
 * @returns {{ tree: string, commit: string }|null}
 */
export function headState(repoRoot) {
  const tree = git(repoRoot, ['rev-parse', 'HEAD^{tree}']);
  const commit = git(repoRoot, ['rev-parse', 'HEAD']);
  return tree && commit && HEX_SHA.test(tree) && HEX_SHA.test(commit) ? { tree, commit } : null;
}

/**
 * The navigator `repo` name: the folder holding the git common dir
 * (`…/<name>/.git` → `<name>`; a bare `<name>.git` → `<name>`), or null.
 *
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function ledgerRepoName(repoRoot) {
  const common = git(repoRoot, ['rev-parse', '--git-common-dir']);
  if (!common) return null;
  const dir = resolve(repoRoot, common);
  const name = basename(dir) === '.git' ? basename(dirname(dir)) : basename(dir).replace(/\.git$/, '');
  return isLedgerName(name) ? name : null;
}

/**
 * The ledger key of a clean tree, or null. Clean: the content tree the gate
 * runs on is the commit tree (C8) — a dirty tree never reaches navigator.
 *
 * @param {string} repoRoot
 * @param {string|null} contentTreeHash  `contentTree(repoRoot)` before the run
 * @returns {{ repo: string, tree: string, commit: string }|null}
 */
export function ledgerKey(repoRoot, contentTreeHash) {
  if (contentTreeHash === null) return null;
  const head = headState(repoRoot);
  if (!head || head.tree !== contentTreeHash) return null;
  const repo = ledgerRepoName(repoRoot);
  return repo ? { repo, tree: head.tree, commit: head.commit } : null;
}

/**
 * The navigator verdict of a real Full Gate run, or null when nothing is
 * written. `gruen` only for three real passes (a `skip` writes nothing), so a
 * navigator `gruen` always backs the envelope a reader synthesizes from it.
 *
 * @param {{ envelope: unknown, exitCode: number, timedOut: boolean }} run
 * @returns {'gruen'|'rot'|'abgebrochen'|'nicht_messbar'|null}
 */
export function navigatorVerdict({ envelope, exitCode, timedOut }) {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const checks = ['typecheck', 'test', 'lint'].map((n) => (isObj(envelope) ? envelope[n] : undefined));
  if (timedOut || checks.some((c) => isObj(c) && c.timed_out === true)) return 'abgebrochen';
  if (!isObj(envelope)) return 'nicht_messbar';
  if (checks.some((c) => isObj(c) && c.status === 'skip')) return null;
  if (exitCode === 0 && receiptWorthy(envelope) && checks.every((c) => c.status === 'pass')) return 'gruen';
  return 'rot';
}

/**
 * The navigator command from `SO_NAVIGATOR_BIN` (`off` or empty disables; a
 * `.js`/`.mjs` path runs under this Node), else `navigator` from PATH.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string[]|null}  argv prefix
 */
export function navigatorCommand(env = process.env) {
  const bin = env.SO_NAVIGATOR_BIN;
  if (bin === undefined) return ['navigator'];
  if (bin === '' || bin === 'off') return null;
  return /\.m?js$/.test(bin) ? [process.execPath, bin] : [bin];
}

/**
 * One navigator gate-run ledger client. The capability probe runs once per
 * client (the CLI makes one per process), lazily — a dirty tree never spawns.
 * ENOENT is silent (no navigator installed); any other failure prints exactly
 * one stderr line per client and never navigator's own text. Nothing throws.
 *
 * @param {{ env?: Record<string, string|undefined>, warn?: (line: string) => void }} [opts]
 */
export function createNavigatorLedger({ env = process.env, warn = (line) => process.stderr.write(line) } = {}) {
  const command = navigatorCommand(env);
  let state = command ? 'unprobed' : 'off';
  let warned = false;

  const unavailable = (reason) => {
    if (!warned && reason) {
      warned = true;
      warn(`ℹ navigator gate-run ledger unavailable (${reason}); SO-local receipt only (#1897)\n`);
    }
  };
  const call = (args, input) => {
    try {
      return spawnSync(command[0], [...command.slice(1), ...args], {
        encoding: 'utf8',
        input: input ?? '',
        env,
        timeout: NAVIGATOR_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
    } catch (err) {
      return { error: err, status: null, stdout: '' };
    }
  };
  const failure = (r, what) => {
    if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGKILL') return `${what} timed out`;
    if (r.error) return `${what} could not start`;
    return `${what} exit ${r.status}`;
  };
  const available = () => {
    if (state === 'unprobed') {
      const r = call(['gate-run', '--help']);
      if (r.error?.code === 'ENOENT') state = 'absent';
      else if (r.status === 0 && typeof r.stdout === 'string' && r.stdout.includes('def-hash')) state = 'ready';
      else {
        state = 'broken';
        unavailable(r.status === 0 ? 'gate-run has no def-hash' : failure(r, 'probe'));
      }
    }
    return state === 'ready';
  };
  const parse = (text) => {
    try { return JSON.parse(text); } catch { return null; }
  };
  /** `navigator identity --json` `host_id`, else `unkonfiguriert-<short hostname>`. */
  const host = () => {
    const r = available() ? call(['identity', '--json']) : null;
    const id = r && r.status === 0 ? parse(r.stdout)?.host_id : null;
    if (isLedgerName(id)) return id;
    const short = (hostname().split('.')[0] || 'host').replace(/[^A-Za-z0-9._-]/g, '-');
    return `unkonfiguriert-${short}`.slice(0, 100);
  };

  return {
    /** False when `SO_NAVIGATOR_BIN` switches navigator off — then nothing is spawned. */
    enabled: command !== null,
    available,

    /**
     * The newest navigator receipt for this key, re-checked by SO, or null.
     *
     * @param {{ key: {repo: string, tree: string}, gateDef: string, now?: number, ttlMs?: number }} q
     * @returns {{ eintrag: object, entry_sha256: string }|null}
     */
    read({ key, gateDef, now = Date.now(), ttlMs = RECEIPT_TTL_MS }) {
      if (!key || !available()) return null;
      const r = call(['receipt', 'read', '--repo', key.repo, '--tree', key.tree, '--gate', NAVIGATOR_GATE, '--gate-def', gateDef, '--source', 'so', '--json']);
      if (r.status === 1) return null; // no receipt — the normal miss
      if (r.status !== 0) { unavailable(failure(r, 'receipt read')); return null; }
      const out = parse(r.stdout);
      const e = out?.eintrag;
      if (out?.zustand !== 'gefunden' || e === null || typeof e !== 'object' || !/^[0-9a-f]{64}$/.test(out.entry_sha256 ?? '')) {
        unavailable('receipt read answered no receipt shape');
        return null;
      }
      const match = e.repo === key.repo && e.baum === key.tree && e.gate === NAVIGATOR_GATE && e.gate_def === gateDef && e.quelle === 'so'
        && e.ergebnis === 'gruen' && e.sauber === true && typeof e.zeit === 'string' && fresh({ at: e.zeit }, now, ttlMs);
      return match ? { eintrag: e, entry_sha256: out.entry_sha256 } : null;
    },

    /**
     * Append one gate run. Returns whether navigator accepted it.
     *
     * @param {{ key: {repo: string, tree: string, commit: string}, gateDef: string, ergebnis: string, zeit: string, dauerMs: number }} run
     * @returns {boolean}
     */
    write({ key, gateDef, ergebnis, zeit, dauerMs }) {
      if (!key || !available()) return false;
      const record = {
        schema_version: 1,
        zeit,
        repo: key.repo,
        baum: key.tree,
        commit: key.commit,
        gate: NAVIGATOR_GATE,
        gate_def: gateDef,
        quelle: 'so',
        host: host(),
        ergebnis,
        dauer_ms: Math.max(0, Math.round(dauerMs)),
        sauber: true,
      };
      const r = call(['gate-run', 'write', '--json'], JSON.stringify(record));
      if (r.status === 0) return true;
      unavailable(failure(r, 'gate-run write'));
      return false;
    },

    host,
  };
}
