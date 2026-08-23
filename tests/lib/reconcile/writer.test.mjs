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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeApprovedRules } from '../../../scripts/lib/reconcile/writer.mjs';
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
