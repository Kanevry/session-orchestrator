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
  /**
   * Hermetic hostPaths ctx (issue #783) — mirrorNarrative's Session Config
   * read defaults to the REAL host `owner.yaml` when no `hostPaths` is
   * passed. On a host with `paths.vault-dir` set, that override wins over
   * the fixture's `vault-dir:` value, so the resolved vault path silently
   * diverges from the tmp dir these tests create. Every `mirrorNarrative()`
   * call below passes this hermetic ctx so the fixture's `vault-dir:` value
   * is what actually resolves.
   */
  const HERMETIC_HOST_PATHS = { env: {}, ownerConfig: undefined };

  let tmpBase;

  afterEach(() => {
    if (tmpBase && fs.existsSync(tmpBase)) {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
    tmpBase = undefined;
  });

  /**
   * Create a temp repo + sibling vault dir under os.tmpdir() and return the paths.
   *
   * `vaultName` (#832 item 2), when a string, is injected as a `vault-name:`
   * sub-key line inside the `vault-integration:` block VERBATIM (no quoting) —
   * pass an already-YAML-safe value. Omit (undefined) to leave the key absent,
   * matching today's config shape (regression baseline for bb26964).
   */
  function scaffold({ repoDirName, vaultEnabled = true, withStateMd = true, vaultName } = {}) {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'narrative-mirror-'));
    const repoRoot = path.join(tmpBase, repoDirName);
    const vaultDir = path.join(tmpBase, 'vault');
    fs.mkdirSync(path.join(repoRoot, '.claude'), { recursive: true });

    const vaultNameLine = typeof vaultName === 'string' ? `  vault-name: ${vaultName}\n` : '';
    const vaultBlock = vaultEnabled
      ? `vault-integration:\n  enabled: true\n  vault-dir: ${vaultDir}\n  mode: warn\n${vaultNameLine}`
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
    const result = await mirrorNarrative({ repoRoot, hostPaths: HERMETIC_HOST_PATHS });

    expect(result.action).toBe('written');
    expect(result.path).toContain('/01-projects/mycoolrepo/_session-narrative.md');
    expect(result.path).not.toContain('unknown');

    const written = fs.readFileSync(result.path, 'utf8');
    const fm = parseFrontmatter(written);
    expect(fm.repo).toBe('MyCoolRepo');
  });

  it('returns skipped-vault-disabled when vault-integration is absent/disabled', async () => {
    const { repoRoot } = scaffold({ repoDirName: 'NoVault', vaultEnabled: false });
    const result = await mirrorNarrative({ repoRoot, hostPaths: HERMETIC_HOST_PATHS });
    expect(result).toEqual({ action: 'skipped-vault-disabled' });
  });

  it('returns skipped-no-statemd when STATE.md is absent but vault is enabled', async () => {
    const { repoRoot } = scaffold({ repoDirName: 'NoState', withStateMd: false });
    const result = await mirrorNarrative({ repoRoot, hostPaths: HERMETIC_HOST_PATHS });
    expect(result.action).toBe('skipped-no-statemd');
    expect(result.path).toContain('/01-projects/nostate/_session-narrative.md');
  });

  it('returns skipped-vault-disabled when repoRoot is empty', async () => {
    // hostPaths is inert here (the empty-repoRoot guard returns before any
    // config read) but is passed anyway — hostpaths-guard.test.mjs pins
    // EVERY mirrorNarrative call site to carry an explicit hostPaths key,
    // belt-and-suspenders against the #783 incident class.
    const result = await mirrorNarrative({ repoRoot: '', hostPaths: HERMETIC_HOST_PATHS });
    expect(result).toEqual({ action: 'skipped-vault-disabled' });
  });

  it('returns skipped-vault-disabled when repoRoot is missing', async () => {
    const result = await mirrorNarrative({ hostPaths: HERMETIC_HOST_PATHS });
    expect(result).toEqual({ action: 'skipped-vault-disabled' });
  });

  // =========================================================================
  // hostPaths forwarding is load-bearing (issue #783 follow-up)
  //
  // Every mirrorNarrative test above passes HERMETIC_HOST_PATHS ({ env: {},
  // ownerConfig: undefined }) — an EMPTY ctx that happens to equal the CI
  // default. That proves the fix does not leak the real host owner.yaml into
  // a fixture assertion, but it does NOT prove mirrorNarrative actually
  // FORWARDS `hostPaths` to parseSessionConfig: if that forwarding were
  // silently dropped (i.e. mirrorNarrative called `parseSessionConfig(configText)`
  // with no options), every test above would still pass, because falling
  // back to the real (empty-on-CI) host context resolves the SAME committed
  // vault-dir. This test closes that gap with a FAKE, NON-EMPTY hostPaths
  // override that must win over the fixture's committed vault-dir.
  // =========================================================================

  it('LOAD-BEARING (#783 falsification): a fake owner.yaml vault-dir override resolves the narrative path, proving hostPaths is forwarded to parseSessionConfig', async () => {
    const { repoRoot, vaultDir } = scaffold({ repoDirName: 'HostPathsRepo' });
    const repoSlug = 'hostpaths-fake-repo'; // already slug-canonical — subjectToSlug is a no-op on it
    // A FAKE vault-dir injected via ownerConfig.paths — mirrorNarrative has no
    // $HOME guard (unlike mirrorBoard), so this can live anywhere; keep it
    // under tmpBase for tidy cleanup even though dryRun never touches it.
    const fakeVaultDir = path.join(tmpBase, 'fake-owner-injected-mirrorNarrative-vault');

    const result = await mirrorNarrative({
      repoRoot,
      repo: repoSlug,
      dryRun: true,
      hostPaths: { env: {}, ownerConfig: { paths: { 'vault-dir': fakeVaultDir } } },
    });

    // Falsification proof: if mirrorNarrative stopped forwarding `hostPaths`
    // to parseSessionConfig, config would resolve via the REAL host context
    // instead (empty on CI — no SO_VAULT_DIR, no owner.yaml paths.vault-dir),
    // which falls through to the fixture's COMMITTED vault-dir. The resolved
    // path would then equal resolveNarrativePath(vaultDir, repoSlug), NOT
    // resolveNarrativePath(fakeVaultDir, repoSlug) — this assertion would go RED.
    expect(result.action).toBe('dry-run');
    expect(result.path).toBe(resolveNarrativePath(fakeVaultDir, repoSlug));
    expect(result.path).not.toBe(resolveNarrativePath(vaultDir, repoSlug));
  });

  // =========================================================================
  // mirrorNarrative — loose-slug matching against existing 01-projects/
  // folders (issue #829 Finding 3)
  // =========================================================================

  describe('loose-slug matching (#829 Finding 3)', () => {
    it('reuses the EXACT existing folder name when its loose-slug matches the candidate (GotzendorferV2 -> gotzendorfer-v2)', async () => {
      const { repoRoot, vaultDir } = scaffold({ repoDirName: 'gotzendorfer-repo-a' });
      fs.mkdirSync(path.join(vaultDir, '01-projects', 'gotzendorfer-v2'), { recursive: true });

      const result = await mirrorNarrative({
        repoRoot,
        repo: 'GotzendorferV2',
        hostPaths: HERMETIC_HOST_PATHS,
      });

      expect(result.action).toBe('written');
      expect(result.path).toBe(resolveNarrativePath(vaultDir, 'gotzendorfer-v2'));
    });

    it('reuses the EXACT existing folder name for a second real-world drift case (LeadPipeDACH -> leadpipe-dach)', async () => {
      const { repoRoot, vaultDir } = scaffold({ repoDirName: 'leadpipe-repo-a' });
      fs.mkdirSync(path.join(vaultDir, '01-projects', 'leadpipe-dach'), { recursive: true });

      const result = await mirrorNarrative({
        repoRoot,
        repo: 'LeadPipeDACH',
        hostPaths: HERMETIC_HOST_PATHS,
      });

      expect(result.action).toBe('written');
      expect(result.path).toBe(resolveNarrativePath(vaultDir, 'leadpipe-dach'));
    });

    it('falls back to subjectToSlug when the loose match is AMBIGUOUS (two existing folders share the same loose-slug)', async () => {
      const { repoRoot, vaultDir } = scaffold({ repoDirName: 'gotzendorfer-repo-b' });
      // Two DIFFERENT on-disk folder names (hyphen vs underscore) that both
      // loose-slug to 'gotzendorferv2'. Deliberately NOT a pure case variant
      // (e.g. 'Gotzendorfer-V2') — macOS APFS is case-insensitive-preserving,
      // so a second mkdirSync differing only by case silently resolves to the
      // SAME physical directory as the first, which would defeat this test's
      // "two existing folders" precondition.
      fs.mkdirSync(path.join(vaultDir, '01-projects', 'gotzendorfer-v2'), { recursive: true });
      fs.mkdirSync(path.join(vaultDir, '01-projects', 'gotzendorfer_v2'), { recursive: true });

      const result = await mirrorNarrative({
        repoRoot,
        repo: 'GotzendorferV2',
        hostPaths: HERMETIC_HOST_PATHS,
      });

      expect(result.action).toBe('written');
      // Ambiguous -> falls through to the unmodified subjectToSlug candidate,
      // not either of the two colliding on-disk folders.
      expect(result.path).toBe(resolveNarrativePath(vaultDir, 'gotzendorferv2'));
    });

    it('falls back to subjectToSlug when 01-projects/ does not exist yet (first-ever narrative write for this vault)', async () => {
      const { repoRoot, vaultDir } = scaffold({ repoDirName: 'gotzendorfer-repo-c' });
      // Deliberately do NOT create vaultDir/01-projects — mirrors a brand-new vault.
      expect(fs.existsSync(path.join(vaultDir, '01-projects'))).toBe(false);

      const result = await mirrorNarrative({
        repoRoot,
        repo: 'GotzendorferV2',
        hostPaths: HERMETIC_HOST_PATHS,
      });

      expect(result.action).toBe('written');
      expect(result.path).toBe(resolveNarrativePath(vaultDir, 'gotzendorferv2'));
    });

    it('does not loose-match an UNRELATED existing folder (no false positive)', async () => {
      const { repoRoot, vaultDir } = scaffold({ repoDirName: 'gotzendorfer-repo-d' });
      fs.mkdirSync(path.join(vaultDir, '01-projects', 'some-totally-different-repo'), { recursive: true });

      const result = await mirrorNarrative({
        repoRoot,
        repo: 'GotzendorferV2',
        hostPaths: HERMETIC_HOST_PATHS,
      });

      expect(result.action).toBe('written');
      expect(result.path).toBe(resolveNarrativePath(vaultDir, 'gotzendorferv2'));
    });
  });

  // =========================================================================
  // mirrorNarrative — vault-name override honoured (issue #832 item 2)
  //
  // Finding: `vault-integration.vault-name` (#660) already carries the exact
  // semantic issue #832 asked for under a new key — it just wasn't READ here.
  // namespace.mjs already honours it for 40-learnings/ and 50-sessions/; this
  // closes the gap for the narrative mirror. Precedence: explicit `repo` opt >
  // `vault-name` > repoRoot basename.
  // =========================================================================

  describe('vault-name override (#832 item 2)', () => {
    it('FAKE-REGRESSION (mandatory): a drifted-suffix repo directory resolves to the configured vault-name, not the raw basename', async () => {
      // basename(repoRoot) = 'widget-tracker-app' — a TRUE rename (suffix drop),
      // not a case/punctuation variant, so resolveLooseSlug's own loose-match
      // (bb26964) cannot bridge this gap by itself; only the vault-name
      // override can produce 'widget-tracker' here.
      const { repoRoot, vaultDir } = scaffold({
        repoDirName: 'widget-tracker-app',
        vaultName: 'widget-tracker',
      });

      const result = await mirrorNarrative({ repoRoot, hostPaths: HERMETIC_HOST_PATHS });

      expect(result.action).toBe('written');
      expect(result.path).toBe(resolveNarrativePath(vaultDir, 'widget-tracker'));
      expect(result.path).not.toContain('widget-tracker-app');
    });

    it('precedence: an explicit `repo` opt still wins over a configured vault-name', async () => {
      const { repoRoot, vaultDir } = scaffold({
        repoDirName: 'basename-repo',
        vaultName: 'configured-name',
      });

      const result = await mirrorNarrative({
        repoRoot,
        repo: 'explicit-repo',
        hostPaths: HERMETIC_HOST_PATHS,
      });

      expect(result.action).toBe('written');
      expect(result.path).toBe(resolveNarrativePath(vaultDir, 'explicit-repo'));
    });

    it('regression guard (bb26964): absent vault-name leaves basename + loose-match behaviour unchanged', async () => {
      const { repoRoot, vaultDir } = scaffold({ repoDirName: 'gotzendorfer-repo-novault' });
      fs.mkdirSync(path.join(vaultDir, '01-projects', 'gotzendorfer-v2'), { recursive: true });

      const result = await mirrorNarrative({
        repoRoot,
        repo: 'GotzendorferV2',
        hostPaths: HERMETIC_HOST_PATHS,
      });

      expect(result.action).toBe('written');
      expect(result.path).toBe(resolveNarrativePath(vaultDir, 'gotzendorfer-v2'));
    });

    it('treats an empty-string vault-name as unset, falling back to the basename', async () => {
      const { repoRoot, vaultDir } = scaffold({ repoDirName: 'empty-vault-name-repo', vaultName: '' });

      const result = await mirrorNarrative({ repoRoot, hostPaths: HERMETIC_HOST_PATHS });

      expect(result.action).toBe('written');
      expect(result.path).toBe(resolveNarrativePath(vaultDir, 'empty-vault-name-repo'));
    });

    it('treats a whitespace-only quoted vault-name as unset (not as an empty slug), falling back to the basename', async () => {
      // Written by hand (not via scaffold) because this needs a QUOTED value —
      // `vault-name: "   "` — to survive the config parser's own unquoted-value
      // trim (which would otherwise collapse bare whitespace to '' upstream,
      // testing the parser's null-coercion rather than this module's own
      // `.trim()` defense on a genuinely non-null, whitespace-only string).
      tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'narrative-mirror-'));
      const repoRoot = path.join(tmpBase, 'whitespace-vault-name-repo');
      const vaultDir = path.join(tmpBase, 'vault');
      fs.mkdirSync(path.join(repoRoot, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(repoRoot, 'CLAUDE.md'),
        '# Repo\n\n## Session Config\n\nvault-integration:\n' +
          `  enabled: true\n  vault-dir: ${vaultDir}\n  mode: warn\n  vault-name: "   "\n`,
      );
      fs.writeFileSync(
        path.join(repoRoot, '.claude', 'STATE.md'),
        '---\nsession-id: main-x\n---\n\n## Wave History\n\n### Wave 1\n\n- did a thing.\n',
      );

      const result = await mirrorNarrative({ repoRoot, hostPaths: HERMETIC_HOST_PATHS });

      expect(result.action).toBe('written');
      expect(result.path).toBe(resolveNarrativePath(vaultDir, 'whitespace-vault-name-repo'));
    });
  });
});
