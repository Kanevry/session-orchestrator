/**
 * tests/probes/ssot-code-diff.test.mjs
 *
 * Behavioral tests for skills/discovery/probes/ssot-code-diff.mjs.
 * Uses tmpdir-based isolation — never touches the host repo.
 *
 * Per .claude/rules/testing.md floor/ceiling guidance: these tests never pin
 * this REPO's live counts (skills/, commands/, .claude/rules/, blocked-commands
 * rules — all of which drift over time). Every fixture below builds its own
 * tmpdir "actual" (a fabricated JSON / directory layout) and asserts the probe
 * diffs it against a fabricated doc claim — never against this repo's real,
 * moving numbers.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import { runProbe } from '../../skills/discovery/probes/ssot-code-diff.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'ssot-code-diff-'));
}

function writeFile(root, relPath, content) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

/** Write a minimal marker file so the activation gate is satisfied. */
function writeActivationMarker(root) {
  writeFile(root, 'CLAUDE.md', '# marker\n');
}

/** Write a blocked-commands.json with N rules (fabricated, never the real repo count). */
function writeBlockedCommands(root, ruleCount) {
  const rules = Array.from({ length: ruleCount }, (_, i) => ({ id: `rule-${i}`, pattern: 'x' }));
  writeFile(root, join('.orchestrator', 'policy', 'blocked-commands.json'), JSON.stringify({ rules }));
}

function writeRuleFiles(root, count) {
  for (let i = 0; i < count; i++) {
    writeFile(root, join('.claude', 'rules', `rule-${i}.md`), '# rule\n');
  }
  if (count === 0) mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
}

function writeSkillDirs(root, count) {
  for (let i = 0; i < count; i++) {
    writeFile(root, join('skills', `skill-${i}`, 'SKILL.md'), '# skill\n');
  }
  // _shared/ must never count toward "user-facing"
  writeFile(root, join('skills', '_shared', 'notes.md'), '# internal\n');
}

function writeCommandFiles(root, count) {
  for (let i = 0; i < count; i++) {
    writeFile(root, join('commands', `cmd-${i}.md`), '# cmd\n');
  }
  if (count === 0) mkdirSync(join(root, 'commands'), { recursive: true });
}

// ---------------------------------------------------------------------------
// Tmpdir cleanup
// ---------------------------------------------------------------------------

let dirs = [];

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  dirs = [];
});

function tmp() {
  const d = makeTmp();
  dirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ssot-code-diff probe', () => {
  describe('skip paths', () => {
    it('returns skipped_reason when neither CLAUDE.md nor README.md is present', async () => {
      const root = tmp();
      const result = await runProbe(root, {});

      expect(result.skipped_reason).toContain('CLAUDE.md and README.md not found');
      expect(result.findings).toEqual([]);
      expect(result.metrics.claims_checked).toBe(0);
    });

    it('does not write JSONL when the activation marker is missing', async () => {
      const root = tmp();
      await runProbe(root, {});
      expect(existsSync(join(root, '.orchestrator/metrics/ssot-code-diff.jsonl'))).toBe(false);
    });

    it('activates on README.md alone (CLAUDE.md not required)', async () => {
      const root = tmp();
      writeFile(root, 'README.md', '# readme\n');

      const result = await runProbe(root, {});

      expect(result.skipped_reason).toBeUndefined();
    });
  });

  describe('match case — claim equals actual', () => {
    it('produces zero findings when the blocked-commands.json rule count matches the doc claim', async () => {
      const root = tmp();
      writeActivationMarker(root);
      writeBlockedCommands(root, 7);
      writeFile(root, 'CLAUDE.md', '# marker\n\nGuard blocks per blocked-commands.json (7 rules) at write time.\n');

      const result = await runProbe(root, {});

      expect(result.findings).toHaveLength(0);
      expect(result.metrics.mismatches).toBe(0);
      expect(result.metrics.claims_checked).toBe(1);
    });
  });

  describe('mismatch case — claim drifted from actual', () => {
    it('produces a high-severity finding with claimed/actual evidence for a blocked-commands.json drift', async () => {
      const root = tmp();
      writeActivationMarker(root);
      writeBlockedCommands(root, 9);
      writeFile(
        root,
        'CLAUDE.md',
        '# marker\n\nThe destructive-command guard blocks per blocked-commands.json (5 rules).\n',
      );

      const result = await runProbe(root, {});

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('high');
      expect(result.findings[0].evidence.claimed).toBe(5);
      expect(result.findings[0].evidence.actual).toBe(9);
      expect(result.findings[0].evidence.file).toBe('CLAUDE.md');
      expect(typeof result.findings[0].evidence.line).toBe('number');
      expect(result.metrics.mismatches).toBe(1);
    });

    it('produces a medium-severity finding for a skills/ user-facing count drift', async () => {
      const root = tmp();
      writeActivationMarker(root);
      writeSkillDirs(root, 3); // 3 user-facing dirs + _shared/ (excluded)
      writeFile(root, 'README.md', '# readme\n\nThis plugin ships **2 skills** for the session lifecycle.\n');

      const result = await runProbe(root, {});

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('medium');
      expect(result.findings[0].evidence.claimed).toBe(2);
      expect(result.findings[0].evidence.actual).toBe(3);
    });

    it('produces a finding for a commands/*.md count drift', async () => {
      const root = tmp();
      writeActivationMarker(root);
      writeCommandFiles(root, 4);
      writeFile(root, 'README.md', '# readme\n\nAll 6 commands are documented below.\n');

      const result = await runProbe(root, {});

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].evidence.claimed).toBe(6);
      expect(result.findings[0].evidence.actual).toBe(4);
    });

    it('produces a finding for a .claude/rules/*.md count drift', async () => {
      const root = tmp();
      writeActivationMarker(root);
      writeRuleFiles(root, 5);
      writeFile(root, 'CLAUDE.md', '# marker\n\nThis repo carries 8 rule files under .claude/rules/.\n');

      const result = await runProbe(root, {});

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].evidence.claimed).toBe(8);
      expect(result.findings[0].evidence.actual).toBe(5);
    });
  });

  describe('missing claim source — no such claim in the docs', () => {
    it('returns zero findings when no doc mentions blocked-commands.json rule counts at all', async () => {
      const root = tmp();
      writeActivationMarker(root);
      writeBlockedCommands(root, 9);
      writeFile(root, 'CLAUDE.md', '# marker\n\nNo relevant claim here.\n');

      const result = await runProbe(root, {});

      expect(result.findings).toEqual([]);
      expect(result.metrics.claims_checked).toBe(0);
    });

    it('does not throw when a registry source doc file is entirely absent', async () => {
      const root = tmp();
      // Only README.md exists (the activation marker) — none of the other
      // registry source files (docs/components.md, structure.md, etc.) exist.
      writeFile(root, 'README.md', '# readme\n');
      writeBlockedCommands(root, 3);

      await expect(runProbe(root, {})).resolves.toBeTruthy();
      const result = await runProbe(root, {});
      expect(result.findings).toEqual([]);
    });
  });

  describe('missing policy file — graceful skip', () => {
    it('returns zero findings and does not throw when blocked-commands.json is absent', async () => {
      const root = tmp();
      writeActivationMarker(root);
      writeFile(root, 'CLAUDE.md', '# marker\n\nThe guard enforces policy (7 rules).\n');
      // No .orchestrator/policy/blocked-commands.json written at all.

      const result = await runProbe(root, {});

      expect(result.findings).toEqual([]);
      expect(result.metrics.claims_checked).toBe(0);
      expect(result.skipped_reason).toBeUndefined();
    });

    it('still checks other registry entries when only blocked-commands.json is missing', async () => {
      const root = tmp();
      writeActivationMarker(root);
      writeCommandFiles(root, 2);
      writeFile(root, 'CLAUDE.md', '# marker\n\nGuard blocks per blocked-commands.json (7 rules).\n');
      writeFile(root, 'README.md', '# readme\n\nAll 5 commands ship in this repo.\n');

      const result = await runProbe(root, {});

      // blocked-commands.json entry is skipped (no such file); commands entry still runs.
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].evidence.claimed).toBe(5);
      expect(result.findings[0].evidence.actual).toBe(2);
    });
  });

  describe('JSONL output', () => {
    it('appends a valid JSONL record after a non-skipped scan', async () => {
      const root = tmp();
      writeActivationMarker(root);
      writeBlockedCommands(root, 9);
      writeFile(root, 'CLAUDE.md', '# marker\n\nblocked-commands.json (5 rules) enforced.\n');

      await runProbe(root, {});

      const jsonlPath = join(root, '.orchestrator/metrics/ssot-code-diff.jsonl');
      expect(existsSync(jsonlPath)).toBe(true);

      const record = JSON.parse(readFileSync(jsonlPath, 'utf8').trim().split('\n').at(-1));

      expect(record.probe).toBe('ssot-code-diff');
      expect(record.project_root).toBe(root);
      expect(typeof record.timestamp).toBe('string');
      expect(record.claims_checked).toBe(1);
      expect(record.mismatches).toBe(1);
      expect(typeof record.docs_scanned).toBe('number');
      expect(typeof record.duration_ms).toBe('number');
      expect(record.findings).toHaveLength(1);
      expect(record.findings[0].claimed).toBe(5);
      expect(record.findings[0].actual).toBe(9);
    });
  });

  describe('JSONL write failure — non-fatal (#794 Item 5b)', () => {
    it('still returns the real findings/metrics when the JSONL target path is a directory (EISDIR write failure is caught, not rethrown)', async () => {
      const root = tmp();
      writeActivationMarker(root);
      writeBlockedCommands(root, 9);
      writeFile(root, 'CLAUDE.md', '# marker\n\nblocked-commands.json (5 rules) enforced.\n');

      // Pre-create the JSONL write target AS A DIRECTORY so appendFileSync
      // throws EISDIR. A type-mismatch failure (unlike a chmod-based EACCES
      // probe) fails identically for root and non-root — CI runs as root,
      // where chmod-based permission failures are silently bypassed (see
      // .claude/rules/testing.md § Root-as-uid-0 test hazards).
      mkdirSync(join(root, '.orchestrator', 'metrics', 'ssot-code-diff.jsonl'), { recursive: true });

      const result = await runProbe(root, {});

      // Load-bearing: proves the inner try/catch around appendFileSync
      // swallows the write failure rather than letting it propagate to the
      // outer top-level catch (which would discard findings/metrics and set
      // skipped_reason instead — see Fake-Regression-Check note in the PR
      // description / agent report).
      expect(result.findings).toHaveLength(1);
      expect(result.metrics).toEqual({ claims_checked: 1, mismatches: 1, docs_scanned: 1 });
    });
  });

  describe('no-throw discipline', () => {
    it('returns an object and does not throw when given a completely invalid root path', async () => {
      const result = await runProbe('/dev/null/not-a-dir', {});

      expect(result).toBeTruthy();
      expect(typeof result).toBe('object');
      expect(result.findings).toBeDefined();
      expect(result.metrics).toBeDefined();
    });

    it('does not throw when blocked-commands.json contains invalid JSON', async () => {
      const root = tmp();
      writeActivationMarker(root);
      writeFile(root, join('.orchestrator', 'policy', 'blocked-commands.json'), '{ not valid json');
      writeFile(root, 'CLAUDE.md', '# marker\n\nblocked-commands.json (5 rules) enforced.\n');

      const result = await runProbe(root, {});

      expect(result.findings).toEqual([]);
    });
  });

  describe('duration_ms', () => {
    it('returns a non-negative duration_ms', async () => {
      const root = tmp();
      writeActivationMarker(root);

      const result = await runProbe(root, {});

      expect(typeof result.duration_ms).toBe('number');
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });
});
