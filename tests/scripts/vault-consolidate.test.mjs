/**
 * tests/scripts/vault-consolidate.test.mjs
 *
 * Vitest suite for scripts/vault-consolidate.mjs (issue #499, W2-shipped).
 *
 * Covers P0+P1 priorities per qa-strategist:
 *   P0:
 *     1. source-vault absent → empty summary, exit 0 (plain + --json)
 *     2. canonical-vault absent → die exit 2
 *     3. --dry-run + --apply mutex → die exit 1
 *     4. --resolve malformed → die exit 1
 *     5. Classification matrix (copy / skip-already-present / merge / conflict-needs-review)
 *     6. Idempotency: second --apply skips all + creates no backup
 *     7. --apply unresolved-merges → exit 3 with awaiting-merge-decision records
 *   P1:
 *     8. expandHome() for ~ / ~/foo / absolute
 *     9. isPrefix() subset detection → dst-is-superset hint
 *    10. --resolve src / dst / skip behaviour
 *    11. Backup tar compression success
 *    12. Walk skips ignored dirs / files
 *
 * Each test uses isolated tmpdirs in os.tmpdir() — NEVER touches
 * ~/Projects/vault or ~/Projects/Bernhard/vault.
 *
 * Spawns the actual script via spawnSync('node', [SCRIPT, ...args]) —
 * CLI is the contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  readdirSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const SCRIPT = resolve(process.cwd(), 'scripts/vault-consolidate.mjs');

function runScript(args, opts = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    ...opts,
  });
}

describe('vault-consolidate CLI', () => {
  let createdDirs = [];

  beforeEach(() => {
    createdDirs = [];
  });

  afterEach(() => {
    for (const d of createdDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    createdDirs = [];
  });

  function mkTmp(prefix) {
    const d = mkdtempSync(join(tmpdir(), `vault-consolidate-${prefix}-`));
    createdDirs.push(d);
    return d;
  }

  // -------------------------------------------------------------------------
  // P0 — Pre-flight & CLI behaviour
  // -------------------------------------------------------------------------

  it('P0: source vault absent → exit 0 with empty summary text in plain mode', () => {
    // Need real canonical so the isDir(canonicalRoot) check passes — but
    // source is absent so isDir(sourceRoot) returns false FIRST and we
    // exit 0 before reaching the canonical check.
    const tmpParent = mkTmp('src-absent-plain');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(canonical, { recursive: true });
    const missingSource = join(tmpParent, 'does-not-exist');

    const result = runScript([
      '--source', missingSource,
      '--canonical', canonical,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('source vault not found');
    expect(result.stdout).toContain('nothing to do');
  });

  it('P0: source vault absent → exit 0 with summary JSON record in --json mode', () => {
    const tmpParent = mkTmp('src-absent-json');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(canonical, { recursive: true });
    const missingSource = join(tmpParent, 'does-not-exist');

    const result = runScript([
      '--source', missingSource,
      '--canonical', canonical,
      '--json',
    ]);

    expect(result.status).toBe(0);
    const record = JSON.parse(result.stdout.trim());
    expect(record).toEqual({
      kind: 'summary',
      mode: 'dry-run',
      source: missingSource,
      canonical: canonical,
      counts: { copy: 0, 'skip-already-present': 0, merge: 0, 'conflict-needs-review': 0 },
      notice: `source vault not found at ${missingSource} — nothing to do`,
    });
  });

  it('P0: canonical vault absent → exit 2 with stderr message', () => {
    const tmpParent = mkTmp('canonical-absent');
    const source = join(tmpParent, 'source');
    mkdirSync(source, { recursive: true });
    const missingCanonical = join(tmpParent, 'no-canonical-here');

    const result = runScript([
      '--source', source,
      '--canonical', missingCanonical,
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('canonical vault not found');
    expect(result.stderr).toContain('refusing to consolidate');
  });

  it('P0: --dry-run and --apply mutex → die exit 1', () => {
    const result = runScript(['--dry-run', '--apply']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--dry-run and --apply are mutually exclusive');
  });

  it('P0: --resolve missing "=" → die exit 1', () => {
    const tmpParent = mkTmp('resolve-no-eq');
    const source = join(tmpParent, 'source');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(source, { recursive: true });
    mkdirSync(canonical, { recursive: true });

    const result = runScript([
      '--source', source,
      '--canonical', canonical,
      '--resolve', 'no-equals-sign',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--resolve must be of the form');
  });

  it('P0: --resolve trailing "=" (empty choice) → die exit 1', () => {
    const tmpParent = mkTmp('resolve-trailing-eq');
    const source = join(tmpParent, 'source');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(source, { recursive: true });
    mkdirSync(canonical, { recursive: true });

    const result = runScript([
      '--source', source,
      '--canonical', canonical,
      '--resolve', 'some/path=',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--resolve must be of the form');
  });

  it('P0: --resolve invalid choice (not src/dst/skip) → die exit 1', () => {
    const tmpParent = mkTmp('resolve-bad-choice');
    const source = join(tmpParent, 'source');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(source, { recursive: true });
    mkdirSync(canonical, { recursive: true });

    const result = runScript([
      '--source', source,
      '--canonical', canonical,
      '--resolve', 'some/path=banana',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--resolve choice must be one of src|dst|skip');
  });

  it('P0: --help → exit 0 and prints usage to stderr (#589 LOW-qa-4)', () => {
    // Regression guard: --help must short-circuit BEFORE the canonical/source
    // pre-flight checks (none supplied here) and print usage to STDERR (per the
    // documented "Print this message to stderr and exit 0" contract), with
    // exit 0. A regression that exited 1, or wrote help to stdout, fails here.
    const result = runScript(['--help']);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      'Usage: vault-consolidate [--dry-run|--apply]',
    );
    expect(result.stdout).toBe('');
  });

  // -------------------------------------------------------------------------
  // P0 — Classification matrix
  // -------------------------------------------------------------------------

  it('P0: classification matrix — copy / skip-already-present / merge (3 of 4 reachable; binary cases tested below)', () => {
    // NOTE: this test exercises the three obvious classifications. The
    // 4th — `conflict-needs-review` — was effectively dead code on Node 20+
    // before #508 (Node silently substituted U+FFFD instead of throwing from
    // readFile('utf8')). Post-#508 the script reads buffers + calls isUtf8()
    // explicitly, so the branch is reachable for binary content. See the
    // dedicated binary tests below.
    const tmpParent = mkTmp('classify-matrix');
    const source = join(tmpParent, 'source');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(source, { recursive: true });
    mkdirSync(canonical, { recursive: true });

    // (a) copy: in source, not in canonical
    writeFileSync(join(source, 'only-src.md'), 'only-in-source\n', 'utf8');

    // (b) skip-already-present: byte-identical
    const identical = 'identical content\n';
    writeFileSync(join(source, 'identical.md'), identical, 'utf8');
    writeFileSync(join(canonical, 'identical.md'), identical, 'utf8');

    // (c) merge: utf-8 readable, differing content
    writeFileSync(join(source, 'differs.md'), 'source version\n', 'utf8');
    writeFileSync(join(canonical, 'differs.md'), 'canonical version\n', 'utf8');

    const result = runScript([
      '--source', source,
      '--canonical', canonical,
      '--dry-run',
      '--json',
    ]);

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const actions = lines.filter((r) => r.kind === 'action');
    const byRel = Object.fromEntries(actions.map((a) => [a.rel, a.action]));

    expect(byRel['only-src.md']).toBe('copy');
    expect(byRel['identical.md']).toBe('skip-already-present');
    expect(byRel['differs.md']).toBe('merge');
    expect(Object.keys(byRel)).toHaveLength(3);
  });

  it('P0: classification — binary content on both sides classifies as conflict-needs-review (#508 fix)', () => {
    // Issue #508: before the isUtf8() switch, Node 20+ silently substituted
    // U+FFFD for invalid UTF-8 byte sequences, so `readFile('utf8')` never
    // threw and binary content was classified as `merge`. Post-fix, the
    // script reads buffers and uses isUtf8() from node:buffer for explicit
    // detection. Binary on both sides → conflict-needs-review.
    const tmpParent = mkTmp('classify-binary');
    const source = join(tmpParent, 'source');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(source, { recursive: true });
    mkdirSync(canonical, { recursive: true });

    writeFileSync(join(source, 'binary.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]));
    writeFileSync(join(canonical, 'binary.bin'), Buffer.from([0xfe, 0xff, 0x03, 0x04, 0x05]));

    const result = runScript([
      '--source', source,
      '--canonical', canonical,
      '--dry-run',
      '--json',
    ]);

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const action = lines.find((r) => r.kind === 'action' && r.rel === 'binary.bin');
    expect(action.action).toBe('conflict-needs-review');
  });

  it('P0: classification — binary on one side, valid UTF-8 on the other → conflict-needs-review (#508)', () => {
    // Mixed-case: source is binary, canonical is text (or vice-versa). The
    // pair is by definition irreconcilable as text, so the script must
    // surface it as conflict-needs-review for manual operator review rather
    // than attempting an AUQ diff that would render garbled.
    const tmpParent = mkTmp('classify-mixed');
    const source = join(tmpParent, 'source');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(source, { recursive: true });
    mkdirSync(canonical, { recursive: true });

    writeFileSync(join(source, 'mixed.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    writeFileSync(join(canonical, 'mixed.bin'), 'this is valid utf-8 text\n', 'utf8');

    const result = runScript([
      '--source', source,
      '--canonical', canonical,
      '--dry-run',
      '--json',
    ]);

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const action = lines.find((r) => r.kind === 'action' && r.rel === 'mixed.bin');
    expect(action.action).toBe('conflict-needs-review');
  });

  it('P0: classification — both sides valid UTF-8 with different content → merge (regression-guard for #508)', () => {
    // Counterpart to the binary tests: the merge path must remain reachable.
    // Two text files with different byte content classify as `merge`, NOT
    // conflict-needs-review.
    const tmpParent = mkTmp('classify-text-diff');
    const source = join(tmpParent, 'source');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(source, { recursive: true });
    mkdirSync(canonical, { recursive: true });

    writeFileSync(join(source, 'doc.md'), '# version A\nbody\n', 'utf8');
    writeFileSync(join(canonical, 'doc.md'), '# version B\nbody\n', 'utf8');

    const result = runScript([
      '--source', source,
      '--canonical', canonical,
      '--dry-run',
      '--json',
    ]);

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const action = lines.find((r) => r.kind === 'action' && r.rel === 'doc.md');
    expect(action.action).toBe('merge');
  });

  // -------------------------------------------------------------------------
  // P0 — Idempotency
  // -------------------------------------------------------------------------

  it('P0: idempotent --apply: second run all skip-already-present, no new backup', () => {
    const tmpParent = mkTmp('idempotent');
    const source = join(tmpParent, 'source');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(source, { recursive: true });
    mkdirSync(canonical, { recursive: true });

    writeFileSync(join(source, 'a.md'), 'content-a\n', 'utf8');
    writeFileSync(join(source, 'b.md'), 'content-b\n', 'utf8');

    // First --apply: both files copy
    const first = runScript(['--source', source, '--canonical', canonical, '--apply', '--json']);
    expect(first.status).toBe(0);

    // Verify canonical now has both files
    expect(readFileSync(join(canonical, 'a.md'), 'utf8')).toBe('content-a\n');
    expect(readFileSync(join(canonical, 'b.md'), 'utf8')).toBe('content-b\n');

    // Backup created in source from the first run — clean before second run
    // so we can assert that the second run creates NO new backup
    const backupsAfterFirst = readdirSync(source).filter((n) => n.startsWith('.vault-backup-'));
    for (const b of backupsAfterFirst) {
      rmSync(join(source, b), { recursive: true, force: true });
    }

    // Second --apply: should be a complete no-op
    const second = runScript(['--source', source, '--canonical', canonical, '--apply', '--json']);
    expect(second.status).toBe(0);

    const lines = second.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const results = lines.filter((r) => r.kind === 'result');
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'skip-already-present')).toBe(true);

    // No new backup directory or archive created on idempotent second run
    const afterSecond = readdirSync(source).filter((n) => n.startsWith('.vault-backup-'));
    expect(afterSecond).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // P0 — Unresolved-merge halt
  // -------------------------------------------------------------------------

  it('P0: --apply with unresolved merges → exit 3 with awaiting-merge-decision', () => {
    const tmpParent = mkTmp('unresolved');
    const source = join(tmpParent, 'source');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(source, { recursive: true });
    mkdirSync(canonical, { recursive: true });

    // Force a merge collision
    writeFileSync(join(source, 'conflict.md'), 'src version\n', 'utf8');
    writeFileSync(join(canonical, 'conflict.md'), 'dst version\n', 'utf8');

    const result = runScript([
      '--source', source,
      '--canonical', canonical,
      '--apply',
      '--json',
    ]);

    expect(result.status).toBe(3);
    const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const awaiting = lines.find((r) => r.kind === 'awaiting-merge-decision');
    expect(awaiting).toBeDefined();
    expect(awaiting.rel).toBe('conflict.md');
    expect(awaiting.action).toBe('merge');
  });

  // -------------------------------------------------------------------------
  // P1 — expandHome
  // -------------------------------------------------------------------------

  it('P1: --source ~/non-existent-path-XYZ123 → expands ~ and emits expanded path in summary', () => {
    // Source absent → exit 0 summary; we check that the summary path is
    // expanded (starts with the user's home dir, NOT a literal "~").
    const tmpParent = mkTmp('expand-home');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(canonical, { recursive: true });

    const result = runScript([
      '--source', '~/non-existent-vault-test-XYZ123-fake',
      '--canonical', canonical,
      '--json',
    ]);

    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout.trim());
    // The "~" must have been expanded — no literal tilde left in the path
    expect(summary.source.startsWith('~')).toBe(false);
    expect(summary.source).toContain('non-existent-vault-test-XYZ123-fake');
  });

  // -------------------------------------------------------------------------
  // P1 — isPrefix subset detection
  // -------------------------------------------------------------------------

  it('P1: isPrefix subset detection — src is prefix of dst → emits dst-is-superset hint', () => {
    const tmpParent = mkTmp('subset');
    const source = join(tmpParent, 'source');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(source, { recursive: true });
    mkdirSync(canonical, { recursive: true });

    // canonical content is a strict superset of source — same prefix +
    // extra content appended on canonical
    writeFileSync(join(source, 'note.md'), 'shared prefix line\n', 'utf8');
    writeFileSync(
      join(canonical, 'note.md'),
      'shared prefix line\nextra canonical content\n',
      'utf8',
    );

    const result = runScript([
      '--source', source,
      '--canonical', canonical,
      '--dry-run',
      '--json',
    ]);

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const action = lines.find((r) => r.kind === 'action' && r.rel === 'note.md');
    expect(action.action).toBe('merge');
    expect(action.subset_hint).toBe('dst-is-superset');
  });

  // -------------------------------------------------------------------------
  // P1 — --resolve src / dst / skip semantics
  // -------------------------------------------------------------------------

  it('P1: --resolve src overwrites canonical; dst retains; skip leaves both untouched', () => {
    const tmpParent = mkTmp('resolve-modes');
    const source = join(tmpParent, 'source');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(source, { recursive: true });
    mkdirSync(canonical, { recursive: true });

    // Three collisions: one resolved src, one dst, one skip
    writeFileSync(join(source, 'a.md'), 'src-a\n', 'utf8');
    writeFileSync(join(canonical, 'a.md'), 'dst-a\n', 'utf8');

    writeFileSync(join(source, 'b.md'), 'src-b\n', 'utf8');
    writeFileSync(join(canonical, 'b.md'), 'dst-b\n', 'utf8');

    writeFileSync(join(source, 'c.md'), 'src-c\n', 'utf8');
    writeFileSync(join(canonical, 'c.md'), 'dst-c\n', 'utf8');

    const result = runScript([
      '--source', source,
      '--canonical', canonical,
      '--apply',
      '--resolve', 'a.md=src',
      '--resolve', 'b.md=dst',
      '--resolve', 'c.md=skip',
    ]);

    expect(result.status).toBe(0);

    // a.md was 'src' → canonical now contains src content
    expect(readFileSync(join(canonical, 'a.md'), 'utf8')).toBe('src-a\n');
    // b.md was 'dst' → canonical retains its original content
    expect(readFileSync(join(canonical, 'b.md'), 'utf8')).toBe('dst-b\n');
    // c.md was 'skip' → both sides keep their original content
    expect(readFileSync(join(canonical, 'c.md'), 'utf8')).toBe('dst-c\n');
    expect(readFileSync(join(source, 'c.md'), 'utf8')).toBe('src-c\n');
  });

  // -------------------------------------------------------------------------
  // P1 — Backup tar compression success
  // -------------------------------------------------------------------------

  it('P1: --apply with write planned produces compressed backup archive and removes staging dir', () => {
    const tmpParent = mkTmp('backup-tar');
    const source = join(tmpParent, 'source');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(source, { recursive: true });
    mkdirSync(canonical, { recursive: true });

    // A single 'copy' action triggers backup staging + compression
    writeFileSync(join(source, 'note.md'), 'will-be-copied\n', 'utf8');

    const result = runScript([
      '--source', source,
      '--canonical', canonical,
      '--apply',
      '--json',
    ]);

    expect(result.status).toBe(0);

    // Find the .vault-backup-*.tar.gz archive in source root
    const sourceEntries = readdirSync(source);
    const archives = sourceEntries.filter(
      (n) => n.startsWith('.vault-backup-') && n.endsWith('.tar.gz'),
    );
    expect(archives).toHaveLength(1);

    // Staging directory should be removed after successful compression
    const stagingDirs = sourceEntries.filter(
      (n) => n.startsWith('.vault-backup-') && !n.endsWith('.tar.gz'),
    );
    expect(stagingDirs).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // P1 — Walk skip list
  // -------------------------------------------------------------------------

  it('P1: walk skips .git / .obsidian / .trash / node_modules / .DS_Store / ._* / .vault-backup-*', () => {
    const tmpParent = mkTmp('walk-skip');
    const source = join(tmpParent, 'source');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(source, { recursive: true });
    mkdirSync(canonical, { recursive: true });

    // Files inside skip-directories — must be IGNORED
    mkdirSync(join(source, '.git'), { recursive: true });
    writeFileSync(join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

    mkdirSync(join(source, '.obsidian'), { recursive: true });
    writeFileSync(join(source, '.obsidian', 'workspace.json'), '{}\n', 'utf8');

    mkdirSync(join(source, '.trash'), { recursive: true });
    writeFileSync(join(source, '.trash', 'deleted.md'), 'trash\n', 'utf8');

    mkdirSync(join(source, 'node_modules'), { recursive: true });
    writeFileSync(join(source, 'node_modules', 'package.json'), '{}\n', 'utf8');

    mkdirSync(join(source, '.vault-backup-1234'), { recursive: true });
    writeFileSync(join(source, '.vault-backup-1234', 'old.md'), 'old\n', 'utf8');

    // Skip-files in root
    writeFileSync(join(source, '.DS_Store'), 'mac-metadata\n', 'utf8');
    writeFileSync(join(source, '._hiddenmac'), 'apple-resource-fork\n', 'utf8');

    // One file that MUST be detected (the only non-skipped file)
    writeFileSync(join(source, 'real.md'), 'real-content\n', 'utf8');

    const result = runScript([
      '--source', source,
      '--canonical', canonical,
      '--dry-run',
      '--json',
    ]);

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const actions = lines.filter((r) => r.kind === 'action');

    // Only the single "real.md" action — every skip-target was ignored
    expect(actions).toHaveLength(1);
    expect(actions[0].rel).toBe('real.md');
    expect(actions[0].action).toBe('copy');
  });

  // -------------------------------------------------------------------------
  // Symlink / robustness hardening (#514 + folded-in F5 + F1)
  // -------------------------------------------------------------------------

  it('#514: symlinked source file is never dereferenced into the backup or canonical (--apply)', () => {
    // A symlink `evil.md → ../target-secret.txt` must NOT have its target's
    // contents copied anywhere. Defense-in-depth: TWO layers protect this —
    //   (1) walkFiles() skips the symlink (Dirent lstat semantics + the
    //       explicit isSymbolicLink() guard), so it never reaches the apply
    //       loop; this layer fires first in the live CLI flow.
    //   (2) stageBackup() lstat-guards independently, so even a future refactor
    //       that switched walk to fs.stat (which follows links) would still
    //       refuse to dereference a symlink into the backup. This layer is
    //       SHADOWED by (1) in the end-to-end flow, hence not separately
    //       observable here — the CLI is the contract and never routes a
    //       symlink to stageBackup. We assert the COMBINED observable contract:
    //       the secret never reaches canonical, never reaches the backup
    //       archive, and a WARN is emitted.
    const tmpParent = mkTmp('symlink-file');
    const source = join(tmpParent, 'source');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(source, { recursive: true });
    mkdirSync(canonical, { recursive: true });

    // The dereference target lives OUTSIDE the source vault (out-of-tree).
    const secret = 'TOP-SECRET-TARGET-CONTENT\n';
    writeFileSync(join(tmpParent, 'target-secret.txt'), secret, 'utf8');
    symlinkSync(join(tmpParent, 'target-secret.txt'), join(source, 'evil.md'));

    // A genuine file so a backup IS staged + compressed (the copy path runs).
    writeFileSync(join(source, 'real.md'), 'real-content\n', 'utf8');

    const result = runScript([
      '--source', source,
      '--canonical', canonical,
      '--apply',
      '--json',
    ]);

    expect(result.status).toBe(0);

    // 1. The symlink target's content NEVER landed in canonical.
    expect(existsSync(join(canonical, 'evil.md'))).toBe(false);
    // 2. The genuine file WAS copied (proves the copy path actually ran).
    expect(readFileSync(join(canonical, 'real.md'), 'utf8')).toBe('real-content\n');

    // 3. The backup archive does NOT contain the dereferenced secret.
    const archives = readdirSync(source).filter(
      (n) => n.startsWith('.vault-backup-') && n.endsWith('.tar.gz'),
    );
    expect(archives).toHaveLength(1);
    const archivePath = join(source, archives[0]);
    const list = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
    expect(list.status).toBe(0);
    // evil.md must not appear as a staged entry inside the archive.
    expect(list.stdout.includes('evil.md')).toBe(false);

    // 4. A WARN naming the skipped symlink was emitted to stderr.
    expect(result.stderr).toContain('skipping symlink');
    expect(result.stderr).toContain('evil.md');
  });

  it('F5: symlinked directory is not recursed — its target entries never appear', () => {
    // A symlinked directory `linkdir → ../outside-dir` must NOT be recursed
    // into; the file inside the link target must be invisible to the walk.
    const tmpParent = mkTmp('symlink-dir');
    const source = join(tmpParent, 'source');
    const canonical = join(tmpParent, 'canonical');
    mkdirSync(source, { recursive: true });
    mkdirSync(canonical, { recursive: true });

    // An out-of-source directory with a sentinel file.
    const outsideDir = join(tmpParent, 'outside-dir');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'sentinel.md'), 'should-not-be-seen\n', 'utf8');

    // Symlink it into the source vault.
    symlinkSync(outsideDir, join(source, 'linkdir'));

    // A genuine file at the source root so the walk still finds real work.
    writeFileSync(join(source, 'real.md'), 'real-content\n', 'utf8');

    const result = runScript([
      '--source', source,
      '--canonical', canonical,
      '--dry-run',
      '--json',
    ]);

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    const actions = lines.filter((r) => r.kind === 'action');

    // ONLY real.md — the sentinel inside the symlinked dir was never recursed.
    expect(actions).toHaveLength(1);
    expect(actions[0].rel).toBe('real.md');
    // No action references the link path or the sentinel rel-path.
    const rels = actions.map((a) => a.rel);
    expect(rels.some((r) => r.includes('sentinel.md'))).toBe(false);
    expect(rels.some((r) => r.includes('linkdir'))).toBe(false);

    // WARN naming the skipped symlinked directory.
    expect(result.stderr).toContain('skipping symlink');
    expect(result.stderr).toContain('linkdir');
  });

  it('F1: tar non-ENOENT failure (status 1) → uncompressed staging dir kept, "tar failed" WARN, not regressed by F1 res.error guard', () => {
    // Companion to the ENOENT test: when `tar` IS found on PATH but EXITS with
    // a non-zero status (e.g. bad arg, corrupted destination, full disk), the
    // script must STILL fall back to leaving the uncompressed staging dir
    // in place — the F1 res.error guard above must not have regressed this
    // pre-existing fallback path. We simulate the non-zero-exit case with a
    // fake `tar` binary on PATH that prints to stderr and exits 1.
    //
    // Why not use res.error: F1 specifically guards ENOENT. A genuine `status
    // !== 0` (tar present, archive failed) falls through to the original
    // generic "tar failed" branch. This test pins THAT branch so a future
    // refactor that conflated the two error classes would fail loudly.
    const tmpParent = mkTmp('tar-status1');
    const source = join(tmpParent, 'source');
    const canonical = join(tmpParent, 'canonical');
    const fakeBin = join(tmpParent, 'fake-bin');
    mkdirSync(source, { recursive: true });
    mkdirSync(canonical, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });

    // Fake `tar` that prints a fake error and exits 1. Bash shebang is portable
    // on the macOS test host and the Linux CI runners; we need an executable
    // file (not a node script) so spawnSync('tar', ...) resolves it via PATH.
    const fakeTar = join(fakeBin, 'tar');
    writeFileSync(
      fakeTar,
      '#!/bin/sh\necho "fake-tar: simulated archive failure" >&2\nexit 1\n',
      'utf8',
    );
    // chmod +x — required for spawn to find it as an executable on PATH.
    spawnSync('chmod', ['+x', fakeTar]);

    // A copy action triggers backup staging + the (now-failing) compression.
    writeFileSync(join(source, 'note.md'), 'will-be-copied\n', 'utf8');

    // PATH=fakeBin first so the fake `tar` resolves ahead of /usr/bin/tar.
    // The script's own `spawnSync('tar', ...)` invocation is bare-name, so it
    // walks PATH and finds our fake binary. Other helpers (cp, mkdir) are
    // invoked via Node libraries, not subprocess, so they're unaffected.
    // We keep /bin so /bin/sh (the shebang) is findable.
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--source', source, '--canonical', canonical, '--apply', '--json'],
      { encoding: 'utf8', env: { PATH: `${fakeBin}:/bin:/usr/bin` } },
    );

    // Copy still succeeded — tar failure only affects backup compression.
    expect(result.status).toBe(0);
    expect(readFileSync(join(canonical, 'note.md'), 'utf8')).toBe('will-be-copied\n');

    // Generic "tar failed (status 1)" WARN — NOT the ENOENT "tar not found" branch.
    expect(result.stderr).toContain('tar failed (status 1)');
    expect(result.stderr).not.toContain('tar not found on PATH');

    // Fallback: uncompressed staging dir is preserved; no .tar.gz archive.
    const entries = readdirSync(source);
    const stagingDirs = entries.filter(
      (n) => n.startsWith('.vault-backup-') && !n.endsWith('.tar.gz'),
    );
    const archives = entries.filter(
      (n) => n.startsWith('.vault-backup-') && n.endsWith('.tar.gz'),
    );
    expect(stagingDirs).toHaveLength(1);
    expect(archives).toHaveLength(0);
    // Staged file is preserved inside the surviving uncompressed dir.
    expect(
      readFileSync(join(source, stagingDirs[0], 'note.md'), 'utf8'),
    ).toBe('will-be-copied\n');
  });

  it('F1: tar absent (ENOENT) → clear "tar not found" WARN, uncompressed staging dir kept as fallback', () => {
    // Simulate a minimal environment with no `tar` on PATH by pointing PATH at
    // an empty dir. spawnSync('tar', ...) then sets res.error (ENOENT) with
    // res.status === null. The F1 guard must surface "tar not found on PATH"
    // (NOT "tar failed (status null)") and leave the staging directory intact.
    const tmpParent = mkTmp('tar-enoent');
    const source = join(tmpParent, 'source');
    const canonical = join(tmpParent, 'canonical');
    const emptyBin = join(tmpParent, 'empty-bin');
    mkdirSync(source, { recursive: true });
    mkdirSync(canonical, { recursive: true });
    mkdirSync(emptyBin, { recursive: true });

    // A copy action triggers backup staging + the (now-failing) compression.
    writeFileSync(join(source, 'note.md'), 'will-be-copied\n', 'utf8');

    // Spawn with the ABSOLUTE node path (process.execPath) and an empty PATH:
    // node itself still resolves, but the script's inner `spawnSync('tar', ...)`
    // cannot find `tar` → ENOENT (res.error set, res.status === null). Using
    // the runScript('node', ...) helper would instead break node's OWN
    // resolution under the empty PATH, so we invoke the binary directly here.
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--source', source, '--canonical', canonical, '--apply', '--json'],
      { encoding: 'utf8', env: { PATH: emptyBin } },
    );

    // Copy still succeeded — tar failure only affects the backup compression.
    expect(result.status).toBe(0);
    expect(readFileSync(join(canonical, 'note.md'), 'utf8')).toBe('will-be-copied\n');

    // Clear, specific WARN — not the confusing "status null" message.
    expect(result.stderr).toContain('tar not found on PATH');
    expect(result.stderr).not.toContain('status null');

    // Fallback: the UNCOMPRESSED staging dir remains (no .tar.gz produced).
    const entries = readdirSync(source);
    const stagingDirs = entries.filter(
      (n) => n.startsWith('.vault-backup-') && !n.endsWith('.tar.gz'),
    );
    const archives = entries.filter(
      (n) => n.startsWith('.vault-backup-') && n.endsWith('.tar.gz'),
    );
    expect(stagingDirs).toHaveLength(1);
    expect(archives).toHaveLength(0);
    // The genuine file is preserved inside the uncompressed staging dir.
    expect(
      readFileSync(join(source, stagingDirs[0], 'note.md'), 'utf8'),
    ).toBe('will-be-copied\n');
  });
});
