/**
 * Tests for scripts/lib/vault-status/narrative-mirror.mjs (Epic #673 #675).
 *
 * Coverage:
 *   - extractNarrative   — raw verbatim section extraction (top-level + nested forms),
 *                          level-2 boundary stop, empty deviations, plain-bullet
 *                          What-Not-To-Retry, mission-status present/absent, garbage input.
 *   - renderNarrative    — frontmatter ordering (_generator LAST), placeholder vs rollup.
 *   - writeNarrative     — idempotency guards + _overview.md safety refusal (injectable fs).
 *   - mirrorNarrative    — repo-derivation regression (#675), vault-disabled / no-STATE.md /
 *                          missing-repoRoot skip outcomes (os.tmpdir temp repos).
 *
 * PORTABLE — no hardcoded home paths. All real-fs work happens under os.tmpdir().
 * Fixtures are INLINE deterministic strings reproducing the real STATE.md shapes.
 */

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  GENERATOR_MARKER,
  extractNarrative,
  renderNarrative,
  resolveNarrativePath,
  writeNarrative,
  mirrorNarrative,
} from '../../../scripts/lib/vault-status/narrative-mirror.mjs';
import { parseFrontmatter } from '../../../scripts/lib/vault-mirror/utils.mjs';

// ── Inline deterministic fixtures ──────────────────────────────────────────────

/**
 * TOP-LEVEL form (this repo's STATE.md shape). `## Wave History` is immediately
 * followed by `## Mission Status` so we can assert the extractor STOPS at the
 * level-2 boundary and does not bleed into the next section.
 */
const TOP_LEVEL_STATE_MD = `---
session-id: main-2026-06-18-1646
mission-status:
  - id: m-1
    task: Build narrative mirror
    wave: W1
    status: completed
  - id: m-2
    task: Add tests
    wave: W2
    status: in-dev
---

## Current Wave

Wave 2 in progress.

## Wave History

### Wave 1 — Discovery

- Explored STATE.md shapes.

### Wave 2 — Implementation

- Wrote narrative-mirror.mjs.

## Mission Status

DO_NOT_BLEED_INTO_WAVE_HISTORY sentinel line.

## Deviations

- [2026-06-18T16:46:00Z] Switched from structured parser to raw extraction.

## What Not To Retry

- **Structured readWhatNotToRetry** (main, 2026-06-18) — why: format drift returns [].
`;

/**
 * NESTED form (FeedFoundryV2 shape). `### Wave History (…)` lives under a
 * `## Previous Session` heading with `#### Wave N` sub-headings; `## Deviations`
 * is EMPTY (heading then blank); `## What Not To Retry` uses a PLAIN bullet (the
 * form the structured parser fails on); NO `mission-status:` frontmatter key.
 */
const NESTED_STATE_MD = `---
session-id: main-2026-06-18-0900
updated: 2026-06-18
---

## Previous Session

### Wave History (main-2026-06-18-0900, completed)

#### Wave 5 — Ship narrative

- Mirrored STATE.md into vault.

#### Wave 6 — Cleanup

- Pruned worktrees.

## Deviations

## What Not To Retry

- Re-running the structured parser on plain bullets (main, 2026-06-18) — why: silently returns empty.
`;

// ── extractNarrative (pure — the core) ─────────────────────────────────────────

describe('extractNarrative — top-level form', () => {
  it('captures the ### Wave N entries verbatim', () => {
    const { waveHistory } = extractNarrative(TOP_LEVEL_STATE_MD);
    expect(waveHistory).toBe(
      '### Wave 1 — Discovery\n\n- Explored STATE.md shapes.\n\n' +
        '### Wave 2 — Implementation\n\n- Wrote narrative-mirror.mjs.',
    );
  });

  it('STOPS at the next level-2 heading and does not bleed into Mission Status', () => {
    const { waveHistory } = extractNarrative(TOP_LEVEL_STATE_MD);
    expect(waveHistory).not.toContain('DO_NOT_BLEED_INTO_WAVE_HISTORY');
    expect(waveHistory).not.toContain('## Mission Status');
  });

  it('captures the populated deviations block verbatim', () => {
    const { deviations } = extractNarrative(TOP_LEVEL_STATE_MD);
    expect(deviations).toBe(
      '- [2026-06-18T16:46:00Z] Switched from structured parser to raw extraction.',
    );
  });

  it('parses the mission-status frontmatter block into an array', () => {
    const { missionStatus } = extractNarrative(TOP_LEVEL_STATE_MD);
    expect(missionStatus).toHaveLength(2);
    expect(missionStatus[0]).toEqual({
      id: 'm-1',
      task: 'Build narrative mirror',
      wave: 'W1',
      status: 'completed',
    });
  });
});

describe('extractNarrative — nested (FeedFoundryV2) form', () => {
  it('captures the nested Wave History block including its #### sub-headings', () => {
    const { waveHistory } = extractNarrative(NESTED_STATE_MD);
    expect(waveHistory).toBe(
      '#### Wave 5 — Ship narrative\n\n- Mirrored STATE.md into vault.\n\n' +
        '#### Wave 6 — Cleanup\n\n- Pruned worktrees.',
    );
  });

  it('stops the nested block at the next same-or-higher (##) heading', () => {
    const { waveHistory } = extractNarrative(NESTED_STATE_MD);
    expect(waveHistory).not.toContain('## Deviations');
    expect(waveHistory).not.toContain('Pruned worktrees.\n\n##');
  });

  it('returns empty string for an EMPTY deviations section', () => {
    const { deviations } = extractNarrative(NESTED_STATE_MD);
    expect(deviations).toBe('');
  });

  it('captures the PLAIN-bullet What Not To Retry verbatim (structured parser would miss it)', () => {
    const { whatNotToRetry } = extractNarrative(NESTED_STATE_MD);
    expect(whatNotToRetry).toBe(
      '- Re-running the structured parser on plain bullets (main, 2026-06-18) — why: silently returns empty.',
    );
  });

  it('returns null missionStatus when the frontmatter key is absent (no throw)', () => {
    const { missionStatus } = extractNarrative(NESTED_STATE_MD);
    expect(missionStatus).toBe(null);
  });
});

describe('extractNarrative — empty / garbage input', () => {
  it('returns all-empty sections and null missionStatus for empty string', () => {
    expect(extractNarrative('')).toEqual({
      waveHistory: '',
      deviations: '',
      whatNotToRetry: '',
      missionStatus: null,
    });
  });

  it('returns all-empty sections and null missionStatus for headingless garbage', () => {
    expect(extractNarrative('just some prose with no headings at all')).toEqual({
      waveHistory: '',
      deviations: '',
      whatNotToRetry: '',
      missionStatus: null,
    });
  });

  it('does not throw on non-string input and treats it as empty', () => {
    expect(extractNarrative(undefined)).toEqual({
      waveHistory: '',
      deviations: '',
      whatNotToRetry: '',
      missionStatus: null,
    });
  });
});

// ── renderNarrative (pure) ─────────────────────────────────────────────────────

describe('renderNarrative — frontmatter', () => {
  const narrative = {
    waveHistory: '### Wave 1\n\n- did stuff',
    deviations: '- [ts] note',
    whatNotToRetry: '- bad idea',
    missionStatus: null,
  };

  it('emits _generator as the LAST frontmatter line with the marker value', () => {
    const md = renderNarrative({
      repo: 'session-orchestrator',
      narrative,
      now: new Date('2026-06-18T12:00:00Z'),
    });
    const fmBlock = md.split('\n---\n', 1)[0]; // everything before the closing fence
    const fmLines = fmBlock.split('\n').filter((l) => l !== '---' && l.trim() !== '');
    expect(fmLines[fmLines.length - 1]).toBe(`_generator: ${GENERATOR_MARKER}`);
  });

  it('sets type: session and carries the passed repo with a double-quoted title', () => {
    const md = renderNarrative({
      repo: 'session-orchestrator',
      narrative,
      now: new Date('2026-06-18T12:00:00Z'),
    });
    expect(md).toContain('\ntype: session\n');
    expect(md).toContain('\nrepo: session-orchestrator\n');
    expect(md).toContain('\ntitle: "session-orchestrator — Session Narrative"\n');
  });

  it('derives created/updated as YYYY-MM-DD dates from the ISO inputs', () => {
    const md = renderNarrative({
      repo: 'r',
      narrative,
      now: new Date('2026-06-18T12:00:00Z'),
      createdIso: '2026-06-10T08:00:00Z',
    });
    expect(md).toContain('\ncreated: 2026-06-10\n');
    expect(md).toContain('\nupdated: 2026-06-18\n');
  });
});

describe('renderNarrative — body', () => {
  it('renders the verbatim section blocks under their headings', () => {
    const md = renderNarrative({
      repo: 'r',
      narrative: {
        waveHistory: '### Wave 1\n\n- did stuff',
        deviations: '- [ts] note',
        whatNotToRetry: '- bad idea',
        missionStatus: null,
      },
      now: new Date('2026-06-18T00:00:00Z'),
    });
    expect(md).toContain('## Wave History\n\n### Wave 1\n\n- did stuff\n');
    expect(md).toContain('## Deviations\n\n- [ts] note\n');
    expect(md).toContain('## What Not To Retry\n\n- bad idea\n');
  });

  it('renders a clear placeholder when missionStatus is null', () => {
    const md = renderNarrative({
      repo: 'r',
      narrative: { waveHistory: '', deviations: '', whatNotToRetry: '', missionStatus: null },
      now: new Date('2026-06-18T00:00:00Z'),
    });
    expect(md).toMatch(/## Mission Status\n\n_\(no mission-status rollup recorded\)_/);
  });

  it('renders a rollup table row per mission-status entry, pipe-escaping task text', () => {
    const md = renderNarrative({
      repo: 'r',
      narrative: {
        waveHistory: '',
        deviations: '',
        whatNotToRetry: '',
        missionStatus: [{ id: 'm-1', task: 'Build|pipe', wave: 'W1', status: 'completed' }],
      },
      now: new Date('2026-06-18T00:00:00Z'),
    });
    expect(md).toContain('| ID | Task | Wave | Status |');
    expect(md).toContain('| m-1 | Build\\|pipe | W1 | completed |');
  });
});

// ── writeNarrative (idempotent) — injectable fs ────────────────────────────────

/**
 * Build an in-memory fs double for writeNarrative. Tracks writes so we can
 * assert that guard paths never touch the filesystem.
 */
function makeFsDouble(existing = {}) {
  const store = { ...existing };
  const writes = [];
  return {
    writes,
    store,
    fs: {
      existsSync: (p) => Object.prototype.hasOwnProperty.call(store, p),
      readFileSync: (p) => {
        if (!Object.prototype.hasOwnProperty.call(store, p)) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return store[p];
      },
      writeFileSync: (p, c) => {
        store[p] = c;
        writes.push(p);
      },
      mkdirSync: () => {},
    },
  };
}

const NARRATIVE_OUTPUT = '/tmp/vault/01-projects/r/_session-narrative.md';

function freshContent() {
  return renderNarrative({
    repo: 'r',
    narrative: { waveHistory: 'wh', deviations: 'dv', whatNotToRetry: 'wn', missionStatus: null },
    now: new Date('2026-06-18T00:00:00Z'),
  });
}

describe('writeNarrative — idempotency guards', () => {
  it('writes a fresh file when the target does not exist', () => {
    const dbl = makeFsDouble();
    const content = freshContent();
    const result = writeNarrative({ outputPath: NARRATIVE_OUTPUT, content, fs: dbl.fs });
    expect(result).toEqual({ action: 'written', path: NARRATIVE_OUTPUT });
    expect(dbl.store[NARRATIVE_OUTPUT]).toBe(content);
  });

  it('skips an existing hand-authored file that has NO _generator marker', () => {
    const dbl = makeFsDouble({ [NARRATIVE_OUTPUT]: '---\ntitle: hand-written\n---\n\nbody' });
    const result = writeNarrative({ outputPath: NARRATIVE_OUTPUT, content: freshContent(), fs: dbl.fs });
    expect(result).toEqual({ action: 'skipped-handwritten', path: NARRATIVE_OUTPUT });
    expect(dbl.writes).toHaveLength(0);
  });

  it('skips an existing file owned by a FOREIGN _generator marker', () => {
    const dbl = makeFsDouble({
      [NARRATIVE_OUTPUT]: '---\n_generator: some-other-generator@9\n---\n\nbody',
    });
    const result = writeNarrative({ outputPath: NARRATIVE_OUTPUT, content: freshContent(), fs: dbl.fs });
    expect(result).toEqual({ action: 'skipped-handwritten', path: NARRATIVE_OUTPUT });
    expect(dbl.writes).toHaveLength(0);
  });

  it('skips a no-op write when content is identical modulo the updated: timestamp', () => {
    const content = freshContent();
    const stale = content.replace(/^updated: .*$/m, 'updated: 1999-01-01');
    const dbl = makeFsDouble({ [NARRATIVE_OUTPUT]: stale });
    const result = writeNarrative({ outputPath: NARRATIVE_OUTPUT, content, fs: dbl.fs });
    expect(result).toEqual({ action: 'skipped-noop', path: NARRATIVE_OUTPUT });
    expect(dbl.writes).toHaveLength(0);
  });

  it('rewrites a generator-owned file whose body content actually changed', () => {
    const dbl = makeFsDouble({
      [NARRATIVE_OUTPUT]: '---\n_generator: ' + GENERATOR_MARKER + '\nupdated: 2020-01-01\n---\n\nOLD BODY',
    });
    const result = writeNarrative({ outputPath: NARRATIVE_OUTPUT, content: freshContent(), fs: dbl.fs });
    expect(result).toEqual({ action: 'written', path: NARRATIVE_OUTPUT });
    expect(dbl.writes).toEqual([NARRATIVE_OUTPUT]);
  });

  it('never writes on dry-run', () => {
    const dbl = makeFsDouble();
    const result = writeNarrative({
      outputPath: NARRATIVE_OUTPUT,
      content: freshContent(),
      dryRun: true,
      fs: dbl.fs,
    });
    expect(result).toEqual({ action: 'dry-run', path: NARRATIVE_OUTPUT });
    expect(dbl.writes).toHaveLength(0);
  });

  it('REFUSES to clobber a hand-authored _overview.md (Epic #673 #1 risk), never writes', () => {
    const overviewPath = '/tmp/vault/01-projects/r/_overview.md';
    const dbl = makeFsDouble();
    const result = writeNarrative({ outputPath: overviewPath, content: freshContent(), fs: dbl.fs });
    expect(result).toEqual({ action: 'skipped-handwritten', path: overviewPath });
    expect(dbl.writes).toHaveLength(0);
  });
});

// ── resolveNarrativePath (pure) ────────────────────────────────────────────────

describe('resolveNarrativePath', () => {
  it('builds <vaultDir>/01-projects/<repoSlug>/_session-narrative.md', () => {
    expect(resolveNarrativePath('/tmp/vault', 'my-repo')).toBe(
      '/tmp/vault/01-projects/my-repo/_session-narrative.md',
    );
  });
});

// ── mirrorNarrative (orchestration) — os.tmpdir temp repos ─────────────────────

describe('mirrorNarrative', () => {
  let tmpBase;

  afterEach(() => {
    if (tmpBase && fs.existsSync(tmpBase)) {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
    tmpBase = undefined;
  });

  /** Create a temp repo + sibling vault dir under os.tmpdir() and return the paths. */
  function scaffold({ repoDirName, vaultEnabled = true, withStateMd = true } = {}) {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'narrative-mirror-'));
    const repoRoot = path.join(tmpBase, repoDirName);
    const vaultDir = path.join(tmpBase, 'vault');
    fs.mkdirSync(path.join(repoRoot, '.claude'), { recursive: true });

    const vaultBlock = vaultEnabled
      ? `vault-integration:\n  enabled: true\n  vault-dir: ${vaultDir}\n  mode: warn\n`
      : 'persistence: true\n';
    fs.writeFileSync(path.join(repoRoot, 'CLAUDE.md'), `# Repo\n\n## Session Config\n\n${vaultBlock}`);

    if (withStateMd) {
      fs.writeFileSync(
        path.join(repoRoot, '.claude', 'STATE.md'),
        '---\nsession-id: main-x\n---\n\n## Wave History\n\n### Wave 1\n\n- did a thing.\n',
      );
    }
    return { repoRoot, vaultDir };
  }

  it('derives repo from repoRoot basename when repo is OMITTED — never mis-files under "unknown" (#675)', async () => {
    const { repoRoot } = scaffold({ repoDirName: 'MyCoolRepo' });
    const result = await mirrorNarrative({ repoRoot });

    expect(result.action).toBe('written');
    expect(result.path).toContain('/01-projects/mycoolrepo/_session-narrative.md');
    expect(result.path).not.toContain('unknown');

    const written = fs.readFileSync(result.path, 'utf8');
    const fm = parseFrontmatter(written);
    expect(fm.repo).toBe('MyCoolRepo');
  });

  it('returns skipped-vault-disabled when vault-integration is absent/disabled', async () => {
    const { repoRoot } = scaffold({ repoDirName: 'NoVault', vaultEnabled: false });
    const result = await mirrorNarrative({ repoRoot });
    expect(result).toEqual({ action: 'skipped-vault-disabled' });
  });

  it('returns skipped-no-statemd when STATE.md is absent but vault is enabled', async () => {
    const { repoRoot } = scaffold({ repoDirName: 'NoState', withStateMd: false });
    const result = await mirrorNarrative({ repoRoot });
    expect(result.action).toBe('skipped-no-statemd');
    expect(result.path).toContain('/01-projects/nostate/_session-narrative.md');
  });

  it('returns skipped-vault-disabled when repoRoot is empty', async () => {
    const result = await mirrorNarrative({ repoRoot: '' });
    expect(result).toEqual({ action: 'skipped-vault-disabled' });
  });

  it('returns skipped-vault-disabled when repoRoot is missing', async () => {
    const result = await mirrorNarrative({});
    expect(result).toEqual({ action: 'skipped-vault-disabled' });
  });
});
