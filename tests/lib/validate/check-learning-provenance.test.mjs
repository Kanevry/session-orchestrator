/**
 * tests/lib/validate/check-learning-provenance.test.mjs
 *
 * Tests for scripts/lib/validate/check-learning-provenance.mjs (issue #1017).
 *
 * The bug every case names is ONE bug in its variants: "a .claude/rules/ file
 * cites a learning that no longer exists anywhere, and nothing notices."
 *
 * Every fixture is synthetic and lives in $TMPDIR. No test mutates the real
 * `.orchestrator/metrics/learnings.jsonl`, the real archive, or the real
 * `.claude/rules/` — a drift guard must prove itself on a fixture, never on a
 * production edit. The one test that touches the real repo is read-only and
 * asserts a floor/ceiling, not a pinned count (`testing.md` § Dynamic Artifact
 * Counts).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  inspectLearningProvenance,
  extractProvenance,
} from '@lib/validate/check-learning-provenance.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-learning-provenance.mjs');

/**
 * Build a synthetic learning record in the live-store shape.
 *
 * @param {{id: string, type?: string, subject?: string}} parts
 * @returns {string} one JSONL line (no trailing newline)
 */
function record({ id, type = 'anti-pattern', subject = 'some subject' }) {
  return JSON.stringify({
    schema_version: 1,
    id,
    type,
    subject,
    insight: 'synthetic insight',
    evidence: 'synthetic evidence',
    confidence: 0.9,
    created_at: '2026-08-01T00:00:00.000Z',
  });
}

/**
 * Build a rule file body carrying a machine-written Provenance block.
 *
 * @param {{id?: string|null, key?: string|null}} parts
 * @returns {string}
 */
function ruleBody({ id = null, key = null }) {
  const lines = ['# Auto-generated rule', '', 'Body prose.', '', '## Provenance'];
  if (key !== null) lines.push(`- learning-key: \`${key}\``);
  if (id !== null) lines.push(`- learning-id: \`${id}\``);
  lines.push('- confidence: 0.9', '');
  return lines.join('\n');
}

/**
 * Build a fixture repo: `.claude/rules/<name>.md` files plus optional stores.
 *
 * @param {{rules?: Record<string, string>, live?: string[]|null, archive?: string[]|null}} parts
 * @returns {string} absolute fixture root (caller removes it)
 */
function makeFixture(parts) {
  const root = mkdtempSync(join(tmpdir(), 'learning-provenance-'));
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(root, '.orchestrator', 'metrics'), { recursive: true });
  for (const [name, body] of Object.entries(parts.rules ?? {})) {
    writeFileSync(join(root, '.claude', 'rules', name), body);
  }
  if (parts.live !== null && parts.live !== undefined) {
    writeFileSync(
      join(root, '.orchestrator', 'metrics', 'learnings.jsonl'),
      parts.live.join('\n') + '\n',
    );
  }
  if (parts.archive !== null && parts.archive !== undefined) {
    writeFileSync(
      join(root, '.orchestrator', 'metrics', 'learnings-archive.jsonl'),
      parts.archive.join('\n') + '\n',
    );
  }
  return root;
}

describe('check-learning-provenance — dangling provenance census', () => {
  it('resolves an id in the live store and reports an id present in neither store', async () => {
    // Fake-regression pair: the SAME rule file, one store line apart.
    const green = makeFixture({
      rules: { 'a.md': ruleBody({ id: 'id-alive', key: 'anti-pattern/some-subject' }) },
      live: [record({ id: 'id-alive' })],
      archive: [],
    });
    const red = makeFixture({
      rules: { 'a.md': ruleBody({ id: 'id-alive', key: 'anti-pattern/some-subject' }) },
      live: [record({ id: 'someone-else' , subject: 'other subject' })],
      archive: [],
    });
    try {
      const pass = await inspectLearningProvenance(green);
      expect(pass.findings).toEqual([]);
      expect(pass.summary.resolved).toBe(1);
      expect(pass.summary.dangling).toBe(0);
      expect(pass.ok).toBe(true);

      const fail = await inspectLearningProvenance(red);
      expect(fail.findings.map((f) => f.kind)).toEqual(['dangling-learning-id']);
      expect(fail.findings[0].learningId).toBe('id-alive');
      expect(fail.findings[0].file).toBe('.claude/rules/a.md');
      expect(fail.summary.dangling).toBe(1);
      expect(fail.ok).toBe(false);
    } finally {
      rmSync(green, { recursive: true, force: true });
      rmSync(red, { recursive: true, force: true });
    }
  });

  it('accepts an id that lives ONLY in the archive — a naive live-store-only check would fail here', async () => {
    // The expiry sweep MOVES a record from the live store into the archive
    // (`sweep-expired-learnings.mjs --apply`). Reporting that as rot would flag
    // every correctly-archived record.
    const root = makeFixture({
      rules: { 'a.md': ruleBody({ id: 'id-archived', key: 'anti-pattern/some-subject' }) },
      live: [],
      archive: [record({ id: 'id-archived' })],
    });
    try {
      const result = await inspectLearningProvenance(root);
      expect(result.findings).toEqual([]);
      expect(result.summary.resolved).toBe(1);
      expect(result.stores.archive.records).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not report a rule file with no provenance block', async () => {
    const root = makeFixture({
      rules: {
        'plain.md': '# Handwritten rule\n\nNo provenance here.\n',
        // A prose citation is NOT the structured list-item form — deliberately
        // out of scope (see § Named residuals in the check header).
        'prose.md': '# Rule\n\nCross-reference: learning id `mac-runner-starvation` in the store.\n',
      },
      live: [],
      archive: [],
    });
    try {
      const result = await inspectLearningProvenance(root);
      expect(result.summary.rulesScanned).toBe(2);
      expect(result.summary.rulesWithProvenance).toBe(0);
      expect(result.findings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('distinguishes a superseded id (key still resolves) from a fully dangling one', async () => {
    // Different remedies: a superseded id is a one-line re-stamp; a dangling one
    // needs re-derivation. The re-minted record keeps type+subject, so its
    // logical key is unchanged while its UUID is new.
    const root = makeFixture({
      rules: {
        'superseded.md': ruleBody({ id: 'old-uuid', key: 'anti-pattern/some-subject' }),
        'gone.md': ruleBody({ id: 'ghost-uuid', key: 'anti-pattern/vanished-subject' }),
      },
      live: [record({ id: 'new-uuid', type: 'anti-pattern', subject: 'some subject' })],
      archive: [],
    });
    try {
      const result = await inspectLearningProvenance(root);
      const byFile = Object.fromEntries(result.findings.map((f) => [f.file, f.kind]));
      expect(byFile['.claude/rules/superseded.md']).toBe('superseded-learning-id');
      expect(byFile['.claude/rules/gone.md']).toBe('dangling-learning-id');
      expect(result.summary.superseded).toBe(1);
      expect(result.summary.dangling).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('audits a key-only provenance block on the key axis', async () => {
    const root = makeFixture({
      rules: {
        // The emitter writes the KEBAB form; comparison is exact, never fuzzy.
        'keyed-ok.md': ruleBody({ key: 'anti-pattern/some-subject' }),
        'keyed-rot.md': ruleBody({ key: 'anti-pattern/nothing-matches-this' }),
      },
      live: [record({ id: 'whatever', type: 'anti-pattern', subject: 'some subject' })],
      archive: [],
    });
    try {
      const result = await inspectLearningProvenance(root);
      expect(result.findings.map((f) => `${f.kind}:${f.file}`)).toEqual([
        'dangling-learning-key:.claude/rules/keyed-rot.md',
      ]);
      expect(result.summary.resolved).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('survives an unparseable JSONL line: counts it, keeps the rest of the store', async () => {
    // The silent-swallow failure: one corrupt line must not discard the corpus
    // (which would report every live pointer as dangling) and must not crash.
    const root = makeFixture({
      rules: { 'a.md': ruleBody({ id: 'id-alive', key: 'anti-pattern/some-subject' }) },
      live: ['{ this is not json', record({ id: 'id-alive' }), 'also }} broken'],
      archive: [],
    });
    try {
      const result = await inspectLearningProvenance(root);
      expect(result.findings).toEqual([]);
      expect(result.summary.resolved).toBe(1);
      expect(result.summary.malformedStoreLines).toBe(2);
      expect(result.stores.live.records).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports ONE stores-absent finding instead of N dangling ones when no store exists', async () => {
    // A consumer repo that has not started collecting learnings must not be told
    // its rules are rotten — "dangling" is not a claim resolvable here.
    const root = makeFixture({
      rules: {
        'a.md': ruleBody({ id: 'id-1', key: 'anti-pattern/one' }),
        'b.md': ruleBody({ id: 'id-2', key: 'anti-pattern/two' }),
      },
      live: null,
      archive: null,
    });
    try {
      const result = await inspectLearningProvenance(root);
      expect(result.findings.map((f) => f.kind)).toEqual(['stores-absent']);
      expect(result.summary.dangling).toBe(0);
      expect(result.stores.live.present).toBe(false);
      expect(result.stores.archive.present).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns a clean, non-throwing result when there is no .claude/rules/ directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'learning-provenance-empty-'));
    try {
      const result = await inspectLearningProvenance(root);
      expect(result.toolError).toBe(false);
      expect(result.ok).toBe(true);
      expect(result.summary.rulesScanned).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('strips backticks and a CRLF carriage return from the pointer value', async () => {
    // The emitter writes backtick-wrapped values; a CRLF checkout leaves \r on
    // the line. Either would turn a live id into a phantom dangling report.
    expect(extractProvenance('- learning-id: `abc-123`\r\n')).toEqual({
      id: 'abc-123',
      key: null,
    });
    expect(extractProvenance('- learning-key: `anti-pattern/x`\n- learning-id: `id-9`\n')).toEqual({
      id: 'id-9',
      key: 'anti-pattern/x',
    });
    expect(extractProvenance('# no provenance\n')).toEqual({ id: null, key: null });
  });

  it('exits 0 with findings present — WARN-only, and discriminates on the emitted lines', async () => {
    // Exit status alone is assert-nothing here: 0 is the code for BOTH "clean"
    // and "11 dangling pointers". Discriminate on the emitted findings.
    const root = makeFixture({
      rules: { 'a.md': ruleBody({ id: 'ghost', key: 'anti-pattern/ghost' }) },
      live: [record({ id: 'unrelated', subject: 'unrelated subject' })],
      archive: [],
    });
    try {
      const run = spawnSync('node', [SCRIPT, root], { encoding: 'utf8' });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('WARN: [dangling-learning-id] .claude/rules/a.md');
      expect(run.stdout).toContain('0 resolved, 1 dangling, 0 superseded');

      const json = spawnSync('node', [SCRIPT, root, '--json'], { encoding: 'utf8' });
      expect(json.status).toBe(0);
      const envelope = JSON.parse(json.stdout);
      expect(envelope.ok).toBe(false);
      expect(envelope.findings.map((f) => f.kind)).toEqual(['dangling-learning-id']);
      expect(envelope.summary.dangling).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an unknown flag with exit 1 and writes the usage to stderr', async () => {
    const run = spawnSync('node', [SCRIPT, REPO_ROOT, '--bogus'], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Unknown flag(s): --bogus');
    expect(run.stdout).toBe('');
  });

  it('censuses the real repo read-only, without a tool error', async () => {
    // Grounding pin: the collector must resolve this repo's real surfaces.
    // Floor/ceiling, never a pinned count — both the rule corpus and the store
    // grow (`testing.md` § Dynamic Artifact Counts).
    const result = await inspectLearningProvenance(REPO_ROOT);
    expect(result.toolError).toBe(false);

    // The live store is GITIGNORED (`.gitignore:37 .orchestrator/metrics/*.jsonl`),
    // so it exists on a developer machine and NOT on a fresh CI clone. Pinning
    // `.present` to true made this test pass locally and fail on CI — a test that
    // depended on untracked state. Assert the contract that holds either way, and
    // branch on the absence case rather than assuming it away: with no store to
    // resolve against, the collector must report ZERO dangling pointers rather
    // than declaring every provenance block dead.
    // The rule corpus is tracked, so these hold on any checkout.
    expect(result.summary.rulesScanned).toBeGreaterThanOrEqual(10);
    expect(result.summary.rulesWithProvenance).toBeGreaterThanOrEqual(1);
    expect(result.summary.rulesWithProvenance).toBeLessThanOrEqual(result.summary.rulesScanned);

    // The stores are NOT. `.gitignore:37` ignores `.orchestrator/metrics/*.jsonl`,
    // so they exist on a developer machine and are absent on a fresh CI clone.
    // The earlier form pinned `stores.live.present` to true and asserted the sum
    // invariant unconditionally — both pass locally and fail on CI, because they
    // encoded untracked state as a fact. Branch on it instead: each side is a real
    // contract, and the absent side is the one worth guarding.
    expect(typeof result.stores.live.present).toBe('boolean');
    if (result.stores.live.present || result.stores.archive.present) {
      // A pointer resolves, dangles, or is superseded — exactly one, no leaks.
      expect(result.summary.resolved + result.summary.dangling + result.summary.superseded).toBe(
        result.summary.rulesWithProvenance,
      );
    } else {
      // With nothing to resolve against, the collector must stay silent rather
      // than declare every provenance block dead. A tool that reported 13 dangling
      // here would turn an absent store into a fake integrity alarm on every fresh
      // clone — which is precisely the false-positive this branch pins.
      expect(result.summary.dangling).toBe(0);
      expect(result.summary.resolved).toBe(0);
      expect(result.summary.superseded).toBe(0);
    }
  });
});
