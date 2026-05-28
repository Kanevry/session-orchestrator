/**
 * learning-memory-modernization.test.mjs — Cross-lane integration tests for
 * the PRD 2026-05-21 learning-memory-modernization wave.
 *
 * These tests stitch together two or more lane outputs end-to-end:
 *
 *   #18  I5 (migrate-cold-start-seed) → I2 (detectColdStart marker cycle):
 *        seed a tmpdir via `migrate-cold-start-seed.mjs --apply --repos <tmpdir>`
 *        → call detectColdStart() on the tmpdir → markerPath returned →
 *        consumeMarker() deletes it → second detectColdStart no longer sees it.
 *
 *   #19  I6 (vault-mirror-quality parser) → I4 (vault-mirror CLI):
 *        write a CLAUDE.md fragment with
 *        `vault-mirror.quality.min-confidence: 0.8` → parseSessionConfig() →
 *        invoke vault-mirror.mjs with --quality-min-confidence 0.8 →
 *        confidence=0.7 entry is skipped-quality-low.
 *
 *   #20  I6 (cold-start parser) → I2 (detectColdStart) enabled gate:
 *        write `cold-start.enabled: false` in test CLAUDE.md →
 *        _parseColdStart returns enabled=false → wire into detectColdStart →
 *        returns shouldEmit: false with reason 'disabled'.
 *
 *   Additional integration scenarios:
 *
 *   #21  Migrate-vault-paths fixes a CLAUDE.md → parseSessionConfig still reads
 *        the same vault-mirror block correctly post-migration.
 *
 *   #22  vault-mirror-quality default (block absent) → parseSessionConfig wires
 *        defaults through to vault-mirror's quality args (parser ↔ consumer
 *        contract).
 *
 * All filesystem ops happen in os.tmpdir()-rooted directories.
 * No real ~/Projects paths are touched.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectColdStart, consumeMarker, MS_PER_HOUR } from '@lib/cold-start-detector.mjs';
import { _parseColdStart } from '@lib/config/cold-start.mjs';
import { parseSessionConfig } from '@lib/config.mjs';
import { collectProposals } from '@lib/memory-proposals/collector.mjs';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VAULT_MIRROR_SCRIPT = join(REPO_ROOT, 'scripts', 'vault-mirror.mjs');
const MIGRATE_COLD_START_SCRIPT = join(REPO_ROOT, 'scripts', 'migrate-cold-start-seed.mjs');
const MIGRATE_VAULT_PATHS_SCRIPT = join(REPO_ROOT, 'scripts', 'migrate-vault-paths.mjs');

const TMP_REAL = realpathSync(tmpdir());

// ---------------------------------------------------------------------------
// Cleanup tracking
// ---------------------------------------------------------------------------

const cleanups = [];

function mkTmp(prefix) {
  const t = mkdtempSync(join(TMP_REAL, prefix));
  cleanups.push(t);
  return t;
}

afterEach(() => {
  for (const d of cleanups.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// #18 — I5 → I2 cold-start marker cycle
// ---------------------------------------------------------------------------

describe('#18 — migrate-cold-start-seed → detectColdStart marker cycle', () => {
  it('seeds marker, detectColdStart finds it, consumeMarker deletes it', async () => {
    const repo = mkTmp('cs-cycle-');

    // Set up bootstrap.lock with timestamp 2h ago (older than default 1h nudge threshold)
    const NOW = Date.parse('2026-05-21T12:00:00Z');
    const HOURS_AGO_2 = new Date(NOW - 2 * MS_PER_HOUR).toISOString();
    mkdirSync(join(repo, '.orchestrator', 'metrics'), { recursive: true });
    writeFileSync(
      join(repo, '.orchestrator', 'bootstrap.lock'),
      `bootstrapped-at: ${HOURS_AGO_2}\n`,
      'utf8'
    );
    // Empty sessions.jsonl so the "no sessions yet" path is taken
    writeFileSync(join(repo, '.orchestrator', 'metrics', 'sessions.jsonl'), '', 'utf8');

    // STEP 1 — Seed the marker via I5
    const seedResult = spawnSync(
      process.execPath,
      [MIGRATE_COLD_START_SCRIPT, '--apply', '--repos', repo],
      { encoding: 'utf8', timeout: 10_000 }
    );
    expect(seedResult.status).toBe(0);

    const markerPath = join(repo, '.orchestrator', 'welcome-banner-pending');
    expect(existsSync(markerPath)).toBe(true);

    // STEP 2 — Call detectColdStart; it should emit and return markerPath
    const detection = await detectColdStart({
      repoRoot: repo,
      now: NOW,
    });
    expect(detection.shouldEmit).toBe(true);
    expect(detection.markerPath).toBe(markerPath);
    expect(detection.reason).toBe('migration-marker-present');

    // STEP 3 — consumeMarker() deletes it
    const deleted = await consumeMarker(detection.markerPath);
    expect(deleted).toBe(true);
    expect(existsSync(markerPath)).toBe(false);

    // STEP 4 — Next call no longer sees the marker (still emits because
    // sessions floor not met and bootstrap is old enough, but reason differs).
    const after = await detectColdStart({
      repoRoot: repo,
      now: NOW,
    });
    expect(after.shouldEmit).toBe(true);
    expect(after.markerPath).toBeUndefined();
    expect(after.reason).toContain('bootstrap-age-met');
  });
});

// ---------------------------------------------------------------------------
// #19 — I6 → I4 vault-mirror quality config flow
// ---------------------------------------------------------------------------

describe('#19 — vault-mirror-quality parser → vault-mirror CLI', () => {
  it('parsed min-confidence: 0.8 → confidence=0.7 entry skipped-quality-low', () => {
    // STEP 1 — Write CLAUDE.md fragment with the vault-mirror block
    const claudeMdContent = [
      '## Session Config',
      '',
      'persistence: true',
      '',
      'vault-mirror:',
      '  quality:',
      '    min-confidence: 0.8',
      '',
    ].join('\n');

    const config = parseSessionConfig(claudeMdContent);
    expect(config['vault-mirror'].quality['min-confidence']).toBe(0.8);

    // STEP 2 — Build a vault + a JSONL with one confidence=0.7 learning
    const vaultDir = mkTmp('vmq-vault-');
    mkdirSync(join(vaultDir, '40-learnings'), { recursive: true });

    const learning = {
      id: 'test-learning-low-confidence',
      type: 'project',
      subject: 'Test low-conf learning',
      insight: 'A learning whose confidence is below the configured floor.',
      evidence: 'See test fixture.',
      confidence: 0.7,
      source_session: 'test-session-2026-05-21',
      created_at: '2026-05-21T12:00:00Z',
    };

    const sourceJsonl = join(mkTmp('vmq-src-'), 'learnings.jsonl');
    writeFileSync(sourceJsonl, JSON.stringify(learning) + '\n', 'utf8');

    // STEP 3 — Invoke vault-mirror CLI with the parsed value
    // VAULT_MIRROR_SKIP_CANONICAL_CHECK=1: vault-mirror's #600 D2 guard rejects non-git tmp vault-dirs;
    // bypass it here because this test uses a tmp dir, not the real canonical Meta-Vault.
    const result = spawnSync(
      process.execPath,
      [
        VAULT_MIRROR_SCRIPT,
        '--vault-dir', vaultDir,
        '--source', sourceJsonl,
        '--kind', 'learning',
        '--quality-min-confidence', String(config['vault-mirror'].quality['min-confidence']),
      ],
      { encoding: 'utf8', timeout: 15_000, env: { ...process.env, VAULT_MIRROR_SKIP_CANONICAL_CHECK: '1' } }
    );

    expect(result.status).toBe(0);

    // STEP 4 — Verify the action was skipped-quality-low
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const action = JSON.parse(lines[0]);
    expect(action.action).toBe('skipped-quality-low');
    expect(action.id).toBe('test-learning-low-confidence');
    expect(action.path).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #20 — I6 → I2 cold-start enabled gate
// ---------------------------------------------------------------------------

describe('#20 — cold-start parser → detectColdStart disabled gate', () => {
  it('enabled: false in config → detectColdStart returns shouldEmit:false reason:disabled', async () => {
    // STEP 1 — Parse a config block with cold-start.enabled: false
    const claudeMdContent = [
      '## Session Config',
      '',
      'persistence: true',
      '',
      'cold-start:',
      '  enabled: false',
      '',
    ].join('\n');

    const parsed = _parseColdStart(claudeMdContent);
    expect(parsed.enabled).toBe(false);

    // STEP 2 — Build a tmpdir that would OTHERWISE emit (bootstrap.lock present,
    // 2h old, sessions empty) — proving that enabled: false is the deciding
    // factor, not the absence of other prerequisites.
    const repo = mkTmp('cs-disabled-');
    const NOW = Date.parse('2026-05-21T12:00:00Z');
    const HOURS_AGO_2 = new Date(NOW - 2 * MS_PER_HOUR).toISOString();
    mkdirSync(join(repo, '.orchestrator', 'metrics'), { recursive: true });
    writeFileSync(
      join(repo, '.orchestrator', 'bootstrap.lock'),
      `bootstrapped-at: ${HOURS_AGO_2}\n`,
      'utf8'
    );
    writeFileSync(join(repo, '.orchestrator', 'metrics', 'sessions.jsonl'), '', 'utf8');

    // STEP 3 — Wire parsed.enabled into detectColdStart
    const result = await detectColdStart({
      repoRoot: repo,
      enabled: parsed.enabled,
      now: NOW,
    });

    expect(result.shouldEmit).toBe(false);
    expect(result.reason).toBe('disabled');
  });
});

// ---------------------------------------------------------------------------
// #21 — migrate-vault-paths preserves Session Config integrity
// ---------------------------------------------------------------------------

describe('#21 — migrate-vault-paths preserves Session Config integrity', () => {
  it('post-migration CLAUDE.md still parses with the same vault-mirror block', () => {
    const repo = mkTmp('mvp-cfg-');
    const claudeMd = join(repo, 'CLAUDE.md');

    // Before migration: CLAUDE.md contains the old username segment AND
    // a vault-mirror.quality block. Tests use synthetic placeholder usernames.
    const OLD_SEG = '/Users/oldname/';
    const NEW_SEG = '/Users/newname/';
    const before = [
      '# Project',
      '',
      `See ${OLD_SEG}Projects/vault for notes.`,
      '',
      '## Session Config',
      '',
      'persistence: true',
      '',
      'vault-mirror:',
      '  quality:',
      '    min-confidence: 0.9',
      '    min-narrative-chars: 600',
      '',
    ].join('\n');
    writeFileSync(claudeMd, before, 'utf8');

    // Pre-migration: parser sees the block correctly
    const preCfg = parseSessionConfig(before);
    expect(preCfg['vault-mirror']).toEqual({
      quality: { 'min-confidence': 0.9, 'min-narrative-chars': 600 },
    });

    // Run migrate-vault-paths --apply
    const migrate = spawnSync(
      process.execPath,
      [MIGRATE_VAULT_PATHS_SCRIPT, '--from', OLD_SEG, '--to', NEW_SEG, '--repos', repo, '--apply'],
      { encoding: 'utf8', timeout: 10_000 }
    );
    expect(migrate.status).toBe(0);

    // Post-migration: the path was rewritten BUT the Session Config block is intact
    const after = readFileSync(claudeMd, 'utf8');
    expect(after).toContain(`${NEW_SEG}Projects/vault`);
    expect(after).not.toContain(OLD_SEG);

    const postCfg = parseSessionConfig(after);
    expect(postCfg['vault-mirror']).toEqual({
      quality: { 'min-confidence': 0.9, 'min-narrative-chars': 600 },
    });
  });
});

// ---------------------------------------------------------------------------
// #22 — Default flow when vault-mirror block is absent
// ---------------------------------------------------------------------------

describe('#22 — vault-mirror defaults propagate end-to-end', () => {
  it('absent vault-mirror block → parseSessionConfig returns defaults → CLI uses 400/0.5', () => {
    // STEP 1 — Config without vault-mirror block
    const claudeMdContent = [
      '## Session Config',
      '',
      'persistence: true',
      '',
    ].join('\n');

    const cfg = parseSessionConfig(claudeMdContent);
    expect(cfg['vault-mirror']).toEqual({
      quality: { 'min-narrative-chars': 400, 'min-confidence': 0.5 },
    });

    // STEP 2 — A learning with confidence=0.6 (above the 0.5 default) must
    // pass the quality gate when the CLI uses the default threshold.
    const vaultDir = mkTmp('vmq-default-vault-');
    mkdirSync(join(vaultDir, '40-learnings'), { recursive: true });

    const learning = {
      id: 'test-learning-passes-default',
      type: 'project',
      subject: 'Passes default gate',
      insight: 'Confidence 0.6 is above the 0.5 default.',
      evidence: 'Default min-confidence is 0.5.',
      confidence: 0.6,
      source_session: 'test-session-2026-05-21',
      created_at: '2026-05-21T12:00:00Z',
    };

    const sourceJsonl = join(mkTmp('vmq-default-src-'), 'learnings.jsonl');
    writeFileSync(sourceJsonl, JSON.stringify(learning) + '\n', 'utf8');

    // STEP 3 — Invoke without --quality-min-confidence (so CLI uses its own default 0.5)
    // VAULT_MIRROR_SKIP_CANONICAL_CHECK=1: bypass the #600 D2 canonical-vault guard (tmp vault is not a git repo).
    const result = spawnSync(
      process.execPath,
      [
        VAULT_MIRROR_SCRIPT,
        '--vault-dir', vaultDir,
        '--source', sourceJsonl,
        '--kind', 'learning',
      ],
      { encoding: 'utf8', timeout: 15_000, env: { ...process.env, VAULT_MIRROR_SKIP_CANONICAL_CHECK: '1' } }
    );

    expect(result.status).toBe(0);

    // STEP 4 — Action should be `created` (or `updated`), NOT `skipped-quality-low`.
    // Note: action.path is RELATIVE to the vault dir; the absolute file lives
    // under <vaultDir>/<action.path>. action.id is the slug derived from
    // `subject` (v1 schema), not the original entry.id field.
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const action = JSON.parse(lines[0]);
    expect(action.action).toBe('created');
    expect(action.path).toContain('40-learnings/');
    expect(existsSync(join(vaultDir, action.path))).toBe(true);

    // The mirrored note must carry the fixture's insight verbatim — existsSync
    // alone does not prove the file body contains the source learning. The
    // insight string is pinned literally (matches the fixture above at the
    // `insight:` field — a fixture edit must update this assertion too).
    const mirrored = readFileSync(join(vaultDir, action.path), 'utf8');
    expect(mirrored).toContain('Confidence 0.6 is above the 0.5 default.');
    // Vault-mirror quality gate min-narrative-chars default is 400 — the
    // file body must exceed that floor or the mirror would have been skipped.
    expect(mirrored.length).toBeGreaterThan(400);
  });
});

// ---------------------------------------------------------------------------
// #23 — auto-dream parser → collectProposals queue (MED-8, issue #589)
// ---------------------------------------------------------------------------
//
// End-to-end chain for the SECOND confidence gate (issue #566): the value the
// session-end AUQ surfaces is the FILTERED collectProposals queue, and the
// filter threshold comes straight from Session Config. The consumption point
// is documented at skills/session-end/SKILL.md:399
// (`minConfidence: config['auto-dream']?.['min-confidence']`).
//
// STEP1 parse a config doc with auto-dream.min-confidence: 0.6
// STEP2 write a proposals.jsonl with a 0.4 record + a 0.7 record
// STEP3 collectProposals({ repoRoot, minConfidence: config[...]['min-confidence'] })
// STEP4 assert the returned queue DROPS 0.4 and KEEPS 0.7

describe('#23 — auto-dream parser → collectProposals queue', () => {
  // Build a complete proposal JSONL line (mirrors the makeJsonl helper in
  // tests/lib/memory-proposals/collector.test.mjs). `confidence` is the field
  // the #566 filter inspects; the rest is plausible filler for the deserializer.
  function makeProposalJsonl(confidence, subject, createdAt) {
    return JSON.stringify({
      schema_version: 1,
      id: `prop-${subject}`,
      type: 'workflow-pattern',
      subject,
      insight: 'insight body',
      evidence: 'evidence body',
      confidence,
      wave_id: 'W1',
      created_at: createdAt,
    });
  }

  it('parsed min-confidence: 0.6 → collectProposals drops the 0.4 record and keeps the 0.7 record', async () => {
    // STEP 1 — Parse the Session Config doc and read the threshold.
    const claudeMdContent = [
      '## Session Config',
      '',
      'persistence: true',
      '',
      'auto-dream:',
      '  min-confidence: 0.6',
      '',
    ].join('\n');

    const config = parseSessionConfig(claudeMdContent);
    expect(config['auto-dream']['min-confidence']).toBe(0.6);

    // STEP 2 — Build a tmp repo with a proposals.jsonl (one below, one above
    // the 0.6 threshold). created_at deltas keep FIFO ordering deterministic.
    const repo = mkTmp('autodream-collect-');
    mkdirSync(join(repo, '.orchestrator', 'metrics'), { recursive: true });
    const proposalsPath = join(repo, '.orchestrator', 'metrics', 'proposals.jsonl');
    const lines = [
      makeProposalJsonl(0.4, 'below-threshold', '2026-05-27T10:00:00.000Z'),
      makeProposalJsonl(0.7, 'above-threshold', '2026-05-27T10:00:01.000Z'),
    ];
    writeFileSync(proposalsPath, lines.join('\n') + '\n', 'utf8');

    // STEP 3 — Invoke the consumer with the PARSED threshold (the exact wiring
    // session-end uses at SKILL.md:399).
    const { queue } = await collectProposals({
      repoRoot: repo,
      minConfidence: config['auto-dream']['min-confidence'],
    });

    // STEP 4 — The AUQ-surfaced queue must contain ONLY the 0.7 record.
    // FALSIFICATION: if the parsed threshold were not threaded through (e.g.
    // the filter ran with no minConfidence), the 0.4 record would survive and
    // queue.length would be 2. If the threshold were mis-read as a higher value
    // (≥0.7), the 0.7 record would be at the boundary — pinning subject + value
    // catches a wrong-record-kept regression too.
    expect(queue).toHaveLength(1);
    expect(queue[0].subject).toBe('above-threshold');
    expect(queue[0].confidence).toBe(0.7);
  });
});
