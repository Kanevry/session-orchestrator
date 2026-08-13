/**
 * backfill-learnings-from-vault.test.mjs — hermetic tests for
 * scripts/backfill-learnings-from-vault.mjs (issue #1017).
 *
 * Every fixture is built in $TMPDIR and — crucially — the rule files and the
 * vault notes are produced by the REAL producers (`reconcile/renderer.mjs`
 * `renderRule` and `vault-mirror/render-learnings.mjs` `generateLearningNote`),
 * not hand-shaped to match what the reader expects. A hand-written fixture
 * would encode the reader's assumption and stay green forever if a producer
 * changed its output shape (`.claude/rules/testing.md` § Fixtures Mirror
 * Production Data). The real repo, the real store and the real vault are NEVER
 * touched: `--vault-dir` and `deps.repoRoot` are always injected.
 *
 * Each test names the concrete bug it catches in its title/comment.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import {
  main,
  parseRuleProvenance,
  parseVaultNote,
  vaultSlugFor,
  kebabKey,
  locateNote,
} from '../../scripts/backfill-learnings-from-vault.mjs';
import { renderRule } from '../../scripts/lib/reconcile/renderer.mjs';
import { generateLearningNote } from '../../scripts/lib/vault-mirror/render-learnings.mjs';
import { unwritablePath } from '../_helpers/unwritable-path.mjs';

const NOW = '2026-08-12T00:00:00.000Z';
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  vi.restoreAllMocks();
});

function mkTmp(prefix) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
}

/** A canonical learning record, the shape both producers consume. */
function learningOf(overrides = {}) {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    type: 'anti-pattern',
    subject: 'a guard that only pins the exit code stops discriminating under exit-0',
    insight: 'Under an exit-0 protocol the payload IS the decision, so an exit-code assertion asserts nothing.',
    evidence: '2026-07-29: 23 residual bare exit-0 assertions in one already-migrated file.',
    confidence: 0.9,
    source_session: 'main-2026-07-29-deep-1',
    created_at: '2026-07-29T14:03:11.000Z',
    expires_at: '2026-10-27T14:03:11.000Z',
    schema_version: 1,
    ...overrides,
  };
}

/**
 * Build a repo + vault fixture.
 *
 * @param {object[]} specs — one per learning: `{ learning, inStore?, inArchive?,
 *   inBackup?, note?: 'omit'|'mutate', mutate?: (noteText) => string,
 *   noteRepoNs?: string, extraNoteAt?: string }`
 */
function makeFixture(specs, { storeSeed = [] } = {}) {
  const repoRoot = mkTmp('so-bf-repo-');
  const vaultDir = mkTmp('so-bf-vault-');
  const repoNs = basename(repoRoot);

  mkdirSync(join(repoRoot, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(repoRoot, '.orchestrator', 'metrics'), { recursive: true });
  mkdirSync(join(vaultDir, '40-learnings', repoNs), { recursive: true });

  const storeLines = [...storeSeed];
  const archiveLines = [];
  const backupLines = [];

  for (const spec of specs) {
    const l = spec.learning;
    const key = `${l.type}/${kebabKey(l.subject)}`;
    const { content: ruleText, slug } = renderRule(l, {
      globs: spec.globs ?? ['tests/**', 'scripts/**'],
      description: l.insight.slice(0, 60),
      learningKey: key,
      confidence: l.confidence,
      expiresAt: (spec.ruleExpiresAt ?? l.expires_at).slice(0, 10),
    });
    writeFileSync(join(repoRoot, '.claude', 'rules', `${slug}.md`), spec.ruleMutate ? spec.ruleMutate(ruleText) : ruleText);

    if (spec.note !== 'omit') {
      const noteSlug = vaultSlugFor(l.subject);
      let noteText = generateLearningNote(l, noteSlug, { repoNs: spec.noteRepoNs ?? repoNs });
      if (spec.mutate) noteText = spec.mutate(noteText);
      const dir = join(vaultDir, '40-learnings', spec.noteDir ?? repoNs);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${noteSlug}.md`), noteText);
      if (spec.extraNoteDir) {
        const dir2 = join(vaultDir, '40-learnings', spec.extraNoteDir);
        mkdirSync(dir2, { recursive: true });
        writeFileSync(
          join(dir2, `${noteSlug}.md`),
          generateLearningNote(l, noteSlug, { repoNs: spec.extraNoteDir })
        );
      }
    }

    if (spec.inStore) storeLines.push(JSON.stringify(l));
    if (spec.inArchive) archiveLines.push(JSON.stringify(l));
    if (spec.inBackup) backupLines.push(JSON.stringify(l));
  }

  const storePath = join(repoRoot, '.orchestrator', 'metrics', 'learnings.jsonl');
  writeFileSync(storePath, storeLines.map((l) => `${l}\n`).join(''));
  writeFileSync(
    join(repoRoot, '.orchestrator', 'metrics', 'learnings-archive.jsonl'),
    archiveLines.map((l) => `${l}\n`).join('')
  );
  if (backupLines.length > 0) {
    writeFileSync(`${storePath}.bak-2026-08-01T00-00-00-000Z`, backupLines.map((l) => `${l}\n`).join(''));
  }

  return { repoRoot, vaultDir, repoNs, storePath };
}

/** Run the CLI with stdout/stderr captured so test logs stay readable. */
async function runMain(argv, deps) {
  const out = [];
  const err = [];
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
  const se = vi.spyOn(process.stderr, 'write').mockImplementation((s) => (err.push(String(s)), true));
  try {
    const res = await main(argv, deps);
    return { ...res, stdout: out.join(''), stderr: err.join('') };
  } finally {
    so.mockRestore();
    se.mockRestore();
  }
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const orphansOf = (report) => report.records.filter((r) => r.status === 'orphan');

describe('orphan detection', () => {
  // Bug: a learning-id that still resolves in the live store (or the archive)
  // being reported as an orphan → the tool "recovers" a record that never left
  // and the coordinator appends a lossy duplicate.
  it('classifies each provenance pointer by where it actually resolves', async () => {
    const inStore = learningOf({ id: 'aaaaaaaa-0000-4000-8000-000000000001', subject: 'record that is still in the store' });
    const inArchive = learningOf({ id: 'aaaaaaaa-0000-4000-8000-000000000002', subject: 'record that was archived' });
    const lost = learningOf({ id: 'aaaaaaaa-0000-4000-8000-000000000003', subject: 'record that the prune destroyed' });
    const { repoRoot, vaultDir } = makeFixture([
      { learning: inStore, inStore: true },
      { learning: inArchive, inArchive: true },
      { learning: lost },
    ]);

    const { code, report } = await runMain(['--vault-dir', vaultDir], { repoRoot, now: NOW });

    expect(code).toBe(0);
    const byId = Object.fromEntries(report.records.map((r) => [r.learning_id, r.status]));
    expect(byId[inStore.id]).toBe('present-in-store');
    expect(byId[inArchive.id]).toBe('present-in-archive');
    expect(byId[lost.id]).toBe('orphan');
    expect(report.summary.orphans).toBe(1);
  });

  // Bug: a record that still exists VERBATIM in a `.bak-*` sibling being
  // reconstructed from the vault instead — silently replacing a byte-exact
  // original with a date-truncated reconstruction.
  it('prefers a verbatim backup over vault reconstruction', async () => {
    const l = learningOf({ id: 'bbbbbbbb-0000-4000-8000-000000000001' });
    const { repoRoot, vaultDir } = makeFixture([{ learning: l, inBackup: true }]);

    const { report } = await runMain(['--vault-dir', vaultDir], { repoRoot, now: NOW });

    const rec = report.records.find((r) => r.learning_id === l.id);
    expect(rec.status).toBe('recoverable-verbatim-from-backup');
    expect(rec.restorable).toBe(false);
    expect(rec.record).toBeUndefined();
    expect(report.summary.orphans).toBe(0);
    expect(report.summary.recoverable_from_backup).toBe(1);
  });

  // Bug: a rule file carrying a NUL byte is invisible to a binary-skipping grep
  // — measured on this fixture: `grep -Ic learning-id <file>` prints nothing and
  // exits 1, while the file plainly contains the pointer. A grep-based census
  // would drop that rule silently and UNDER-report the data loss. This tool
  // reads through node:fs, so the NUL cannot hide a lost record from it.
  it('still sees a rule file that contains a NUL byte', async () => {
    const l = learningOf({ id: 'cccccccc-0000-4000-8000-000000000001' });
    const { repoRoot, vaultDir } = makeFixture([
      // \u0000 escape, never a literal NUL — a literal one would make THIS test file
      // invisible to grep too, and the repo's pre-commit NUL gate would block it.
      { learning: l, ruleMutate: (t) => t.replace('description: ', 'description: \u0000 ') },
    ]);

    const { report } = await runMain(['--vault-dir', vaultDir], { repoRoot, now: NOW });

    expect(report.summary.rules_with_provenance).toBe(1);
    expect(orphansOf(report)[0].learning_id).toBe(l.id);
  });
});

describe('vault lookup honesty', () => {
  // Bug: a silent miss — an orphan whose note cannot be found being dropped from
  // the report, so the summary looks complete while records are unaccounted for.
  it('reports a missing vault note loudly instead of skipping it', async () => {
    const l = learningOf({ id: 'dddddddd-0000-4000-8000-000000000001' });
    const { repoRoot, vaultDir } = makeFixture([{ learning: l, note: 'omit' }]);

    const { report, stdout } = await runMain(['--vault-dir', vaultDir], { repoRoot, now: NOW });

    const rec = orphansOf(report)[0];
    expect(rec.vault_note).toBeNull();
    expect(rec.restorable).toBe(false);
    expect(rec.validation_error).toMatch(/no vault note located/);
    expect(report.summary.located_in_vault).toBe(0);
    expect(report.summary.restorable).toBe(0);
    expect(stdout).toContain('NOT FOUND');
  });

  // Bug: two notes with the same slug (this repo + another repo's namespace)
  // and the tool silently picks one — attributing another repo's record to this
  // repo's learning-id.
  it('reports an ambiguous slug match instead of picking one', async () => {
    const l = learningOf({ id: 'eeeeeeee-0000-4000-8000-000000000001' });
    // Both copies live under FOREIGN namespaces, so the source-repo narrowing
    // cannot break the tie.
    const { repoRoot, vaultDir } = makeFixture([
      { learning: l, noteDir: 'other-repo-a', noteRepoNs: 'other-repo-a', extraNoteDir: 'other-repo-b' },
    ]);

    const { report } = await runMain(['--vault-dir', vaultDir], { repoRoot, now: NOW });

    const rec = orphansOf(report)[0];
    expect(rec.vault_note).toBeNull();
    expect(rec.ambiguous_candidates).toHaveLength(2);
    expect(rec.restorable).toBe(false);
  });

  // Bug: the tie-break silently favouring an arbitrary candidate rather than the
  // note that actually belongs to this repo.
  it('breaks a slug tie by source-repo when exactly one candidate matches', async () => {
    const l = learningOf({ id: 'eeeeeeee-0000-4000-8000-000000000002' });
    const { repoRoot, vaultDir, repoNs } = makeFixture([{ learning: l, extraNoteDir: 'other-repo-b' }]);

    const { report } = await runMain(['--vault-dir', vaultDir], { repoRoot, now: NOW });

    const rec = orphansOf(report)[0];
    expect(rec.vault_note).toBe(join(repoNs, `${vaultSlugFor(l.subject)}.md`));
    expect(rec.restorable).toBe(true);
  });
});

describe('reconstruction fidelity', () => {
  // Bug: presenting a date-only vault value as if it were the record's original
  // timestamp — a fabricated time-of-day that looks authoritative.
  it('labels created_at as derived from the vault DATE, not as an original', async () => {
    const l = learningOf({ id: 'ffffffff-0000-4000-8000-000000000001' });
    const { repoRoot, vaultDir } = makeFixture([{ learning: l }]);

    const { report } = await runMain(['--vault-dir', vaultDir], { repoRoot, now: NOW });

    const rec = orphansOf(report)[0];
    expect(rec.record.created_at).toBe('2026-07-29T00:00:00.000Z');
    expect(rec.fidelity.created_at).toMatch(/^derived:vault-date/);
    // The original carried a time-of-day; the reconstruction must not pretend to.
    expect(rec.record.created_at).not.toBe(l.created_at);
    // Fields that ARE verbatim must be labelled as such, per source.
    expect(rec.fidelity.insight).toMatch(/^vault/);
    expect(rec.fidelity.id).toMatch(/^rule-provenance/);
    expect(rec.record.insight).toBe(l.insight);
    expect(rec.record.evidence).toBe(l.evidence);
    expect(rec.record.confidence).toBe(l.confidence);
    expect(rec.record.source_session).toBe(l.source_session);
  });

  // Bug: inverting the rule's `globs:` back into `file_paths` — the globs are a
  // lossy projection, so any inversion is a guess dressed as recovered data.
  it('never reconstructs file_paths from the rule globs', async () => {
    const l = learningOf({ id: 'ffffffff-0000-4000-8000-000000000002' });
    const { repoRoot, vaultDir } = makeFixture([{ learning: l, globs: ['scripts/lib/**'] }]);

    const { report } = await runMain(['--vault-dir', vaultDir], { repoRoot, now: NOW });

    const rec = orphansOf(report)[0];
    expect('file_paths' in rec.record).toBe(false);
    expect(rec.fidelity.file_paths).toContain('NOT reconstructed');
    expect(rec.fidelity.file_paths).toContain('scripts/lib/**');
  });

  // Bug: restoring the mirror's "(none recorded)" placeholder as if it were the
  // record's real evidence.
  it('does not restore the mirror evidence sentinel as content', async () => {
    const l = learningOf({ id: 'ffffffff-0000-4000-8000-000000000003' });
    const { repoRoot, vaultDir } = makeFixture([
      { learning: l, mutate: (t) => t.replace(l.evidence, '(none recorded)'), ruleMutate: (t) => t.replace(l.evidence, '(no evidence recorded)') },
    ]);

    const { report } = await runMain(['--vault-dir', vaultDir], { repoRoot, now: NOW });

    const rec = orphansOf(report)[0];
    expect(rec.record.evidence).toBe('');
    expect(rec.fidelity.evidence).toContain('sentinel');
  });

  // Bug: an empty `conflicts` list read as "the two copies corroborate" when in
  // truth no comparison was possible (the file-wide-toContain failure mode).
  it('records per-field cross-checks so an empty conflict list is never vacuous', async () => {
    const l = learningOf({ id: 'ffffffff-0000-4000-8000-000000000004' });
    const { repoRoot, vaultDir } = makeFixture([{ learning: l }]);

    const { report } = await runMain(['--vault-dir', vaultDir], { repoRoot, now: NOW });

    const rec = orphansOf(report)[0];
    expect(rec.conflicts).toEqual([]);
    expect(rec.cross_checks.insight).toBe('match');
    expect(rec.cross_checks.evidence).toBe('match');
    expect(rec.cross_checks.confidence).toBe('match');

    // …and when a copy is genuinely absent, the check says so rather than
    // silently counting as corroboration.
    const stripped = makeFixture([
      { learning: l, ruleMutate: (t) => t.replace(`\n${l.evidence}\n`, '\n(no evidence recorded)\n') },
    ]);
    const second = await runMain(['--vault-dir', stripped.vaultDir], { repoRoot: stripped.repoRoot, now: NOW });
    expect(orphansOf(second.report)[0].cross_checks.evidence).toBe('not-possible (rule side carries no value)');
  });

  // Bug: inventing a confidence (or any other required field) when neither
  // source carries one — a fabricated value looks authoritative and is worse
  // than a missing record.
  it('refuses to invent a missing required field and fails the validation gate', async () => {
    const l = learningOf({ id: 'ffffffff-0000-4000-8000-000000000005' });
    const { repoRoot, vaultDir } = makeFixture([
      {
        learning: l,
        mutate: (t) => t.replace(/^- \*\*Confidence:\*\*.*$/m, ''),
        ruleMutate: (t) => t.replace(/^- confidence: .*$/gm, '').replace(/^confidence: .*$/gm, ''),
      },
    ]);

    const { report } = await runMain(['--vault-dir', vaultDir], { repoRoot, now: NOW });

    const rec = orphansOf(report)[0];
    expect(rec.fidelity.confidence).toBe('absent');
    expect(rec.validates).toBe(false);
    expect(rec.validation_error).toMatch(/confidence/);
    expect(rec.restorable).toBe(false);
    expect(report.summary.restorable).toBe(0);
  });
});

describe('write discipline', () => {
  // Bug: a "dry-run" that still touches the store. A record-count check would
  // not catch a replace-two-with-one rewrite, so the byte hash is the assertion.
  it('dry-run leaves the store byte-identical', async () => {
    const l = learningOf({ id: '99999999-0000-4000-8000-000000000001' });
    const seed = JSON.stringify(learningOf({ id: '99999999-0000-4000-8000-0000000000ff', subject: 'an unrelated record' }));
    const { repoRoot, vaultDir, storePath } = makeFixture([{ learning: l }], { storeSeed: [seed] });
    const before = sha(storePath);
    const archivePath = join(repoRoot, '.orchestrator', 'metrics', 'learnings-archive.jsonl');
    const archiveBefore = sha(archivePath);

    const { report } = await runMain(['--vault-dir', vaultDir], { repoRoot, now: NOW });

    expect(report.dry_run).toBe(true);
    expect(report.summary.restorable).toBe(1);
    expect(sha(storePath)).toBe(before);
    expect(sha(archivePath)).toBe(archiveBefore);
  });

  // Bug: `--apply` rewriting the store (the very mechanism that lost the data)
  // or double-appending on a second run because membership is not re-checked.
  it('--apply appends without rewriting, and a second --apply is a no-op', async () => {
    const l = learningOf({ id: '99999999-0000-4000-8000-000000000002' });
    const seed = JSON.stringify(learningOf({ id: '99999999-0000-4000-8000-0000000000fe', subject: 'a pre-existing record' }));
    const { repoRoot, vaultDir, storePath } = makeFixture([{ learning: l }], { storeSeed: [seed] });

    const first = await runMain(['--vault-dir', vaultDir, '--apply'], { repoRoot, now: NOW });
    expect(first.report.summary.applied).toBe(1);

    const linesAfterFirst = readFileSync(storePath, 'utf8').trim().split('\n');
    expect(linesAfterFirst).toHaveLength(2);
    // The pre-existing record survived verbatim — an append, never a rewrite.
    expect(linesAfterFirst[0]).toBe(seed);
    const restored = JSON.parse(linesAfterFirst[1]);
    expect(restored.id).toBe(l.id);
    // A reconstruction must be distinguishable from a record that never left.
    expect(restored._restored_from).toBe('vault');
    expect(restored._restored_at).toBe(NOW);
    expect(restored._restored_fidelity.created_at).toMatch(/^derived:/);

    const hashAfterFirst = sha(storePath);
    const second = await runMain(['--vault-dir', vaultDir, '--apply'], { repoRoot, now: NOW });
    expect(second.report.summary.applied).toBe(0);
    expect(second.report.summary.orphans).toBe(0);
    expect(sha(storePath)).toBe(hashAfterFirst);
  });

  // Bug: an append that fails being swallowed, so the run reports success while
  // nothing was restored.
  it('surfaces an append failure instead of reporting a silent success', async () => {
    if (process.platform === 'win32') return;
    const l = learningOf({ id: '99999999-0000-4000-8000-000000000003' });
    const { repoRoot, vaultDir } = makeFixture([{ learning: l }]);

    const { report, stderr } = await runMain(
      ['--vault-dir', vaultDir, '--apply', '--store', unwritablePath('learnings.jsonl')],
      { repoRoot, now: NOW }
    );

    expect(report.summary.applied).toBe(0);
    const rec = orphansOf(report)[0];
    expect(rec.applied).toBe(false);
    expect(rec.apply_error).toBeTruthy();
    expect(stderr).toContain('append failed');
  });
});

describe('pure helpers', () => {
  // Bug: the rule parser matching hand-authored rules (which carry no
  // provenance) and inventing a null-id census row.
  it('parseRuleProvenance returns null for a rule without a Provenance block', () => {
    expect(parseRuleProvenance('# Testing Rules\n\nSome prose.\n')).toBeNull();
  });

  // Bug: the note-slug derivation drifting from vault-mirror/process.mjs, which
  // would make every lookup miss (subjectToSlug strips spaces WITHOUT
  // hyphenating — the #725 D1 collapse defect).
  it('vaultSlugFor mirrors the vault-mirror slug derivation', () => {
    expect(vaultSlugFor('POSIX tr|cmp is the only portable detector')).toBe('posix-trcmp-is-the-only-portable-detector');
    expect(kebabKey('POSIX tr|cmp is the only portable detector')).toBe('posix-tr-cmp-is-the-only-portable-detector');
  });

  // Bug: a note that is not a learning note (a daily note, a session note)
  // being parsed as a learning and matched by slug.
  it('parseVaultNote reports the frontmatter type so non-learning notes can be excluded', () => {
    const note = parseVaultNote('---\nid: x\ntype: daily\n---\n\n# X\n', '/tmp/x.md');
    expect(note.noteType).toBe('daily');
  });

  // Bug: a lookup that finds nothing silently returning a candidate anyway.
  it('locateNote returns a null note when nothing matches', () => {
    expect(locateNote([], { subject: 'nothing here', keySlug: 'nothing-here', learningId: 'x' })).toEqual({
      note: null,
      strategy: null,
      ambiguous: null,
    });
  });
});
