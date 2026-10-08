/**
 * orchestrator-ignore.mjs — keep the plugin's runtime state out of `git status`
 * in a repo that has never been bootstrapped (#1515 Pkt 5).
 *
 * Measured 2026-10-08 @ 644743cc: one SessionStart in a fresh `git init` repo
 * left five untracked files under `.orchestrator/` (session.lock,
 * current-session.json, host.json, runtime/lock-owner-proof.json,
 * metrics/events.jsonl) and nothing ignored them. Bootstrapped repos get their
 * runtime ignore lines from `skills/bootstrap/_shared-template.md`
 * § store-lock-ignore; an un-bootstrapped one gets nothing.
 *
 * Root, not per writer (BV-003): 23 hook-reachable modules call mkdir, and
 * `.orchestrator/` is created by whichever runs first. SessionStart is the first
 * plugin hook of every session (hooks/hooks.json), so the one call in
 * on-session-start.mjs covers the session. Because SessionStart runs async, a
 * PreToolUse hook MAY have created the directory a moment earlier — which is
 * why the decision keys on "nothing under .orchestrator/ is tracked" (one
 * `git ls-files`), not on "the directory was just created".
 *
 * Invariants:
 *   - A repo WITH `.orchestrator/bootstrap.lock` is never given the file. If it
 *     carries a file this helper wrote (byte-identical), the file is removed:
 *     after bootstrap, steering/, peers/, policy/ and the ledgers are durable
 *     project data and must not stay ignored.
 *   - An existing `.orchestrator/.gitignore` is never overwritten.
 *   - Any tracked path under `.orchestrator/`, or git failing (no repo, no git
 *     binary), means: write nothing.
 *   - Never throws; returns a reason string for tests and diagnostics.
 *
 * The negations are the exact `.orchestrator/` paths a bootstrap run stages
 * with `git add -- <file>` (BOOTSTRAP_FILES in skills/bootstrap/*-template.md,
 * measured 2026-10-08). The Bootstrap Gate runs bootstrap in the SAME session
 * this file was written, before the next SessionStart can remove it, and git
 * refuses `git add` on an explicitly named ignored path. NAMED CEILING
 * (BV-004): the list is hand-copied; revisit when a template adds a new
 * `BOOTSTRAP_FILES+=(.orchestrator/...)` entry.
 */

import { readFile, writeFile, link, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';

export const GENERATED_IGNORE = [
  '# Written by session-orchestrator (#1515): this repo has no .orchestrator/bootstrap.lock,',
  '# so the plugin runtime state below stays out of git status. Removed automatically',
  '# at the first session start after /bootstrap.',
  '*',
  '!*/',
  '!/bootstrap.lock',
  '!/metrics/learnings.jsonl',
  '!/metrics/sessions.jsonl',
  '!/metrics/README.md',
  '!/policy/quality-gates.json',
  '',
].join('\n');

function trackedUnderOrchestrator(repoRoot) {
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '-z', '--', '.orchestrator'], { cwd: repoRoot, timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null); // unknown → caller writes nothing
      resolve(stdout.length > 0);
    });
  });
}

/**
 * @param {string} repoRoot
 * @returns {Promise<'written'|'removed'|'bootstrapped'|'present'|'tracked'|'no-git'|'error'>}
 */
export async function ensureOrchestratorIgnore(repoRoot) {
  try {
    const dir = path.join(repoRoot, '.orchestrator');
    const target = path.join(dir, '.gitignore');
    if (existsSync(path.join(dir, 'bootstrap.lock'))) {
      if (existsSync(target)) {
        const current = await readFile(target, 'utf8').catch(() => null);
        if (current === GENERATED_IGNORE) {
          await unlink(target);
          return 'removed';
        }
      }
      return 'bootstrapped';
    }
    if (existsSync(target)) return 'present';
    const tracked = await trackedUnderOrchestrator(repoRoot);
    if (tracked === null) return 'no-git';
    if (tracked) return 'tracked';
    await mkdir(dir, { recursive: true });
    // tmp + link: atomic, and link() fails with EEXIST instead of replacing a
    // .gitignore another process created in between (rename would overwrite).
    const tmp = `${target}.tmp-${process.pid}`;
    await writeFile(tmp, GENERATED_IGNORE, 'utf8');
    try {
      await link(tmp, target);
    } finally {
      await unlink(tmp).catch(() => {});
    }
    return 'written';
  } catch (err) {
    return err && err.code === 'EEXIST' ? 'present' : 'error';
  }
}
