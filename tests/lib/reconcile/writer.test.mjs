/**
 * writer.test.mjs — Unit tests for scripts/lib/reconcile/writer.mjs (FA3 #696).
 *
 * Covers:
 *   - Happy path: approved rule written atomically to .claude/rules/<slug>.md
 *   - Rejected proposal archived to .orchestrator/reconcile.rejected.log (JSONL)
 *   - PATH TRAVERSAL (mandatory): path escaping .claude/rules/ is rejected and
 *     the file outside the guard zone must not be created (errors[] populated).
 *   - Empty inputs: no approved + no rejected → { written:0, archived:0, errors:[] }
 *
 * ALL disk I/O targets a unique per-test temp dir under os.tmpdir().
 * The real .claude/rules/ and .orchestrator/ are NEVER touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeApprovedRules } from '../../../scripts/lib/reconcile/writer.mjs';
import { isProcessed } from '../../../scripts/lib/reconcile/idempotency.mjs';
import { renderRule } from '../../../scripts/lib/reconcile/renderer.mjs';
import { parseGlobsFrontmatter } from '../../../scripts/lib/rule-loader.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'reconcile-writer-'));
  // Pre-create .claude/rules/ so path validation passes for approved items
  mkdirSync(join(tmpDir, '.claude', 'rules'), { recursive: true });
  // Pre-create .orchestrator/ so lock acquisition + rejected log can write
  mkdirSync(join(tmpDir, '.orchestrator'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy path — writes an approved rule file
// ---------------------------------------------------------------------------

describe('writeApprovedRules — approved rule write', () => {
  it('writes an approved rule to .claude/rules/<slug>.md with exact content', async () => {
    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'test-rule',
          path: '.claude/rules/test-rule.md',
          content: '# Test Rule\n\nThis is the rule body.\n',
        },
      ],
      rejected: [],
      repoRoot: tmpDir,
      sessionId: 'session-test-001',
    });

    expect(result.written).toBe(1);
    expect(result.archived).toBe(0);
    expect(result.errors).toEqual([]);

    const destPath = join(tmpDir, '.claude', 'rules', 'test-rule.md');
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, 'utf8')).toBe('# Test Rule\n\nThis is the rule body.\n');
  });

  it('returns written count equal to the number of approved items when multiple are provided', async () => {
    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'rule-alpha',
          path: '.claude/rules/rule-alpha.md',
          content: '# Alpha\n',
        },
        {
          slug: 'rule-beta',
          path: '.claude/rules/rule-beta.md',
          content: '# Beta\n',
        },
      ],
      rejected: [],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(2);
    expect(result.errors).toEqual([]);

    expect(existsSync(join(tmpDir, '.claude', 'rules', 'rule-alpha.md'))).toBe(true);
    expect(existsSync(join(tmpDir, '.claude', 'rules', 'rule-beta.md'))).toBe(true);
    expect(readFileSync(join(tmpDir, '.claude', 'rules', 'rule-alpha.md'), 'utf8')).toBe('# Alpha\n');
    expect(readFileSync(join(tmpDir, '.claude', 'rules', 'rule-beta.md'), 'utf8')).toBe('# Beta\n');
  });
});

// ---------------------------------------------------------------------------
// Rejected proposal archived to JSONL log
// ---------------------------------------------------------------------------

describe('writeApprovedRules — rejected proposal archive', () => {
  it('appends a JSONL line to .orchestrator/reconcile.rejected.log with _rejected_reason + _rejected_at', async () => {
    const result = await writeApprovedRules({
      approved: [],
      rejected: [
        {
          learningKey: 'fragile-pattern/some-rule',
          type: 'fragile-pattern',
          reason: 'user-declined',
          status: 'rejected',
        },
      ],
      repoRoot: tmpDir,
      sessionId: 'session-test-002',
    });

    expect(result.written).toBe(0);
    expect(result.archived).toBe(1);
    expect(result.errors).toEqual([]);

    const logPath = join(tmpDir, '.orchestrator', 'reconcile.rejected.log');
    expect(existsSync(logPath)).toBe(true);

    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]);
    expect(record._rejected_reason).toBe('user-declined');
    expect(typeof record._rejected_at).toBe('string');
    // _rejected_at must be a valid ISO 8601 timestamp
    expect(new Date(record._rejected_at).toISOString()).toBe(record._rejected_at);
    expect(record.learningKey).toBe('fragile-pattern/some-rule');
    expect(record.type).toBe('fragile-pattern');
  });

  it('does NOT warn about re-proposal when a prior terminal verdict is already on disk', async () => {
    // BUG this catches (TV-001): `markCandidateProcessed` returns
    // `alreadyProcessed`, and NO production caller read it — so the two very
    // different states behind `written:false` collapsed into one message. When
    // the store already holds a terminal verdict for the key, the operator was
    // told "a later run may re-propose it", which is FALSE: the sidecar is in
    // exactly the state the stamp wanted, and the operator is sent after a
    // non-bug.
    const runtimeDir = join(tmpDir, '.orchestrator', 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const storePath = join(runtimeDir, 'reconcile-candidates.jsonl');
    writeFileSync(
      storePath,
      // Full record shape — a partial one is dropped by the store's schema
      // check (measured: `{records:[], skipped:1}`) and the seed would be
      // silently absent, which is how this test would pass vacuously.
      JSON.stringify({
        id: 'rc-seed',
        schema_version: 1,
        learning_key: 'fragile-pattern/already-done',
        slug: 'already-done',
        status: 'rejected',
        reason: 'seeded',
        confidence: 0.9,
        created_at: '2026-01-01T00:00:00.000Z',
        superseded_by: null,
        outcome: 'rejected',
        processed_at: '2026-01-01T00:00:00.000Z',
      }) + '\n',
      'utf8',
    );
    // Reads keep working, writes fail → `written:false` with the terminal
    // record still found. This is the only way to reach the branch without
    // mocking the module under test.
    chmodSync(runtimeDir, 0o555);

    try {
      const result = await writeApprovedRules({
        approved: [],
        rejected: [
          {
            learningKey: 'fragile-pattern/already-done',
            type: 'fragile-pattern',
            reason: 'user-declined',
            status: 'rejected',
            operatorRejected: true,
          },
        ],
        repoRoot: tmpDir,
        sessionId: 'session-test-already-processed',
      });

      expect(result.archived).toBe(1);
      expect(result.errors).toHaveLength(1);
      // FALSIFICATION: without reading `alreadyProcessed` the message is the
      // generic failure line and both assertions below flip.
      expect(result.errors[0]).toContain('a prior terminal verdict is already on disk');
      expect(result.errors[0]).not.toContain('may re-propose it');
    } finally {
      chmodSync(runtimeDir, 0o755);
    }
  });

  it('uses "user-declined" as _rejected_reason when item.reason is absent', async () => {
    const result = await writeApprovedRules({
      approved: [],
      rejected: [
        {
          learningKey: 'anti-pattern/no-reason',
          type: 'anti-pattern',
          status: 'rejected',
          // note: no `reason` field
        },
      ],
      repoRoot: tmpDir,
    });

    expect(result.archived).toBe(1);
    expect(result.errors).toEqual([]);

    const logPath = join(tmpDir, '.orchestrator', 'reconcile.rejected.log');
    const record = JSON.parse(readFileSync(logPath, 'utf8').trim());
    expect(record._rejected_reason).toBe('user-declined');
  });

  it('archives multiple rejected items as separate JSONL lines', async () => {
    const result = await writeApprovedRules({
      approved: [],
      rejected: [
        { learningKey: 'frag/a', type: 'fragile-pattern', reason: 'low-confidence', status: 'rejected' },
        { learningKey: 'frag/b', type: 'recurring-issue', reason: 'user-declined', status: 'rejected' },
      ],
      repoRoot: tmpDir,
    });

    expect(result.archived).toBe(2);
    expect(result.errors).toEqual([]);

    const logPath = join(tmpDir, '.orchestrator', 'reconcile.rejected.log');
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first._rejected_reason).toBe('low-confidence');
    expect(second._rejected_reason).toBe('user-declined');
  });
});

// ---------------------------------------------------------------------------
// PATH TRAVERSAL — mandatory security test
// ---------------------------------------------------------------------------

describe('writeApprovedRules — path traversal (MANDATORY security test)', () => {
  it('rejects a path escaping .claude/rules/ via ../ traversal and does not write the file', async () => {
    const evilRelPath = '.claude/rules/../../evil.md';
    const evilAbsPath = join(tmpDir, 'evil.md');

    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'evil',
          path: evilRelPath,
          content: 'PWNED',
        },
      ],
      rejected: [],
      repoRoot: tmpDir,
    });

    // The traversal attempt must be blocked — nothing written
    expect(result.written).toBe(0);
    // An error must be collected (not silently dropped)
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    // The evil file must NOT exist outside .claude/rules/
    expect(existsSync(evilAbsPath)).toBe(false);
  });

  it('rejects an absolute path pointing outside the repo', async () => {
    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'abs-escape',
          path: '/tmp/injected-rule.md',
          content: 'INJECTED',
        },
      ],
      rejected: [],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(0);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects a path inside .claude/ but outside .claude/rules/', async () => {
    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'settings-escape',
          path: '.claude/settings.json',
          content: '{}',
        },
      ],
      rejected: [],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(0);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(tmpDir, '.claude', 'settings.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// STRUCTURAL CONTENT GATE (#1015) — the last chokepoint before disk.
//
// Every pre-existing defence in writer.mjs is PATH-oriented; not one byte of
// `content` was inspected before this gate. These fixtures are written as
// LITERAL documents rather than rendered, so they pin the writer's own contract
// and stay independent of the renderer's (separately-owned) sanitiser.
//
// PAYLOAD NOTE — the injected key is `tier: always`, deliberately NOT
// `expires-at:` or `globs:`. The renderer emits `expires-at`/`globs` LATER in
// the same frontmatter block, so an injected copy of either is overwritten and
// the attack reads GREEN even with no guard at all. `tier` is never emitted by
// the renderer, so an injected `tier` SURVIVES — it is the payload that
// actually discriminates. Do not "simplify" it back to expires-at.
// ---------------------------------------------------------------------------

/** A well-formed auto-generated rule document (the renderer's real shape). */
function soundRuleDoc() {
  return [
    '---',
    'auto-generated: true',
    'alwaysApply: false',
    'description: a benign description',
    'globs:',
    '  - "scripts/lib/x/**"',
    'learning-key: fragile-pattern/x',
    'confidence: 0.8',
    'expires-at: 2099-09-30',
    '---',
    '',
    '# Auto-generated rule: x',
    '',
  ].join('\n');
}

/** Case B — an injected `\n---` closes the frontmatter early. */
function caseBDoc() {
  return [
    '---',
    'auto-generated: true',
    'alwaysApply: false',
    'description: benign start',
    'tier: always',
    '---', // ← injected: everything below is body text, not frontmatter
    'globs:',
    '  - "scripts/lib/x/**"',
    'learning-key: fragile-pattern/x',
    'expires-at: 2099-09-30',
    '---',
    '',
    '# body',
    '',
  ].join('\n');
}

/** Case E — an injected colon-less line makes the frontmatter unparseable. */
function caseEDoc() {
  return [
    '---',
    'auto-generated: true',
    'alwaysApply: false',
    'description: benign start',
    'INJECTED LINE WITH NO COLON', // ← parseGlobsFrontmatter throws here
    'tier: always',
    'globs:',
    '  - "scripts/lib/x/**"',
    'learning-key: fragile-pattern/x',
    'expires-at: 2099-09-30',
    '---',
    '',
    '# body',
    '',
  ].join('\n');
}

/** Every entry currently in .claude/rules/ of the fixture repo. */
function rulesDirEntries() {
  return readdirSync(join(tmpDir, '.claude', 'rules'));
}

describe('writeApprovedRules — structural content gate (#1015)', () => {
  it('writes a structurally sound auto-generated rule (the gate does not over-block)', async () => {
    const result = await writeApprovedRules({
      approved: [{ slug: 'sound', path: '.claude/rules/sound.md', content: soundRuleDoc() }],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(1);
    expect(result.errors).toEqual([]);

    // Assert on the PARSED frontmatter, not a file-wide substring search: a
    // file-wide toContain matches text anywhere in the document (including the
    // body or a comment) and so passes for states the frontmatter never reaches.
    const written = readFileSync(join(tmpDir, '.claude', 'rules', 'sound.md'), 'utf8');
    const { globs, meta } = parseGlobsFrontmatter(written);
    expect(globs).toEqual(['scripts/lib/x/**']);
    expect(meta['learning-key']).toBe('fragile-pattern/x');
    expect(meta['expires-at']).toBe('2099-09-30');
    expect(meta.tier).toBeUndefined();
  });

  it('refuses Case B — an injected \\n--- truncates the frontmatter into an always-on rule', async () => {
    // Verified against the real parser: globs → null, learning-key and
    // expires-at gone, `auto-generated: true` and the injected `tier: always`
    // survive. rule-loader.mjs then loads it with alwaysOn: true and no expiry.
    // FALSIFICATION: without the gate this returns written:1 and the file lands.
    const result = await writeApprovedRules({
      approved: [{ slug: 'case-b', path: '.claude/rules/case-b.md', content: caseBDoc() }],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/content-structure/);
    expect(existsSync(join(tmpDir, '.claude', 'rules', 'case-b.md'))).toBe(false);
  });

  it('refuses Case E — an injected colon-less line makes the frontmatter unparseable', async () => {
    // This is the shape the CI validator used to SKIP: rule-loader.mjs catches
    // the same throw and falls back to globs=null/meta={}/parseError=true, i.e.
    // always-on AND clearing every gate. Unparseable means unsafe, not unknown.
    const result = await writeApprovedRules({
      approved: [{ slug: 'case-e', path: '.claude/rules/case-e.md', content: caseEDoc() }],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/does not parse/);
    expect(existsSync(join(tmpDir, '.claude', 'rules', 'case-e.md'))).toBe(false);
  });

  it('refuses an auto-generated doc carrying alwaysApply: true', async () => {
    const content = soundRuleDoc().replace('alwaysApply: false', 'alwaysApply: true');
    const result = await writeApprovedRules({
      approved: [{ slug: 'always', path: '.claude/rules/always.md', content }],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(existsSync(join(tmpDir, '.claude', 'rules', 'always.md'))).toBe(false);
  });

  it('refuses an auto-generated doc with an empty globs array and no host-class', async () => {
    const content = soundRuleDoc().replace('globs:\n  - "scripts/lib/x/**"', 'globs: []');
    const result = await writeApprovedRules({
      approved: [{ slug: 'empty-globs', path: '.claude/rules/empty-globs.md', content }],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(existsSync(join(tmpDir, '.claude', 'rules', 'empty-globs.md'))).toBe(false);
  });

  it('leaves NO .tmp residue behind when a write is refused (crash-safety)', async () => {
    // The gate runs BEFORE mkdir/tmp-file creation, so a refusal must not leak
    // a half-written `<target>.XXXXXXXX.tmp`. A surviving tmp file would be a
    // partially-visible rule fragment sitting inside .claude/rules/.
    const result = await writeApprovedRules({
      approved: [
        { slug: 'case-b', path: '.claude/rules/case-b.md', content: caseBDoc() },
        { slug: 'case-e', path: '.claude/rules/case-e.md', content: caseEDoc() },
      ],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(0);
    expect(result.errors).toHaveLength(2);
    // Assert on the directory listing (a parsed unit), not on a single path.
    expect(rulesDirEntries()).toEqual([]);
  });

  it('isolates per item — one sound doc lands while a poisoned sibling is refused', async () => {
    const result = await writeApprovedRules({
      approved: [
        { slug: 'case-b', path: '.claude/rules/case-b.md', content: caseBDoc() },
        { slug: 'sound', path: '.claude/rules/sound.md', content: soundRuleDoc() },
      ],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(rulesDirEntries()).toEqual(['sound.md']);
  });
});

// ---------------------------------------------------------------------------
// #1018 L2 — the invariants bind without an `auto-generated` marker
// ---------------------------------------------------------------------------

describe('writeApprovedRules — invariants bind without auto-generated (#1018 L2)', () => {
  it('refuses a doc declaring alwaysApply: true when it carries NO auto-generated key', async () => {
    // THE BUG: before #1018 the alwaysApply check sat behind the
    // `auto-generated: true` branch, so dropping that one key walked a
    // self-declared always-on rule straight past the gate onto disk. A
    // `writeApprovedRules` probe on exactly this input returned `written: 1`.
    // A rule file that declares itself always-on must never be the way to
    // bypass the checks that exist to stop a written rule being always-on.
    const content = [
      '---',
      'alwaysApply: true',
      'description: looks hand-authored, is not',
      'globs:',
      '  - "scripts/lib/x/**"',
      'learning-key: fragile-pattern/x',
      'expires-at: 2099-09-30',
      '---',
      '',
      '# body',
      '',
    ].join('\n');

    const result = await writeApprovedRules({
      approved: [{ slug: 'sneaky', path: '.claude/rules/sneaky.md', content }],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/alwaysApply: true/);
    expect(existsSync(join(tmpDir, '.claude', 'rules', 'sneaky.md'))).toBe(false);
    expect(rulesDirEntries()).toEqual([]);
  });

  it('refuses a provenance-bearing doc with no activation axis even when auto-generated is absent', async () => {
    // Marker-loss shape: `auto-generated: true` is the FIRST line the renderer
    // emits, so a truncation that eats it can leave the provenance keys behind.
    // Keying the invariant on the marker SET (learning-key / expires-at /
    // auto-generated) rather than on `auto-generated` alone still catches it.
    const content = [
      '---',
      'description: provenance without the marker',
      'learning-key: fragile-pattern/x',
      'expires-at: 2099-09-30',
      '---',
      '',
      '# body',
      '',
    ].join('\n');

    const result = await writeApprovedRules({
      approved: [{ slug: 'marker-loss', path: '.claude/rules/marker-loss.md', content }],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/no activation axis/);
    expect(rulesDirEntries()).toEqual([]);
  });

  it('still writes real renderRule output — the production /reconcile path is not blocked', async () => {
    // The counter-check that makes the two refusals above meaningful: a gate
    // that rejects its own production caller is an outage, not a gate. This
    // exercises the REAL renderer rather than a hand-shaped fixture, so a
    // future renderer change that trips the widened gate fails here.
    const { path: rulePath, content } = renderRule(
      {
        id: 'writer-1018-l2',
        subject: 'gate binds without the auto-generated marker',
        insight: 'the invariants must not be bypassable by dropping one key',
        evidence: 'probe returned written:1 for alwaysApply:true without auto-generated',
        source_session: 'main-2026-08-14-session-1',
      },
      {
        globs: ['scripts/lib/reconcile/**'],
        description: 'reconcile writer gate',
        learningKey: 'proven-pattern/writer-gate-binds-without-marker',
        confidence: 0.9,
        expiresAt: '2099-09-30',
      },
    );

    const result = await writeApprovedRules({
      approved: [{ slug: 'prod-path', path: rulePath, content }],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(1);
    expect(result.errors).toEqual([]);

    // Assert on the PARSED frontmatter of what actually landed, not a
    // file-wide substring search.
    const onDisk = readFileSync(join(tmpDir, rulePath), 'utf8');
    const { globs, meta } = parseGlobsFrontmatter(onDisk);
    expect(globs).toEqual(['scripts/lib/reconcile/**']);
    expect(meta.alwaysApply).toBe(false);
    expect(meta['auto-generated']).toBe(true);
    expect(meta['learning-key']).toBe('proven-pattern/writer-gate-binds-without-marker');
  });
});

// ---------------------------------------------------------------------------
// Empty inputs — zero-work fast path
// ---------------------------------------------------------------------------

describe('writeApprovedRules — empty inputs', () => {
  it('returns { written:0, archived:0, errors:[] } when both approved and rejected are empty', async () => {
    const result = await writeApprovedRules({
      approved: [],
      rejected: [],
      repoRoot: tmpDir,
    });

    expect(result).toEqual({ written: 0, archived: 0, errors: [] });
  });

  it('returns { written:0, archived:0, errors:[] } when approved and rejected are omitted / undefined', async () => {
    const result = await writeApprovedRules({
      approved: undefined,
      rejected: undefined,
      repoRoot: tmpDir,
    });

    // approved and rejected both coerce to [] → both empty → fast-path
    expect(result).toEqual({ written: 0, archived: 0, errors: [] });
  });
});

// ---------------------------------------------------------------------------
// Error collection — approved item missing content
// ---------------------------------------------------------------------------

describe('writeApprovedRules — error collection (non-fatal)', () => {
  it('collects an error for an approved item with no content and still returns written:0', async () => {
    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'no-content',
          path: '.claude/rules/no-content.md',
          // content deliberately omitted
        },
      ],
      rejected: [],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(0);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(tmpDir, '.claude', 'rules', 'no-content.md'))).toBe(false);
  });

  it('collects an error for an approved item missing path and does not throw', async () => {
    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'no-path',
          // path deliberately omitted
          content: '# some content',
        },
      ],
      rejected: [],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(0);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency-sidecar stamp after a successful write (issue #484 point 1)
// ---------------------------------------------------------------------------

describe('writeApprovedRules — stamps the idempotency sidecar after a successful write (#484)', () => {
  function storeLines() {
    const storePath = join(tmpDir, '.orchestrator', 'runtime', 'reconcile-candidates.jsonl');
    if (!existsSync(storePath)) return [];
    return readFileSync(storePath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('marks the candidate for item.learningKey terminal with outcome "written"', async () => {
    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'stamped-rule',
          path: '.claude/rules/stamped-rule.md',
          content: '# Stamped Rule\n\nBody.\n',
          learningKey: 'fragile-pattern/stamped-rule',
          candidateId: 'rc-teststamp',
          confidence: 0.8,
        },
      ],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(1);
    expect(result.errors).toEqual([]);

    const records = storeLines();
    expect(records).toHaveLength(1);
    expect(records[0].learning_key).toBe('fragile-pattern/stamped-rule');
    expect(records[0].outcome).toBe('written');
    expect(typeof records[0].processed_at).toBe('string');
    // processed_at must be a valid ISO 8601 timestamp
    expect(new Date(records[0].processed_at).toISOString()).toBe(records[0].processed_at);
  });

  it('preserves the prior sidecar record (id/slug/confidence) — only ADDS the terminal stamp', async () => {
    // Pre-seed the store with a live (non-terminal) candidate, mirroring what
    // engine.mjs writes when it first proposes a learning.
    const runtimeDir = join(tmpDir, '.orchestrator', 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const preExisting = {
      id: 'rc-preexist1',
      schema_version: 1,
      learning_key: 'anti-pattern/pre-existing',
      slug: 'anti-pattern-pre-existing-abcdef1',
      status: 'proposed',
      reason: 'reconciliation engine proposed a conditional rule',
      confidence: 0.77,
      created_at: '2026-08-01T00:00:00.000Z',
      processed_at: null,
      superseded_by: null,
    };
    writeFileSync(join(runtimeDir, 'reconcile-candidates.jsonl'), JSON.stringify(preExisting) + '\n', 'utf8');

    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'pre-existing-rule',
          path: '.claude/rules/pre-existing-rule.md',
          content: '# Pre-existing\n',
          learningKey: 'anti-pattern/pre-existing',
        },
      ],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(1);
    expect(result.errors).toEqual([]);

    const records = storeLines();
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('rc-preexist1'); // preserved, not re-minted
    expect(records[0].slug).toBe('anti-pattern-pre-existing-abcdef1'); // preserved
    expect(records[0].confidence).toBe(0.77); // preserved
    expect(records[0].outcome).toBe('written');
    expect(typeof records[0].processed_at).toBe('string');
  });

  it('does not touch the sidecar when the approved item carries no learningKey', async () => {
    const result = await writeApprovedRules({
      approved: [{ slug: 'no-key', path: '.claude/rules/no-key.md', content: '# No key\n' }],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(1);
    expect(result.errors).toEqual([]);
    expect(existsSync(join(tmpDir, '.orchestrator', 'runtime', 'reconcile-candidates.jsonl'))).toBe(false);
  });

  it('does not stamp when the write itself failed (path-confinement refusal)', async () => {
    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'escape',
          path: '.claude/rules/../../evil-escape.md',
          content: '# escape\n',
          learningKey: 'fragile-pattern/never-written',
        },
      ],
      repoRoot: tmpDir,
    });

    expect(result.written).toBe(0);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(tmpDir, '.orchestrator', 'runtime', 'reconcile-candidates.jsonl'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Terminal sidecar stamp for an OPERATOR rejection (issue #1042)
//
// TV-001 — the bug these catch: AN OPERATOR REJECTION IS FORGOTTEN ON THE NEXT
// RUN. Before this fix, a declined proposal reached only the append-only
// rejected LOG (`_rejected_at`), which nothing reads back, while `isProcessed()`
// judges terminality by `processed_at` in the sidecar. So the operator's "no"
// evaporated and the identical rule was proposed again on every subsequent run.
// The second case pins the other half: the same stamp must NOT be applied to an
// engine-side rejection, or a learning cut by the volume brake would be
// suppressed forever.
// ---------------------------------------------------------------------------

describe('writeApprovedRules — stamps an operator rejection terminal (#1042)', () => {
  function storeRecords() {
    const storePath = join(tmpDir, '.orchestrator', 'runtime', 'reconcile-candidates.jsonl');
    if (!existsSync(storePath)) return null;
    return readFileSync(storePath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('marks an operator-declined proposal terminal with outcome "rejected" so isProcessed() suppresses it next run', async () => {
    // A proposal the operator saw in the approval AUQ and unselected: the full
    // ReconcileProposal shape (slug/path/content), joined into the rejected
    // array per skills/session-end/phase-3-6-tail.md step 6.
    const declined = {
      learningKey: 'fragile-pattern/operator-said-no',
      slug: 'fragile-pattern-operator-said-no-abc1234',
      path: '.claude/rules/fragile-pattern-operator-said-no-abc1234.md',
      content: '# Auto-generated rule: operator said no\n',
      confidence: 0.85,
      candidateId: 'rc-declined1',
      status: 'proposed',
      // #1153 P15 — phase-3-6-tail.md step 6 stamps this explicit flag.
      operatorRejected: true,
    };

    const result = await writeApprovedRules({ approved: [], rejected: [declined], repoRoot: tmpDir });

    expect(result.archived).toBe(1);
    expect(result.errors).toEqual([]);

    // The rule file must NOT exist — a rejection writes no rule.
    expect(existsSync(join(tmpDir, declined.path))).toBe(false);

    const records = storeRecords();
    expect(records).toHaveLength(1);
    expect(records[0].learning_key).toBe('fragile-pattern/operator-said-no');
    expect(records[0].outcome).toBe('rejected');
    expect(typeof records[0].processed_at).toBe('string');
    expect(new Date(records[0].processed_at).toISOString()).toBe(records[0].processed_at);

    // Assert through the real consumer, not just the field: this is exactly the
    // call engine.mjs makes on the next run.
    expect(isProcessed({ learning_key: 'fragile-pattern/operator-said-no' }, records)).toBe(true);
  });

  it('does NOT stamp an engine-side rejection (capped / ineligible) — it must stay proposable', async () => {
    const engineRejections = [
      {
        learningKey: 'fragile-pattern/capped-this-run',
        type: 'fragile-pattern',
        reason: 'capped — max-proposals-per-run (10) reached; 3 lower-confidence eligible learning(s) not proposed this run',
        status: 'rejected',
      },
      {
        learningKey: 'anti-pattern/too-young',
        type: 'anti-pattern',
        reason: 'learning is younger than min-rule-days',
        status: 'rejected',
      },
    ];

    const result = await writeApprovedRules({ approved: [], rejected: engineRejections, repoRoot: tmpDir });

    expect(result.archived).toBe(2);
    expect(result.errors).toEqual([]);
    // No sidecar at all — nothing was stamped terminal.
    expect(storeRecords()).toBeNull();
  });

  it('stamps only the operator-declined item when both shapes arrive in one rejected array', async () => {
    const result = await writeApprovedRules({
      approved: [],
      rejected: [
        {
          learningKey: 'anti-pattern/engine-cut',
          type: 'anti-pattern',
          reason: 'capped — max-proposals-per-run (10) reached',
          status: 'rejected',
        },
        {
          learningKey: 'fragile-pattern/operator-cut',
          slug: 'fragile-pattern-operator-cut-def5678',
          path: '.claude/rules/fragile-pattern-operator-cut-def5678.md',
          content: '# Auto-generated rule: operator cut\n',
          confidence: 0.9,
          status: 'proposed',
          operatorRejected: true,
        },
      ],
      repoRoot: tmpDir,
    });

    expect(result.archived).toBe(2);
    expect(result.errors).toEqual([]);

    const records = storeRecords();
    expect(records).toHaveLength(1);
    expect(records[0].learning_key).toBe('fragile-pattern/operator-cut');
    expect(records[0].outcome).toBe('rejected');
  });

  it('stamps on the explicit operatorRejected flag even when the rendered content is EMPTY (#1153 P15 — flag wins)', async () => {
    // The bug this catches: keying on content presence alone, an
    // operator-declined proposal whose rendered body happened to be empty was
    // read as an ENGINE rejection and never stamped terminal — so the operator's
    // "no" evaporated and the rule came back next run (the #1042 bug, reopened
    // through the heuristic's blind spot).
    const result = await writeApprovedRules({
      approved: [],
      rejected: [
        {
          learningKey: 'anti-pattern/declined-with-empty-body',
          slug: 'anti-pattern-declined-with-empty-body-aaa1111',
          path: '.claude/rules/anti-pattern-declined-with-empty-body-aaa1111.md',
          content: '',
          confidence: 0.88,
          status: 'proposed',
          operatorRejected: true,
        },
      ],
      repoRoot: tmpDir,
    });

    expect(result.archived).toBe(1);
    expect(result.errors).toEqual([]);
    const records = storeRecords();
    expect(records).toHaveLength(1);
    expect(records[0].learning_key).toBe('anti-pattern/declined-with-empty-body');
    expect(records[0].outcome).toBe('rejected');
    expect(isProcessed({ learning_key: 'anti-pattern/declined-with-empty-body' }, records)).toBe(true);
  });

  it('LEGACY fallback — stamps a flagless item that carries rendered content (pre-P15 skill bodies)', async () => {
    // A consumer repo pinning a phase-3-6-tail.md older than the P15 stamp emits
    // no `operatorRejected` key at all. The deprecated content-presence fallback
    // in isOperatorRejection() keeps those rejections terminal; delete this test
    // together with the fallback at its documented removal trigger.
    const result = await writeApprovedRules({
      approved: [],
      rejected: [
        {
          learningKey: 'convention/declined-by-legacy-caller',
          slug: 'convention-declined-by-legacy-caller-bbb2222',
          path: '.claude/rules/convention-declined-by-legacy-caller-bbb2222.md',
          content: '# Auto-generated rule: declined by a pre-P15 caller\n',
          confidence: 0.8,
          status: 'proposed',
        },
      ],
      repoRoot: tmpDir,
    });

    expect(result.archived).toBe(1);
    const records = storeRecords();
    expect(records).toHaveLength(1);
    expect(records[0].learning_key).toBe('convention/declined-by-legacy-caller');
    expect(records[0].outcome).toBe('rejected');
  });

  it('extends the existing sidecar record rather than minting a parallel one (id/created_at preserved)', async () => {
    // Mirrors what engine.mjs merged into the store when it PROPOSED the rule,
    // moments before the operator declined it in the AUQ.
    const runtimeDir = join(tmpDir, '.orchestrator', 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    const proposedRecord = {
      id: 'rc-proposed9',
      schema_version: 1,
      learning_key: 'fragile-pattern/declined-after-propose',
      slug: 'fragile-pattern-declined-after-propose-9999999',
      status: 'proposed',
      reason: 'reconciliation engine proposed a conditional rule',
      confidence: 0.91,
      created_at: '2026-08-01T00:00:00.000Z',
      processed_at: null,
      superseded_by: null,
    };
    writeFileSync(join(runtimeDir, 'reconcile-candidates.jsonl'), JSON.stringify(proposedRecord) + '\n', 'utf8');

    const result = await writeApprovedRules({
      approved: [],
      rejected: [
        {
          learningKey: 'fragile-pattern/declined-after-propose',
          slug: 'fragile-pattern-declined-after-propose-9999999',
          path: '.claude/rules/fragile-pattern-declined-after-propose-9999999.md',
          content: '# Auto-generated rule: declined after propose\n',
          confidence: 0.91,
          status: 'proposed',
          operatorRejected: true,
        },
      ],
      repoRoot: tmpDir,
    });

    expect(result.archived).toBe(1);
    expect(result.errors).toEqual([]);

    const records = storeRecords();
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('rc-proposed9'); // preserved, not re-minted
    expect(records[0].created_at).toBe('2026-08-01T00:00:00.000Z'); // preserved
    expect(records[0].confidence).toBe(0.91); // preserved
    expect(records[0].outcome).toBe('rejected');
    expect(typeof records[0].processed_at).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// BASELINE WRITE TARGET (#1099)
//
// TV-001 — the bug this whole block catches: `reconcile.targets` had ZERO
// consumers. Every approved rule landed in `<repoRoot>/.claude/rules/` no matter
// what the operator declared, so a learning could never cross the repo boundary
// into the shared baseline. These tests go through the REAL `writeApprovedRules`
// call — not through the helpers in isolation — because the only defect class
// that matters here is one on the code path that actually touches disk.
//
// The baseline root is ALWAYS a fresh mkdtemp under os.tmpdir(). The operator's
// real projects-baseline checkout is never a test fixture.
// ---------------------------------------------------------------------------

describe('writeApprovedRules — baseline target (#1099)', () => {
  let baselineRoot;

  beforeEach(() => {
    baselineRoot = mkdtempSync(join(tmpdir(), 'reconcile-baseline-'));
  });

  afterEach(() => {
    rmSync(baselineRoot, { recursive: true, force: true });
  });

  it('writes one file per proposal under <baselineRoot>/proposals/ when targets: [baseline]', async () => {
    const result = await writeApprovedRules({
      approved: [{ slug: 'sound', path: '.claude/rules/sound.md', content: soundRuleDoc() }],
      repoRoot: tmpDir,
      baselineRoot,
      targets: ['baseline'],
    });

    expect(result.errors).toEqual([]);
    expect(result.written).toBe(1);

    const dest = join(baselineRoot, 'proposals', 'sound.md');
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe(soundRuleDoc());

    // targets: [baseline] means baseline ONLY — the repo copy must not appear.
    expect(existsSync(join(tmpDir, '.claude', 'rules', 'sound.md'))).toBe(false);
  });

  it('writes to BOTH targets when both are declared, and stamps the sidecar exactly once', async () => {
    const result = await writeApprovedRules({
      approved: [
        {
          slug: 'sound',
          path: '.claude/rules/sound.md',
          content: soundRuleDoc(),
          learningKey: 'fragile-pattern/x',
        },
      ],
      repoRoot: tmpDir,
      baselineRoot,
      targets: ['repo-local', 'baseline'],
    });

    expect(result.errors).toEqual([]);
    // `written` is a FILE count, not a proposal count.
    expect(result.written).toBe(2);
    expect(existsSync(join(tmpDir, '.claude', 'rules', 'sound.md'))).toBe(true);
    expect(existsSync(join(baselineRoot, 'proposals', 'sound.md'))).toBe(true);

    const storePath = join(tmpDir, '.orchestrator', 'runtime', 'reconcile-candidates.jsonl');
    const lines = readFileSync(storePath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it('the filename comes from item.slug, NOT from item.path', async () => {
    // A repo-local path that says one thing and a slug that says another: the
    // baseline leaf must follow the slug, which is the only kebab-derived,
    // non-attacker-controllable component the proposal carries.
    await writeApprovedRules({
      approved: [{ slug: 'from-the-slug', path: '.claude/rules/from-the-path.md', content: soundRuleDoc() }],
      repoRoot: tmpDir,
      baselineRoot,
      targets: ['baseline'],
    });

    expect(readdirSync(join(baselineRoot, 'proposals'))).toEqual(['from-the-slug.md']);
  });

  it('omitting targets is byte-identical to the pre-#1099 behaviour (repo-local only)', async () => {
    const result = await writeApprovedRules({
      approved: [{ slug: 'sound', path: '.claude/rules/sound.md', content: soundRuleDoc() }],
      repoRoot: tmpDir,
      baselineRoot,
      // targets deliberately omitted
    });

    expect(result.written).toBe(1);
    expect(result.errors).toEqual([]);
    expect(existsSync(join(tmpDir, '.claude', 'rules', 'sound.md'))).toBe(true);
    expect(existsSync(join(baselineRoot, 'proposals'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BASELINE NO-OP PATHS (#1099 acceptance criterion 2)
//
// TV-001 — the bug these catch: a baseline root that is absent or not on disk
// (the fresh-clone / CI case, which is the COMMON case on any host that has not
// cloned projects-baseline) must degrade to a no-op with an audit trail. The
// specific failure to prevent is `mkdir -p` on a typo'd root: it would mint a
// whole directory tree that looks exactly like a successful write.
// ---------------------------------------------------------------------------

describe('writeApprovedRules — baseline no-op paths (#1099)', () => {
  it('does NOT create a non-existent baseline root, and reports the skip', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'reconcile-nobase-'));
    const missingRoot = join(parent, 'never-cloned-baseline');

    try {
      const result = await writeApprovedRules({
        approved: [{ slug: 'sound', path: '.claude/rules/sound.md', content: soundRuleDoc() }],
        repoRoot: tmpDir,
        baselineRoot: missingRoot,
        targets: ['repo-local', 'baseline'],
      });

      // THE assertion: no directory tree was minted under the typo'd root.
      expect(existsSync(missingRoot)).toBe(false);
      // The other target is unaffected — one bad root does not fail the batch.
      expect(result.written).toBe(1);
      expect(existsSync(join(tmpDir, '.claude', 'rules', 'sound.md'))).toBe(true);
      expect(result.errors.some((e) => e.includes('does not exist as a directory'))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('degrades to a no-op when baselineRoot is absent entirely', async () => {
    const result = await writeApprovedRules({
      approved: [{ slug: 'sound', path: '.claude/rules/sound.md', content: soundRuleDoc() }],
      repoRoot: tmpDir,
      targets: ['baseline'],
      // baselineRoot deliberately omitted
    });

    expect(result.written).toBe(0);
    expect(result.errors.some((e) => e.includes('no baselineRoot supplied'))).toBe(true);
    // Crucially: it did NOT silently fall back to writing into the repo.
    expect(existsSync(join(tmpDir, '.claude', 'rules', 'sound.md'))).toBe(false);
  });

  it('an EXPLICIT empty targets list writes nowhere — it is never defaulted back to repo-local', async () => {
    // TV-001: `resolveEffectiveTargets` returns [] when `targets: [baseline]` was
    // declared and the root turned out unusable. Defaulting [] to ['repo-local']
    // would silently redirect a baseline-only write INTO this repo — the operator
    // asked for one destination and would get a different one.
    const result = await writeApprovedRules({
      approved: [{ slug: 'sound', path: '.claude/rules/sound.md', content: soundRuleDoc() }],
      repoRoot: tmpDir,
      targets: [],
    });

    expect(result.written).toBe(0);
    expect(existsSync(join(tmpDir, '.claude', 'rules', 'sound.md'))).toBe(false);
    expect(result.errors.some((e) => e.includes('no write target in effect'))).toBe(true);
  });

  it('an unknown target has no row in the table and therefore writes nothing', async () => {
    const result = await writeApprovedRules({
      approved: [{ slug: 'sound', path: '.claude/rules/sound.md', content: soundRuleDoc() }],
      repoRoot: tmpDir,
      targets: ['global'],
    });

    expect(result.written).toBe(0);
    expect(result.errors.some((e) => e.includes('no row in the write-target table'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SLUG PATH-TRAVERSAL (#1099 acceptance criterion 5) — MANDATORY security test
//
// TV-001 — the bug this catches: the baseline branch derives its FILENAME from
// `item.slug`. `deriveSlug` is kebab-produced today, but the writer must not
// depend on an upstream derivation staying that way — a crafted slug reaching
// `path.join(subdir, slug + '.md')` unchecked would escape `<root>/proposals/`.
// ---------------------------------------------------------------------------

describe('writeApprovedRules — crafted slug is refused by SLUG_RE (MANDATORY security test)', () => {
  let baselineRoot;

  beforeEach(() => {
    baselineRoot = mkdtempSync(join(tmpdir(), 'reconcile-slugsec-'));
  });

  afterEach(() => {
    rmSync(baselineRoot, { recursive: true, force: true });
  });

  it.each([
    { why: 'relative traversal', slug: '../../evil', escapee: 'evil.md' },
    { why: 'absolute path', slug: '/tmp/evil', escapee: 'evil.md' },
    { why: 'nested separator', slug: 'sub/evil', escapee: 'evil.md' },
    { why: 'dot-prefixed', slug: '.evil', escapee: '.evil.md' },
    { why: 'uppercase (not kebab-producible)', slug: 'Evil', escapee: 'Evil.md' },
    { why: 'leading hyphen (not kebab-producible)', slug: '-evil', escapee: '-evil.md' },
    { why: 'empty string', slug: '', escapee: '.md' },
  ])('refuses a $why slug and writes nothing', async ({ slug, escapee }) => {
    const result = await writeApprovedRules({
      approved: [{ slug, path: '.claude/rules/decoy.md', content: soundRuleDoc() }],
      repoRoot: tmpDir,
      baselineRoot,
      targets: ['baseline'],
    });

    expect(result.written).toBe(0);
    expect(result.errors.some((e) => e.startsWith('slug-safety:'))).toBe(true);
    // Nothing escaped the confinement zone, in either direction.
    expect(existsSync(join(baselineRoot, escapee))).toBe(false);
    expect(existsSync(join(tmpDir, escapee))).toBe(false);
    const proposals = join(baselineRoot, 'proposals');
    expect(existsSync(proposals) ? readdirSync(proposals) : []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-target symlink hardening (#1099) — the check is per (target, root) pair.
//
// TV-001 — the bug this catches: pre-#1099 the parent-symlink hardening was ONE
// batch-wide `rulesDirSafe` boolean with a `break`. Kept that way, a symlinked
// `.claude/rules/` would have silently disqualified the BASELINE writes too —
// one target's compromised directory cancelling a wholly unrelated one.
// ---------------------------------------------------------------------------

describe('writeApprovedRules — symlinked target dir disqualifies only that target', () => {
  it('a symlinked .claude/rules/ blocks repo-local while baseline still writes', async () => {
    const baselineRoot = mkdtempSync(join(tmpdir(), 'reconcile-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'reconcile-outside-'));
    try {
      rmSync(join(tmpDir, '.claude', 'rules'), { recursive: true, force: true });
      symlinkSync(outside, join(tmpDir, '.claude', 'rules'), 'dir');

      const result = await writeApprovedRules({
        approved: [{ slug: 'sound', path: '.claude/rules/sound.md', content: soundRuleDoc() }],
        repoRoot: tmpDir,
        baselineRoot,
        targets: ['repo-local', 'baseline'],
      });

      expect(result.errors.some((e) => e.startsWith('path-confinement:'))).toBe(true);
      expect(existsSync(join(outside, 'sound.md'))).toBe(false);
      // …and the unrelated target was NOT cancelled by it.
      expect(result.written).toBe(1);
      expect(existsSync(join(baselineRoot, 'proposals', 'sound.md'))).toBe(true);
    } finally {
      rmSync(baselineRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// G3 cross-agent invariant — `evidence-digest` passes the structural gate.
//
// TV-001 — the bug this catches: `frontmatterRefusalReason` is POSITIVE-KEY-ONLY
// (it asks whether required keys are PRESENT, never whether an unknown key
// appeared). If it ever gained unknown-key rejection, the renderer's
// `evidence-digest: sha256-v1:<hex>` scalar would make EVERY rendered proposal
// unwritable — a total outage of the write path, visible nowhere else. This test
// asserts the invariant from the WRITER's side; the renderer's owner asserts the
// same fact from the other side. Two owners, one invariant, zero shared files.
// ---------------------------------------------------------------------------

describe('writeApprovedRules — a digest-bearing document passes the structural gate (G3)', () => {
  it('writes a rule carrying evidence-digest without refusal', async () => {
    const content = [
      '---',
      'auto-generated: true',
      'alwaysApply: false',
      'description: a benign description',
      'globs:',
      '  - "scripts/lib/x/**"',
      'learning-key: fragile-pattern/x',
      'confidence: 0.8',
      'expires-at: 2099-09-30',
      `evidence-digest: sha256-v1:${'a'.repeat(64)}`,
      '---',
      '',
      '# Auto-generated rule: x',
      '',
    ].join('\n');

    const result = await writeApprovedRules({
      approved: [{ slug: 'digest', path: '.claude/rules/digest.md', content }],
      repoRoot: tmpDir,
    });

    expect(result.errors).toEqual([]);
    expect(result.written).toBe(1);
    expect(readFileSync(join(tmpDir, '.claude', 'rules', 'digest.md'), 'utf8')).toContain('evidence-digest:');
  });
});
