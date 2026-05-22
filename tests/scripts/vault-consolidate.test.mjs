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
});
