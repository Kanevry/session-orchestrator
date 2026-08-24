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
 *                          missing-repoRoot skip outcomes (os.tmpdir temp repos),
 *                          telemetry on the SILENT skip paths (#1129).
 *
 * PORTABLE — no hardcoded home paths. All real-fs work happens under os.tmpdir().
 * Fixtures are INLINE deterministic strings reproducing the real STATE.md shapes.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  GENERATOR_MARKER,
  NARRATIVE_EVENT,
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
    // `realpathSync` on the tmp ROOT keeps this fixture the shape a real vault
    // has: on macOS os.tmpdir() is `/var/folders/…`, a symlink to
    // `/private/var/folders/…`, while a real vault dir is canonical.
    //
    // It USED to be load-bearing for a different reason: mirrorNarrative ran
    // `validatePathInsideProject` without `canonicalizeRoot`, so on a symlinked
    // root every SECOND call returned `skipped-invalid-path` — which meant this
    // line also hid that bug from all 25 call sites below. The guard now
    // canonicalizes (#1033), and the symlinked-vault test further down exercises
    // the non-canonical root directly instead of relying on a fixture to avoid it.
    tmpBase = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'narrative-mirror-'));
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

  // =========================================================================
  // Symlinked vault root (#1033)
  //
  // THE BUG THIS CATCHES, NAMED: the SECOND mirror into a vault reached through
  // a symlink returns `skipped-invalid-path` and never writes again. The guard's
  // realpath phase is skipped while the target file is ABSENT (ENOENT) and fires
  // once it EXISTS, so run 1 passes and run 2 resolves the file to the canonical
  // path, compares it against the LEXICAL root, and rejects it as an escape.
  // Under `mode: warn` that prints a warning and closes the session, so the
  // narrative silently stops updating from the second session onward.
  //
  // WHY THE SUITE MISSED IT — measured at f0766e1, before this test:
  //   grep -c "await mirrorNarrative(" …/narrative-mirror.test.mjs   → 25
  //   grep -n "const run1\|const run2"  …/narrative-mirror.test.mjs   → 4 (2 tests)
  //   grep -n "mkdtempSync"             …/narrative-mirror.test.mjs   → 2 sites
  // Both double-call tests go through `scaffold()`, whose tmp root is
  // `fs.realpathSync(os.tmpdir())` (line ~448) — canonical, so the two paths can
  // never disagree. The one NON-canonical fixture (the quoted-whitespace
  // vault-name test) calls the mirror exactly once. So the gap was not "never
  // called twice"; it was never called twice against a root that is a symlink,
  // which on macOS is what `os.tmpdir()` — and any vault under a symlinked home
  // or a synced folder — actually is.
  // =========================================================================

  it('mirrors TWICE through a SYMLINKED vault path — run 2 is not skipped-invalid-path (#1033)', async () => {
    tmpBase = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'narrative-mirror-symlink-'));
    const realRoot = path.join(tmpBase, 'real');
    const linkRoot = path.join(tmpBase, 'link');
    fs.mkdirSync(realRoot, { recursive: true });
    fs.symlinkSync(realRoot, linkRoot, 'dir');

    // The repo is addressed canonically; only the VAULT is reached through the
    // link, which is the production shape (the vault path comes from config).
    const repoRoot = path.join(realRoot, 'symlinked-vault-repo');
    const vaultDir = path.join(linkRoot, 'vault');
    fs.mkdirSync(path.join(repoRoot, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'CLAUDE.md'),
      '# Repo\n\n## Session Config\n\nvault-integration:\n' +
        `  enabled: true\n  vault-dir: ${vaultDir}\n  mode: warn\n`,
    );
    fs.writeFileSync(
      path.join(repoRoot, '.claude', 'STATE.md'),
      '---\nsession-id: main-symlink-1\n---\n\n## Wave History\n\n### Wave 1\n\n- did a thing.\n',
    );

    // Run 1: the target does not exist yet, so the guard's realpath phase is
    // skipped either way — this run passed even before the fix.
    const run1 = await mirrorNarrative({ repoRoot, hostPaths: HERMETIC_HOST_PATHS });
    expect(run1.action).toBe('written');

    // Run 2: same unchanged STATE.md, but the file now EXISTS. Without
    // `canonicalizeRoot: true` this returned `skipped-invalid-path`.
    const run2 = await mirrorNarrative({ repoRoot, hostPaths: HERMETIC_HOST_PATHS });
    expect(run2.action).toBe('skipped-noop');

    // The write really landed under the symlink's target, not beside it.
    expect(fs.existsSync(path.join(realRoot, 'vault', '01-projects', 'symlinked-vault-repo', '_session-narrative.md'))).toBe(true);
  });

  // =========================================================================
  // Secret masking (#1025) — the mirrored file is TRACKED AND PUSHED in the
  // operator's vault repo, so a leaked credential there is not deletable
  // without a history rewrite in a foreign repo.
  //
  // THE BUG THIS CATCHES, NAMED: a secret quoted in STATE.md prose reaching
  // `_session-narrative.md` verbatim. The mission-status half is the sharper
  // half — `missionStatus` is an ARRAY OF OBJECTS, not a string, so a
  // field-by-field masker over the three string keys (waveHistory /
  // deviations / whatNotToRetry) would publish the `task:` description
  // untouched while every string-field assertion still passed green. Both
  // sites are asserted with their full rendered line, not a bare file-wide
  // substring, so each one bites on its own.
  // =========================================================================

  describe('secret masking (#1025)', () => {
    const NEEDLE_KEY = 'SO_TEST_NARRATIVE_TOKEN'; // matches SECRET_KEY_RE via the `_TOKEN` suffix
    const NEEDLE = 'narrative-needle-b7f31c9d4e0a'; // synthetic; >= MIN_MASKABLE_LENGTH (8)

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('masks an env-derived secret in BOTH a Deviations bullet AND a mission-status task', async () => {
      vi.stubEnv(NEEDLE_KEY, NEEDLE);
      const { repoRoot } = scaffold({ repoDirName: 'secret-narrative-repo' });

      // The needle sits in TWO structurally different places: free-text body
      // prose, and a frontmatter `mission-status` entry field that is parsed
      // into an object before it is rendered into the rollup table.
      fs.writeFileSync(
        path.join(repoRoot, '.claude', 'STATE.md'),
        [
          '---',
          'session-id: main-secret-1',
          'mission-status:',
          '  - id: m-1',
          `    task: Rotate ${NEEDLE} before the next deploy`,
          '    wave: W1',
          '    status: completed',
          '---',
          '',
          '## Deviations',
          '',
          `- Pasted ${NEEDLE} into the run log by mistake.`,
          '',
        ].join('\n'),
      );

      const result = await mirrorNarrative({ repoRoot, hostPaths: HERMETIC_HOST_PATHS });
      expect(result.action).toBe('written');

      const written = fs.readFileSync(result.path, 'utf8');

      // Site 1 — body prose.
      expect(written).toContain('- Pasted [REDACTED] into the run log by mistake.');
      // Site 2 — the mission-status rollup row (the field-by-field blind spot).
      expect(written).toContain('| m-1 | Rotate [REDACTED] before the next deploy | W1 | completed |');
      // Whole-file absence: correct scope here — the ENTIRE file is published.
      expect(written).not.toContain(NEEDLE);
    });

    // BUG CAUGHT (#1025, HIGH): the run that was supposed to be a NO-OP publishes
    // the raw secret. `writeNarrative`'s skip-noop was a plain byte compare, but
    // the needle set comes from `process.env` — which is NOT part of STATE.md — so
    // run 1 (env set) writes `[REDACTED]` and run 2 (env absent) renders the RAW
    // value from the SAME unchanged source. The bytes differ, so the byte compare
    // says "changed" and writes the plaintext into a file that is tracked and
    // pushed in the operator's vault repo, where there is no `.husky/` and no
    // active git hook to catch it — removable only by a history rewrite in a
    // foreign repo. Reproduced exactly this way before the fix:
    //   RUN1 env set    -> written      [REDACTED]=true  raw=false
    //   RUN2 env absent -> written      [REDACTED]=false raw=TRUE
    // The on-disk file compared in run 2 is a golden record: produced by run 1
    // through the real renderer, never hand-shaped to match what the reader wants.
    it('a second run WITHOUT the needle in env is skipped-noop and never re-publishes the raw value', async () => {
      const { repoRoot } = scaffold({ repoDirName: 'secret-narrative-idempotency-repo' });
      fs.writeFileSync(
        path.join(repoRoot, '.claude', 'STATE.md'),
        [
          '---',
          'session-id: main-secret-2',
          'mission-status:',
          '  - id: m-1',
          `    task: Rotate ${NEEDLE} before the next deploy`,
          '    wave: W1',
          '    status: completed',
          '---',
          '',
          '## Deviations',
          '',
          `- Pasted ${NEEDLE} into the run log by mistake.`,
          '',
        ].join('\n'),
      );

      // ── RUN 1: needle in env → the file is written MASKED. ──────────────────
      vi.stubEnv(NEEDLE_KEY, NEEDLE);
      const run1 = await mirrorNarrative({ repoRoot, hostPaths: HERMETIC_HOST_PATHS });
      expect(run1.action).toBe('written');
      expect(fs.readFileSync(run1.path, 'utf8')).toContain('[REDACTED]');

      // ── RUN 2: STATE.md untouched, needle NO LONGER in env → the freshly
      //    rendered candidate carries the RAW value. Nothing about the source
      //    changed, so the only correct outcome is a no-op. ────────────────────
      vi.unstubAllEnvs();
      const run2 = await mirrorNarrative({ repoRoot, hostPaths: HERMETIC_HOST_PATHS });

      expect(run2.action).toBe('skipped-noop');
      const after = fs.readFileSync(run2.path, 'utf8');
      expect(after).not.toContain(NEEDLE);
      expect(after).toContain('- Pasted [REDACTED] into the run log by mistake.');
      expect(after).toContain('| m-1 | Rotate [REDACTED] before the next deploy | W1 | completed |');
    });

    // The compensation must not swallow a REAL edit: with the env unchanged
    // between runs, a genuine STATE.md change outside any redacted span still
    // writes. Without this the fix would be indistinguishable from "never write
    // again", which passes the test above for the wrong reason.
    it('still writes when the source genuinely changes outside the redacted span', async () => {
      const { repoRoot } = scaffold({ repoDirName: 'secret-narrative-realedit-repo' });
      const stateMdPath = path.join(repoRoot, '.claude', 'STATE.md');
      const stateMd = (deviation) =>
        ['---', 'session-id: main-secret-3', '---', '', '## Deviations', '', deviation, ''].join('\n');

      vi.stubEnv(NEEDLE_KEY, NEEDLE);
      fs.writeFileSync(stateMdPath, stateMd(`- Pasted ${NEEDLE} once.`));
      const run1 = await mirrorNarrative({ repoRoot, hostPaths: HERMETIC_HOST_PATHS });
      expect(run1.action).toBe('written');

      fs.writeFileSync(stateMdPath, stateMd(`- Pasted ${NEEDLE} once, and then rotated it.`));
      const run2 = await mirrorNarrative({ repoRoot, hostPaths: HERMETIC_HOST_PATHS });

      expect(run2.action).toBe('written');
      expect(fs.readFileSync(run2.path, 'utf8')).toContain('- Pasted [REDACTED] once, and then rotated it.');
    });
  });

  // =========================================================================
  // Telemetry (#1129)
  //
  // THE BUG THIS CATCHES, NAMED: the mirror's REJECTION and NO-OP paths return
  // silently, so an outage of the writer is indistinguishable from a healthy
  // skip. Its only production caller is shell prose in
  // `skills/session-end/session-metrics-write.md`, which under `mode: warn`
  // prints a WARNING and closes the session anyway — nothing durable is left
  // behind. Measured 2026-08-23: 0 board/mirror events in 28 387 ledger records.
  //
  // Each case reads the ledger under the TMP repoRoot, which doubles as the
  // `opts.repoRoot`-forwarding falsification (#941): drop the forwarding and
  // the record lands in whatever repo the process sits in, the tmp ledger never
  // appears, and these go red rather than silently polluting fleet telemetry.
  // =========================================================================

  describe('telemetry (#1129)', () => {
    /**
     * Read every ledger record written under `repoRoot`. Returns [] when the
     * ledger was never created — the exact shape the pre-#1129 module produced.
     */
    function readLedger(repoRoot) {
      const ledger = path.join(repoRoot, '.orchestrator', 'metrics', 'events.jsonl');
      if (!fs.existsSync(ledger)) return [];
      return fs
        .readFileSync(ledger, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
    }

    it('the emitted payload carries NO filesystem path — only a basename (security review W5-R1)', async () => {
      // The named bug: the event carried the FULL output path. On a real host that
      // reads `/Users/<name>/Projects/<vault>/01-projects/<private-slug>/…` — an OS
      // username plus a private project slug, i.e. the two shapes
      // check-owner-leakage blocks as CP1 and CP6. That scanner cannot reach this
      // one: it walks `git ls-files`, and `.orchestrator/metrics/*.jsonl` is
      // gitignored. So the record is invisible to the pre-commit guard and visible
      // to the optional Clank webhook, which posts the payload verbatim.
      //
      // Asserting on the RETURN value instead would pass while the event leaked:
      // the return contract deliberately still carries the absolute path.
      const { repoRoot } = scaffold({ repoDirName: 'telemetry-nopath-repo', withStateMd: false });
      await mirrorNarrative({ repoRoot, hostPaths: HERMETIC_HOST_PATHS });

      const records = readLedger(repoRoot);
      expect(records).toHaveLength(1);
      const record = records[0];

      // Positive: the diagnostic value — WHICH writer ran — is still there.
      expect(record.path_tail).toBe('_session-narrative.md');
      // Negative: the old field is gone, not merely emptied.
      expect(record).not.toHaveProperty('path');
      // And nothing anywhere in the serialised record looks like a filesystem path.
      // A substring test over the whole line, not over one field, because the leak
      // class is "some field carries it", not "this field carries it".
      const serialised = JSON.stringify(record);
      expect(serialised).not.toContain(os.homedir());
      expect(serialised).not.toContain(path.sep + 'Users' + path.sep);
      expect(serialised).not.toContain(repoRoot);
    });

    it('emits ONE event on the SILENT skipped-no-statemd path, with chars ABSENT (never 0)', async () => {
      const { repoRoot } = scaffold({ repoDirName: 'telemetry-nostate-repo', withStateMd: false });

      const result = await mirrorNarrative({ repoRoot, hostPaths: HERMETIC_HOST_PATHS });
      expect(result.action).toBe('skipped-no-statemd');

      const events = readLedger(repoRoot).filter((e) => e.event === NARRATIVE_EVENT);
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('skipped-no-statemd');
      // path_tail, not path: the event carries the BASENAME only. The full path
      // stays in the RETURN value (asserted elsewhere) — it must not travel in a
      // payload that also goes over the Clank webhook. This assertion used to
      // read `events[0].path).toBe(result.path)`, i.e. it PINNED the leak.
      expect(events[0].path_tail).toBe(path.basename(result.path));
      expect(events[0]).not.toHaveProperty('path');
      // ABSENT IS NOT ZERO: nothing was rendered on this path, so the key is
      // missing. A `chars: 0` here would be indistinguishable from a narrative
      // that genuinely rendered empty.
      expect(Object.prototype.hasOwnProperty.call(events[0], 'chars')).toBe(false);
    });

    it('emits action=written with chars = the length of the document actually on disk', async () => {
      const { repoRoot } = scaffold({ repoDirName: 'telemetry-written-repo' });

      const result = await mirrorNarrative({ repoRoot, hostPaths: HERMETIC_HOST_PATHS });
      expect(result.action).toBe('written');

      const events = readLedger(repoRoot).filter((e) => e.event === NARRATIVE_EVENT);
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('written');
      // path_tail, not path: the event carries the BASENAME only. The full path
      // stays in the RETURN value (asserted elsewhere) — it must not travel in a
      // payload that also goes over the Clank webhook. This assertion used to
      // read `events[0].path).toBe(result.path)`, i.e. it PINNED the leak.
      expect(events[0].path_tail).toBe(path.basename(result.path));
      expect(events[0]).not.toHaveProperty('path');
      // Independent oracle: the file on disk, not a re-derivation of the
      // renderer's own arithmetic.
      expect(events[0].chars).toBe(fs.readFileSync(result.path, 'utf8').length);
    });

    it('a BROKEN ledger never breaks the mirror — the narrative is still written', async () => {
      const { repoRoot } = scaffold({ repoDirName: 'telemetry-broken-ledger-repo' });
      // `.orchestrator` as a regular FILE makes emitEvent's own
      // `mkdir -p .orchestrator/metrics` fail with ENOTDIR — uniformly, for
      // every uid including root (`.claude/rules/testing.md` § root-as-uid-0).
      // Real failure injection through the real dependency: no module mock, so
      // this exercises the production emit path rather than a double of it.
      fs.writeFileSync(path.join(repoRoot, '.orchestrator'), 'not a directory');

      // Without the best-effort catch around the emit, this call REJECTS and
      // the narrative — already written to the vault by then — is reported as
      // a failure to the caller.
      const result = await mirrorNarrative({ repoRoot, hostPaths: HERMETIC_HOST_PATHS });

      expect(result.action).toBe('written');
      expect(fs.readFileSync(result.path, 'utf8')).toContain(
        '# telemetry-broken-ledger-repo — Session Narrative',
      );
      expect(readLedger(repoRoot)).toEqual([]);
    });
  });
});
