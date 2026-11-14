/**
 * auto-commit.mjs — Auto-commit phase for vault-mirror (Issue #31, #283 split).
 *
 * After a successful mirror pass, optionally commits the unstaged mirror
 * artifacts in 40-learnings/ and 50-sessions/ as a single chore(vault) commit.
 * "Unstaged mirror artifact" is a path with an unstaged working-tree change that
 * carries the generator marker and that nobody has staged — whichever run wrote
 * it. A mirror file another session's mirror run left unstaged is included; the
 * selection does not know which run produced a file.
 *
 * Exports: autoCommitVaultMirror
 */

import { readFileSync, existsSync } from 'node:fs';
import { delimiter, resolve, sep } from 'node:path';

import { redactHomeDir } from '../common.mjs';
import { spawnSync } from '../native-command.mjs';

const GENERATOR_MARKER = 'session-orchestrator-vault-mirror@1';
const MIRROR_DIRS = ['40-learnings', '50-sessions'];
// gitleaks exits 1 on its own fatal errors; a distinct code keeps a finding apart from a failure.
const GITLEAKS_FINDING_EXIT = 3;

function isMirrorArtifact(absPath) {
  try {
    const head = readFileSync(absPath, 'utf8').slice(0, 4096);
    return head.includes(`_generator: ${GENERATOR_MARKER}`);
  } catch {
    return false;
  }
}

function git(vaultDirPath, gitArgs, options = {}) {
  return spawnSync('git', ['-C', vaultDirPath, ...gitArgs], { encoding: 'utf8', ...options });
}

/**
 * Run a git subcommand over an explicit path list. The paths travel NUL-separated
 * on stdin (`--pathspec-from-file`), never in argv: no command-line length limit
 * (Windows caps it near 32K) and `--literal-pathspecs` keeps a `*` or `:` in a
 * file name from being read as a pathspec pattern.
 */
function gitOnPaths(vaultDirPath, gitArgs, paths) {
  return spawnSync(
    'git',
    ['--literal-pathspecs', '-C', vaultDirPath, ...gitArgs, '--pathspec-from-file=-', '--pathspec-file-nul'],
    { encoding: 'utf8', input: paths.join('\0') },
  );
}

function splitNul(out) {
  return (out ?? '').split('\0').filter(Boolean);
}

/**
 * True when the vault expects a gitleaks scan: it carries a `.gitleaks.toml`, or
 * its pre-commit hook (honouring core.hooksPath) calls gitleaks. Such a vault
 * must not receive a mirror commit while the gitleaks binary is missing.
 */
function vaultRequiresGitleaks(vaultDirPath) {
  if (existsSync(resolve(vaultDirPath, '.gitleaks.toml'))) return true;
  const hook = git(vaultDirPath, ['rev-parse', '--git-path', 'hooks/pre-commit']);
  if (hook.status !== 0) return false;
  try {
    return readFileSync(resolve(vaultDirPath, hook.stdout.trim()), 'utf8').includes('gitleaks');
  } catch {
    return false;
  }
}

/**
 * Secret scan of exactly the files this run will commit, one `gitleaks dir` per
 * file (gitleaks takes a single path). It reads the working-tree content, which
 * is what `git commit --only` records. Files someone else staged are not scanned
 * and cannot block the mirror commit; they are not part of it either.
 *
 * @param {string} vaultDirPath
 * @param {string[]} relPaths - vault-relative paths, all existing files
 * @returns {'clean'|'finding'|'failed'|'unavailable'}
 */
function scanOwnFiles(vaultDirPath, relPaths) {
  const configPath = resolve(vaultDirPath, '.gitleaks.toml');
  const base = ['dir', '--redact', '--no-banner', '--log-level', 'error', '--exit-code', String(GITLEAKS_FINDING_EXIT)];
  if (existsSync(configPath)) base.push('--config', configPath);
  // A GUI-started session may lack Homebrew on PATH; the extra entries are inert elsewhere.
  const env = { ...process.env, PATH: [process.env.PATH ?? '', '/opt/homebrew/bin', '/usr/local/bin'].join(delimiter) };
  for (const rel of relPaths) {
    // cwd = vault root: the path gitleaks reports and matches allowlists against
    // is the vault-relative one, and `.gitleaksignore` is read from the vault.
    const res = spawnSync('gitleaks', [...base, rel], { encoding: 'utf8', env, cwd: vaultDirPath });
    if (res.error) return res.error.code === 'ENOENT' ? 'unavailable' : 'failed';
    if (res.status === GITLEAKS_FINDING_EXIT) return 'finding';
    if (res.status !== 0) return 'failed';
  }
  return 'clean';
}

/**
 * Auto-commit mirror artifacts in the vault after a vault-mirror pass.
 *
 * Behaviour:
 *   1. Read `git status` for 40-learnings/ and 50-sessions/ (only paths that exist).
 *      When `repo` is provided: scoped to `40-learnings/<repo>` and `50-sessions/<repo>`.
 *   2. Own set = paths changed in the working tree that nobody has staged — not
 *      "the paths this run wrote": an unstaged mirror file from another session's run
 *      is in it too. A path that is already staged belongs to someone else: it stays
 *      staged and out of the commit.
 *   3. Per-file frontmatter check for the generator marker; any non-mirror path
 *      → log warn, no commit.
 *   4. When `repo` is provided: any own path in a different repo namespace
 *      → log warn, emit `cross-repo-staged-changes`, no commit.
 *   5. Secret scan of the own files (gitleaks); a finding, a scan failure, or a
 *      missing binary in a vault that expects gitleaks → no commit.
 *   6. `git add` + `git commit --only` over exactly the own set as
 *      `chore(vault): mirror <session-id> — N learnings + M sessions`.
 *      A failed add/commit unstages only the own set (also on an unborn HEAD); a
 *      rollback that fails adds `rollback: "failed"` to the result line.
 *   7. Empty own set → idempotent no-op.
 *
 * @param {string} vaultDirPath - Absolute path to the vault git repo root.
 * @param {string} sessionId - Session identifier used in the commit subject.
 * @param {string|undefined|null} repo - Sanitised single-segment namespace (e.g. "session-orchestrator").
 *   When omitted/null, behaves exactly as the pre-namespace version (whole-dir staging, no cross-repo check).
 *
 * Emits one JSON action line on stdout describing the outcome.
 * Never throws — callers continue regardless of commit outcome.
 */
export function autoCommitVaultMirror(vaultDirPath, sessionId, repo) {
  // Determine staging targets: whole dirs (legacy) or per-repo subfolders (namespaced).
  const useNamespace = typeof repo === 'string' && repo.length > 0;

  let stagingTargets;
  if (useNamespace) {
    // Stage only the per-repo subfolders; filter to those that exist.
    const candidates = MIRROR_DIRS.map((d) => `${d}/${repo}`);
    stagingTargets = candidates.filter((p) => existsSync(resolve(vaultDirPath, p)));
  } else {
    // Legacy: stage entire mirror dirs that exist.
    stagingTargets = MIRROR_DIRS.filter((d) => existsSync(resolve(vaultDirPath, d)));
  }

  if (stagingTargets.length === 0) {
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

  // Porcelain v1, NUL-separated, no rename pairing: each record is `XY <path>`.
  // X = index vs HEAD, Y = working tree vs index. X other than ' ' or '?' means the
  // path is already staged (or unmerged) — someone else's change, never ours (#2089).
  const status = git(vaultDirPath, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', ...stagingTargets,
  ]);
  if (status.status !== 0) {
    process.stderr.write(`vault-mirror: auto-commit git-status failed: ${redactHomeDir(status.stderr)}\n`);
    process.stdout.write(
      JSON.stringify({ action: 'auto-commit-skipped', reason: 'git-diff-failed' }) + '\n',
    );
    return;
  }

  const ownPaths = [];
  for (const record of splitNul(status.stdout)) {
    const x = record[0];
    const y = record[1];
    const rel = record.slice(3);
    if (x !== ' ' && x !== '?') continue;
    if (y === ' ') continue;
    ownPaths.push(rel);
  }

  if (ownPaths.length === 0) {
    process.stdout.write(
      JSON.stringify({ action: 'auto-commit-noop', reason: 'no-staged-changes' }) + '\n',
    );
    return;
  }

  const offenders = [];
  const outOfNamespace = [];
  let learningsCount = 0;
  let sessionsCount = 0;
  const vaultRootAbs = resolve(vaultDirPath);
  for (const rel of ownPaths) {
    const abs = resolve(vaultDirPath, rel);
    // Containment guard (#660 Q3-LOW-2): a path that resolves outside the vault
    // dir (e.g. a crafted `..` entry) is treated as a non-mirror offender —
    // never read by isMirrorArtifact, never committed.
    if (!abs.startsWith(vaultRootAbs + sep)) {
      offenders.push(rel);
      continue;
    }
    if (!isMirrorArtifact(abs)) {
      offenders.push(rel);
      continue;
    }
    // Cross-repo isolation check (only when repo is provided).
    if (useNamespace) {
      // Extract the second path segment: `<mirrorDir>/<seg>/...`
      const parts = rel.split('/');
      const seg = parts[1]; // undefined for shallow paths; those pass through unguarded
      if (seg !== undefined && seg !== repo) {
        outOfNamespace.push(rel);
        continue;
      }
    }
    if (rel.startsWith('40-learnings/')) learningsCount++;
    else if (rel.startsWith('50-sessions/')) sessionsCount++;
  }

  // Nothing is staged yet at this point, so the skip paths below leave the index untouched.
  if (offenders.length > 0) {
    process.stderr.write(
      `vault-mirror: auto-commit skipped — ${offenders.length} non-mirror changed file(s): ${offenders.slice(0, 3).join(', ')}${offenders.length > 3 ? ', …' : ''}\n`,
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

  if (outOfNamespace.length > 0) {
    // Derive the foreign repo segments for the warning message (don't echo file contents).
    const foreignSegs = [...new Set(outOfNamespace.map((rel) => rel.split('/')[1]).filter(Boolean))];
    process.stderr.write(
      `vault-mirror: auto-commit skipped — ${outOfNamespace.length} file(s) belong to foreign repo namespace(s): ${foreignSegs.join(', ')}\n`,
    );
    process.stdout.write(
      JSON.stringify({
        action: 'auto-commit-skipped',
        reason: 'cross-repo-staged-changes',
        foreignRepos: foreignSegs,
      }) + '\n',
    );
    return;
  }

  // The commit below skips the vault's hooks (--no-verify, #603), and in a vault that
  // wires gitleaks that hook IS the secret scan. Run it here on the own files so
  // skipping the hook never skips the scan (#2089).
  // A missing binary blocks only a vault that expects gitleaks; elsewhere the
  // result line reports `secretScan: "unavailable"` and the commit goes ahead.
  // Ceiling: the scan reads the working-tree file, and `git add` / `git commit --only`
  // below read it again. A concurrent writer between the two reads, or a git clean
  // filter that transforms content at staging, makes the committed blob differ from
  // the scanned bytes. Accepted because mirror files are generated by this process
  // and no vault with a clean filter is known (unmeasured). Revisit when a vault uses clean filters
  // (`filter.*.clean` / `.gitattributes filter=`) or a race is measured; the fix then
  // is to scan the staged blobs (`git show :<path>`) after `git add`.
  const secretScan = scanOwnFiles(vaultDirPath, ownPaths);
  const scanBlocks = secretScan === 'unavailable' ? vaultRequiresGitleaks(vaultDirPath) : secretScan !== 'clean';
  if (scanBlocks) {
    const reason = `gitleaks-${secretScan}`;
    process.stderr.write(`vault-mirror: auto-commit skipped — ${reason}; mirror files stay on disk, commit them by hand\n`);
    process.stdout.write(JSON.stringify({ action: 'auto-commit-skipped', reason }) + '\n');
    return;
  }

  // Undo exactly what this run staged. The own set held no staged paths before
  // `git add`, so restoring them to HEAD is their prior index state. Without any
  // commit (unborn HEAD) `git restore --staged` cannot resolve HEAD; there every
  // own path was untracked before, so dropping it from the index is the prior state.
  // Returns `{}` on success, `{ rollback: 'failed' }` otherwise (merged into the result line).
  const rollback = () => {
    const headExists = git(vaultDirPath, ['rev-parse', '--verify', '--quiet', 'HEAD']).status === 0;
    const res = headExists
      ? gitOnPaths(vaultDirPath, ['restore', '--staged'], ownPaths)
      : gitOnPaths(vaultDirPath, ['rm', '--cached', '--quiet'], ownPaths);
    if (!res.error && res.status === 0) return {};
    process.stderr.write(
      `vault-mirror: auto-commit rollback failed — ${ownPaths.length} mirror file(s) may still be staged: ${redactHomeDir(res.stderr ?? String(res.error))}\n`,
    );
    return { rollback: 'failed' };
  };

  // `git commit --only` refuses paths git does not know yet, so new files are added first.
  const addResult = gitOnPaths(vaultDirPath, ['add'], ownPaths);
  if (addResult.status !== 0) {
    const rolledBack = rollback();
    process.stderr.write(`vault-mirror: auto-commit git-add failed: ${redactHomeDir(addResult.stderr)}\n`);
    process.stdout.write(
      JSON.stringify({ action: 'auto-commit-skipped', reason: 'git-add-failed', ...rolledBack }) + '\n',
    );
    return;
  }

  const subject = `chore(vault): mirror ${sessionId} — ${learningsCount} learnings + ${sessionsCount} sessions`;
  // --no-verify is intentional (issue #603): this is an unattended machine auto-commit at
  // session-end Phase 3.7 / evolve Phase 3.5, and an interactive, slow, or failing vault-side
  // hook would stall the close. What the vault's pre-commit hook guards is done here instead:
  //   - secret scan: the vault hook runs gitleaks (`gitleaks git --staged`, fail-closed);
  //     scanOwnFiles() above runs gitleaks on exactly the files committed below.
  //   - content: every committed path passed isMirrorArtifact() (generator marker) and,
  //     with a repo namespace, the cross-repo check.
  // See skills/vault-mirror/SKILL.md § "Pre-commit hook bypass (--no-verify)".
  //
  // `--only` commits exactly the own paths. Anything else in the vault's index (a file
  // someone else staged) stays staged and out of this commit (#2089).
  const commit = gitOnPaths(vaultDirPath, ['commit', '--only', '--no-verify', '-m', subject], ownPaths);
  if (commit.status !== 0) {
    const rolledBack = rollback();
    process.stderr.write(`vault-mirror: auto-commit git-commit failed: ${redactHomeDir(commit.stderr)}\n`);
    process.stdout.write(
      JSON.stringify({ action: 'auto-commit-skipped', reason: 'git-commit-failed', ...rolledBack }) + '\n',
    );
    return;
  }

  const sha = git(vaultDirPath, ['rev-parse', 'HEAD']).stdout.trim();
  // Count what the commit actually contains, not what we meant to commit.
  const committed = git(vaultDirPath, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD']);
  const files = committed.status === 0 ? splitNul(committed.stdout).length : ownPaths.length;
  process.stdout.write(
    JSON.stringify({
      action: 'auto-commit-created',
      sha,
      subject,
      learnings: learningsCount,
      sessions: sessionsCount,
      files,
      secretScan,
    }) + '\n',
  );
}
