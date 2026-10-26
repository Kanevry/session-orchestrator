#!/usr/bin/env node
/**
 * migrate-rule-envelope.mjs — rewrite the legacy HTML-comment untrusted-content
 * envelope of generated rules to the VISIBLE sentinels (#1779, #1792).
 *
 * Claude Code strips block-level HTML comments before it injects a rule, so a
 * rule still carrying `<!-- untrusted-content:start … -->` /
 * `<!-- untrusted-content:end -->` delivers its agent-authored prose to the
 * model UNFRAMED. Readers accept both forms, so nothing breaks — the framing
 * just never arrives. This CLI is the mechanical maintenance path for copies
 * outside this repo (fleet repos), run by a maintenance runner rather than by
 * rule rewrites inside unrelated feature MRs.
 *
 * Contract:
 *   - scans `<root>/.claude/rules/*.md` only (non-recursive), regular files only
 *     (lstat; a symlinked file is skipped), size-capped;
 *   - REFUSES the whole root (per-root error, exit 2) when `.claude` or
 *     `.claude/rules` is a symlink or not a directory, or when the rules dir's
 *     realpath is not `realpath(root)/.claude/rules` (#1792 review F5);
 *   - replaces ONLY lines byte-equal to `LEGACY_UNTRUSTED_BEGIN` /
 *     `LEGACY_UNTRUSTED_END` with `UNTRUSTED_BEGIN` / `UNTRUSTED_END`; every
 *     other byte, line endings included, is preserved;
 *   - a file whose envelope is not exactly one start before exactly one end,
 *     mixes legacy and visible sentinels, or carries any other token line is
 *     SKIPPED with a reason — never half-migrated;
 *   - writes atomically (tmp + rename in the same directory), only on --apply.
 *
 * The tool never walks a directory tree to find repos: the caller passes every
 * root and owns the fleet boundary check before doing so.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { isMainModule } from './lib/is-main-module.mjs';
import {
  carriesEnvelopeToken,
  LEGACY_UNTRUSTED_BEGIN,
  LEGACY_UNTRUSTED_END,
  UNTRUSTED_BEGIN,
  UNTRUSTED_END,
} from './lib/reconcile/sanitize.mjs';

/**
 * Per-file read cap. The largest generated rule in this repo is ~12 KB
 * (guard-design.md, measured 2026-10-24); 1 MiB leaves two orders of magnitude
 * of headroom while refusing to slurp a pathological file.
 */
export const MAX_RULE_BYTES = 1024 * 1024;

const RULES_SUBDIR = join('.claude', 'rules');

const HELP = `Usage: node scripts/migrate-rule-envelope.mjs --root <repo-path> [--root <repo-path> ...] [--apply] [--json]

Migrates the legacy HTML-comment untrusted-content envelope
(<!-- untrusted-content:start ... --> / <!-- untrusted-content:end -->) in
<root>/.claude/rules/*.md to the visible sentinels (#1779, #1792). Claude Code
strips block-level HTML comments before injecting a rule, so the legacy
envelope never reaches the model.

Only lines that are EXACTLY a legacy sentinel are replaced; every other byte
(line endings included) stays. A file whose envelope is not exactly one start
before exactly one end, that mixes legacy and visible sentinels, or that holds
any other untrusted-content token line is skipped with a reason. Symlinks are
never followed: a symlinked rule file is skipped, and a root whose .claude or
.claude/rules is a symlink, not a directory, or resolves outside the root is
refused as a whole (error, exit 2). Files over ${MAX_RULE_BYTES} bytes are
skipped.

Fleet boundary: this tool does NOT walk directories to find repos and does NOT
check repo remotes. The CALLER is responsible for the fleet boundary check
(the boundary gate on every repo path) BEFORE passing it as --root.

Options:
  --root PATH   Repo root to scan (repeatable, at least one required)
  --dry-run     Report what would change; write nothing (DEFAULT)
  --apply       Rewrite pending files atomically (tmp + rename)
  --json        Emit one machine-parseable JSON object on stdout
  --help        Show this help

Exit codes:  0 success  1 usage error (bad flag, missing or non-directory root)
             2 system error (read/write failure, rules dir unreadable, or a
               root refused because .claude / .claude/rules is a symlink,
               not a directory, or resolves outside the root)`;

/** Thrown for invocation errors — mapped to exit 1. */
class UsageError extends Error {}

/**
 * Split text into lines while keeping each line's own terminator, so a rewrite
 * can reassemble the file byte-for-byte (LF, CRLF and a missing final newline
 * all survive).
 *
 * @param {string} text
 * @returns {{ body: string, eol: string }[]}
 */
function splitKeepingEol(text) {
  const out = [];
  const re = /\r?\n/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ body: text.slice(last, m.index), eol: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ body: text.slice(last), eol: '' });
  return out;
}

/**
 * Classify one rule file's text and, when it is migratable, compute the
 * migrated text. Pure — no IO.
 *
 * @param {string} text
 * @returns {{ status: 'no-envelope' | 'already-visible' | 'pending' | 'skip', reason?: string, lines?: number[], output?: string }}
 */
export function planRuleText(text) {
  const lines = splitKeepingEol(text);
  const starts = [];
  const ends = [];
  let legacy = 0;
  let visible = 0;
  for (let i = 0; i < lines.length; i++) {
    const { body } = lines[i];
    if (!carriesEnvelopeToken(body)) continue;
    if (body === LEGACY_UNTRUSTED_BEGIN || body === UNTRUSTED_BEGIN) {
      starts.push(i);
      if (body === LEGACY_UNTRUSTED_BEGIN) legacy++;
      else visible++;
    } else if (body === LEGACY_UNTRUSTED_END || body === UNTRUSTED_END) {
      ends.push(i);
      if (body === LEGACY_UNTRUSTED_END) legacy++;
      else visible++;
    } else {
      return { status: 'skip', reason: `non-sentinel token line ${i + 1}` };
    }
  }
  if (starts.length === 0 && ends.length === 0) return { status: 'no-envelope' };
  if (starts.length !== 1 || ends.length !== 1) {
    return {
      status: 'skip',
      reason: `envelope count: ${starts.length} start / ${ends.length} end`,
    };
  }
  if (starts[0] > ends[0])
    return { status: 'skip', reason: `end line ${ends[0] + 1} before start line ${starts[0] + 1}` };
  if (legacy > 0 && visible > 0)
    return { status: 'skip', reason: 'mixes legacy and visible sentinels' };
  if (legacy === 0) return { status: 'already-visible' };

  const out = lines.map(({ body, eol }) => {
    if (body === LEGACY_UNTRUSTED_BEGIN) return UNTRUSTED_BEGIN + eol;
    if (body === LEGACY_UNTRUSTED_END) return UNTRUSTED_END + eol;
    return body + eol;
  });
  return { status: 'pending', lines: [starts[0] + 1, ends[0] + 1], output: out.join('') };
}

/**
 * Write `content` to `path` atomically: a sibling tmp file (same directory, so
 * the rename cannot cross a filesystem; exclusive `wx` create with a random
 * suffix, so a pre-planted name is never written through) renamed over the
 * target, preserving the original permission bits. `verify` runs right before
 * the tmp create AND right before the rename; it throws to abort.
 *
 * @param {string} path
 * @param {string} content
 * @param {number} mode
 * @param {() => void} verify
 */
function atomicWrite(path, content, mode, verify) {
  verify();
  const tmp = `${path}.migrate-envelope-${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
  let created = false;
  try {
    // `wx` throws EEXIST before creating anything, so `created` stays false
    // and a pre-planted file of that name is never unlinked. Once the open
    // succeeded the tmp is ours, and a failed write (ENOSPC/EIO) still cleans
    // up. The content goes through that same fd, never a second open by name.
    const fd = openSync(tmp, 'wx', mode);
    created = true;
    try {
      writeFileSync(fd, content);
    } finally {
      closeSync(fd);
    }
    verify();
    renameSync(tmp, path);
  } catch (err) {
    if (created) {
      try {
        unlinkSync(tmp);
      } catch {
        // best effort; the original file is untouched either way
      }
    }
    throw err;
  }
}

/**
 * @param {string} root
 * @throws {UsageError} when `root` is missing or not a real directory
 */
function assertRootDir(root) {
  let st;
  try {
    st = lstatSync(root);
  } catch {
    throw new UsageError(`--root ${root}: does not exist`);
  }
  if (!st.isDirectory())
    throw new UsageError(`--root ${root}: not a directory (symlinked roots are not followed)`);
}

/**
 * lstat every path component from the root down to `.claude/rules` — none may
 * be a symlink, each must be a directory — then require the rules dir's
 * realpath to equal `realpath(root)/.claude/rules`. Checking only the final
 * component let a symlinked `.claude` redirect every write outside the root
 * (#1792 review F5).
 *
 * @param {string} root
 * @returns {{ ok: true, rulesDir: string, identity: string } | { ok: false, state: 'absent' | 'symlink' | 'not-a-directory' | 'escapes-root', component: string }}
 */
function inspectRulesDir(root) {
  const parts = ['.claude', 'rules'];
  const ids = [];
  const rootStat = lstatSync(root);
  ids.push(`${rootStat.dev}:${rootStat.ino}`);
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    const component = join(...parts.slice(0, i + 1));
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: false, state: 'absent', component };
      throw err;
    }
    if (st.isSymbolicLink()) return { ok: false, state: 'symlink', component };
    if (!st.isDirectory()) return { ok: false, state: 'not-a-directory', component };
    ids.push(`${st.dev}:${st.ino}`);
  }
  if (realpathSync(cur) !== join(realpathSync(root), RULES_SUBDIR))
    return { ok: false, state: 'escapes-root', component: RULES_SUBDIR };
  return { ok: true, rulesDir: cur, identity: ids.join('/') };
}

/**
 * Scan (and on `apply`, migrate) one repo root.
 *
 * @param {string} root
 * @param {{ apply: boolean }} opts
 * @returns {{ root: string, rules_dir: 'ok' | 'absent' | 'symlink' | 'not-a-directory' | 'escapes-root' | 'unreadable', files_scanned: number, pending: {file: string, lines: number[]}[], migrated: string[], already_visible: number, no_envelope: number, skipped: {file: string, reason: string}[], errors: {file: string, error: string}[] }}
 */
export function migrateRoot(root, { apply }) {
  const report = {
    root,
    rules_dir: 'ok',
    files_scanned: 0,
    pending: [],
    migrated: [],
    already_visible: 0,
    no_envelope: 0,
    skipped: [],
    errors: [],
  };
  assertRootDir(root);

  let inspected;
  try {
    inspected = inspectRulesDir(root);
  } catch (err) {
    report.rules_dir = 'unreadable';
    report.errors.push({ file: RULES_SUBDIR, error: err.message });
    return report;
  }
  if (!inspected.ok) {
    report.rules_dir = inspected.state;
    // A missing rules dir is a normal repo; anything else is a refused root
    // the maintenance runner must see (exit 2), never a silent zero.
    if (inspected.state !== 'absent')
      report.errors.push({
        file: inspected.component,
        error: `${inspected.state} — root refused, nothing read or written`,
      });
    return report;
  }
  const { rulesDir, identity } = inspected;
  // Re-checked right before each tmp create and each rename. Ceiling (BV-004):
  // Node has no openat/renameat, so the rename still resolves the path anew; a
  // swap of `.claude` or `.claude/rules` in the microseconds between this check
  // and renameSync is not closable here. Revisit if the tool ever runs against
  // roots writable by an untrusted party while it runs.
  const verifyDir = () => {
    const now = inspectRulesDir(root);
    if (!now.ok || now.identity !== identity)
      throw new Error('rules directory changed during run — write aborted');
  };
  let names;
  try {
    names = readdirSync(rulesDir)
      .filter((n) => n.endsWith('.md'))
      .sort();
  } catch (err) {
    report.rules_dir = 'unreadable';
    report.errors.push({ file: RULES_SUBDIR, error: err.message });
    return report;
  }

  for (const name of names) {
    const rel = join(RULES_SUBDIR, name);
    const path = join(rulesDir, name);
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) {
        report.skipped.push({ file: rel, reason: 'symlink (not followed)' });
        continue;
      }
      if (!st.isFile()) {
        report.skipped.push({ file: rel, reason: 'not a regular file' });
        continue;
      }
      if (st.size > MAX_RULE_BYTES) {
        report.skipped.push({ file: rel, reason: `larger than ${MAX_RULE_BYTES} bytes` });
        continue;
      }
      report.files_scanned++;
      const raw = readFileSync(path);
      const text = raw.toString('utf8');
      // A lossy decode would make the rewrite change bytes it never meant to.
      if (!Buffer.from(text, 'utf8').equals(raw)) {
        report.skipped.push({ file: rel, reason: 'not valid UTF-8' });
        continue;
      }
      const plan = planRuleText(text);
      if (plan.status === 'no-envelope') report.no_envelope++;
      else if (plan.status === 'already-visible') report.already_visible++;
      else if (plan.status === 'skip') report.skipped.push({ file: rel, reason: plan.reason });
      else {
        report.pending.push({ file: rel, lines: plan.lines });
        if (apply) {
          // Re-read right before the write: a concurrent edit since the plan
          // must not be overwritten with a migration of the older bytes.
          if (!readFileSync(path).equals(raw)) {
            report.skipped.push({ file: rel, reason: 'changed during run' });
            continue;
          }
          atomicWrite(path, plan.output, st.mode & 0o7777, verifyDir);
          report.migrated.push(rel);
        }
      }
    } catch (err) {
      report.errors.push({ file: rel, error: err.message });
    }
  }
  return report;
}

/**
 * @param {string[]} argv
 * @returns {{ roots: string[], apply: boolean, json: boolean, help: boolean }}
 */
function parseCli(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        root: { type: 'string', multiple: true },
        apply: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (values.help) return { roots: [], apply: false, json: false, help: true };
  if (values.apply && values['dry-run'])
    throw new UsageError('--apply and --dry-run are mutually exclusive');
  const roots = values.root ?? [];
  if (roots.length === 0) throw new UsageError('at least one --root <repo-path> is required');
  return { roots, apply: values.apply, json: values.json, help: false };
}

/**
 * CLI entry. Returns the exit code instead of exiting, so tests can call it.
 *
 * @param {string[]} argv
 * @returns {number}
 */
export function main(argv) {
  let args;
  try {
    args = parseCli(argv);
  } catch (err) {
    process.stderr.write(`migrate-rule-envelope: ${err.message}\n\n${HELP}\n`);
    return 1;
  }
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const reports = [];
  try {
    // Validate EVERY root before touching any, so a typo in the last --root
    // cannot leave an --apply run half done across the earlier ones.
    for (const root of args.roots) assertRootDir(root);
    for (const root of args.roots) reports.push(migrateRoot(root, { apply: args.apply }));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`migrate-rule-envelope: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`migrate-rule-envelope: ${err.message}\n`);
    return 2;
  }

  const totals = {
    roots: reports.length,
    files_scanned: reports.reduce((n, r) => n + r.files_scanned, 0),
    pending: reports.reduce((n, r) => n + r.pending.length, 0),
    migrated: reports.reduce((n, r) => n + r.migrated.length, 0),
    already_visible: reports.reduce((n, r) => n + r.already_visible, 0),
    skipped: reports.reduce((n, r) => n + r.skipped.length, 0),
    errors: reports.reduce((n, r) => n + r.errors.length, 0),
  };
  const mode = args.apply ? 'apply' : 'dry-run';

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ mode, totals, roots: reports })}\n`);
  } else {
    for (const r of reports) {
      process.stdout.write(
        `${r.root}: rules_dir=${r.rules_dir} scanned=${r.files_scanned} pending=${r.pending.length} ` +
          `migrated=${r.migrated.length} already_visible=${r.already_visible} skipped=${r.skipped.length}\n`,
      );
      for (const p of r.pending)
        process.stdout.write(`  pending ${p.file} (lines ${p.lines.join(', ')})\n`);
      for (const s of r.skipped) process.stdout.write(`  skipped ${s.file}: ${s.reason}\n`);
    }
    process.stdout.write(
      `${mode}: ${totals.pending} pending, ${totals.migrated} migrated, ${totals.skipped} skipped, ` +
        `${totals.errors} errors across ${totals.roots} root(s)\n`,
    );
  }
  for (const r of reports) {
    for (const e of r.errors)
      process.stderr.write(`migrate-rule-envelope: ${r.root}/${e.file}: ${e.error}\n`);
  }
  return totals.errors > 0 ? 2 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
