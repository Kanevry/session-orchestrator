/**
 * auto-commit.mjs — Auto-commit phase for vault-mirror (Issue #31, #283 split).
 *
 * After a successful mirror pass, optionally commits all staged mirror artifacts
 * in 40-learnings/ and 50-sessions/ as a single chore(vault) commit.
 *
 * Exports: autoCommitVaultMirror
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const GENERATOR_MARKER = 'session-orchestrator-vault-mirror@1';
const MIRROR_DIRS = ['40-learnings', '50-sessions'];

function isMirrorArtifact(absPath) {
  try {
    const head = readFileSync(absPath, 'utf8').slice(0, 4096);
    return head.includes(`_generator: ${GENERATOR_MARKER}`);
  } catch {
    return false;
  }
}

function git(vaultDirPath, gitArgs) {
  return spawnSync('git', ['-C', vaultDirPath, ...gitArgs], { encoding: 'utf8' });
}

/**
 * Auto-commit mirror artifacts in the vault after a vault-mirror pass.
 *
 * Behaviour:
 *   1. `git add 40-learnings/ 50-sessions/` (only paths that exist).
 *   2. Enumerate staged paths; per-file frontmatter check for the generator marker.
 *   3. All-mirror staged set → commit as `chore(vault): mirror <session-id> — N learnings + M sessions`.
 *   4. Mismatch (any non-mirror staged path) → unstage all, log warn, no commit.
 *   5. Empty staged set → idempotent no-op.
 *
 * Emits one JSON action line on stdout describing the outcome.
 * Never throws — callers continue regardless of commit outcome.
 */
export function autoCommitVaultMirror(vaultDirPath, sessionId) {
  const existingDirs = MIRROR_DIRS.filter((d) => existsSync(resolve(vaultDirPath, d)));
  if (existingDirs.length === 0) {
    process.stdout.write(
      JSON.stringify({ action: 'auto-commit-skipped', reason: 'no-mirror-dirs' }) + '\n',
    );
    return;
  }

  const repoCheck = git(vaultDirPath, ['rev-parse', '--git-dir']);
  if (repoCheck.status !== 0) {
    process.stdout.write(
      JSON.stringify({ action: 'auto-commit-skipped', reason: 'not-a-git-repo' }) + '\n',
    );
    return;
  }

  const addResult = git(vaultDirPath, ['add', '--', ...existingDirs]);
  if (addResult.status !== 0) {
    process.stderr.write(`vault-mirror: auto-commit git-add failed: ${addResult.stderr}\n`);
    process.stdout.write(
      JSON.stringify({ action: 'auto-commit-skipped', reason: 'git-add-failed' }) + '\n',
    );
    return;
  }

  const diff = git(vaultDirPath, ['diff', '--cached', '--name-only', '--', ...existingDirs]);
  if (diff.status !== 0) {
    process.stderr.write(`vault-mirror: auto-commit git-diff failed: ${diff.stderr}\n`);
    process.stdout.write(
      JSON.stringify({ action: 'auto-commit-skipped', reason: 'git-diff-failed' }) + '\n',
    );
    return;
  }

  const stagedPaths = diff.stdout.split('\n').map((s) => s.trim()).filter(Boolean);

  if (stagedPaths.length === 0) {
    process.stdout.write(
      JSON.stringify({ action: 'auto-commit-noop', reason: 'no-staged-changes' }) + '\n',
    );
    return;
  }

  const offenders = [];
  let learningsCount = 0;
  let sessionsCount = 0;
  for (const rel of stagedPaths) {
    const abs = resolve(vaultDirPath, rel);
    if (!isMirrorArtifact(abs)) {
      offenders.push(rel);
      continue;
    }
    if (rel.startsWith('40-learnings/')) learningsCount++;
    else if (rel.startsWith('50-sessions/')) sessionsCount++;
  }

  if (offenders.length > 0) {
    git(vaultDirPath, ['restore', '--staged', '--', ...existingDirs]);
    process.stderr.write(
      `vault-mirror: auto-commit skipped — ${offenders.length} non-mirror staged file(s): ${offenders.slice(0, 3).join(', ')}${offenders.length > 3 ? ', …' : ''}\n`,
    );
    process.stdout.write(
      JSON.stringify({
        action: 'auto-commit-skipped',
        reason: 'non-mirror-staged-changes',
        offenders,
      }) + '\n',
    );
    return;
  }

  const subject = `chore(vault): mirror ${sessionId} — ${learningsCount} learnings + ${sessionsCount} sessions`;
  const commit = git(vaultDirPath, ['commit', '-m', subject, '--no-verify']);
  if (commit.status !== 0) {
    process.stderr.write(`vault-mirror: auto-commit git-commit failed: ${commit.stderr}\n`);
    process.stdout.write(
      JSON.stringify({ action: 'auto-commit-skipped', reason: 'git-commit-failed' }) + '\n',
    );
    return;
  }

  const sha = git(vaultDirPath, ['rev-parse', 'HEAD']).stdout.trim();
  process.stdout.write(
    JSON.stringify({
      action: 'auto-commit-created',
      sha,
      subject,
      learnings: learningsCount,
      sessions: sessionsCount,
      files: stagedPaths.length,
    }) + '\n',
  );
}
