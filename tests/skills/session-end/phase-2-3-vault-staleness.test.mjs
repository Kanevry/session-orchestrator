/**
 * tests/skills/session-end/phase-2-3-vault-staleness.test.mjs
 *
 * Specification tests for the Phase 2.3 Vault Staleness Check introduced in
 * skills/session-end/SKILL.md.
 *
 * Phase 2.3 is a documented procedure (not directly executable JS), so the
 * tests cover three dimensions:
 *
 *   A — Probe contract: both probes export the documented async runProbe
 *       signature and return the required shape on a tmp empty vault dir.
 *
 *   B — Config schema: validateVaultStaleness correctly accepts/rejects all
 *       relevant inputs, including verifying that mode='hard' is invalid
 *       (#217 canonical fix).
 *
 *   C — Phase 2.3 spec presence in SKILL.md: gate text, mode enum, probe
 *       import paths, strict-mode override mechanism, and Deviation log mention.
 *
 *   D — Phase 6 Final Report Docs Health line: three render cases are present.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runProbe as runStaleness } from '../../../skills/discovery/probes/vault-staleness.mjs';
import { runProbe as runNarrative } from '../../../skills/discovery/probes/vault-narrative-staleness.mjs';
import { validateVaultStaleness } from '@lib/config-schema.mjs';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SKILL_PATH = join(REPO_ROOT, 'skills', 'session-end', 'SKILL.md');
// #1157 references/ split — Phase 2 (incl. 2.3) and the Phase 6 Session Summary
// template moved verbatim out of SKILL.md into references/. Each group below reads
// the file that OWNS its prose; SKILL.md keeps a stub naming the phase.
const PHASE2_PATH = join(REPO_ROOT, 'skills', 'session-end', 'references', 'phase-2-quality-gate.md');
const SUMMARY_TEMPLATE_PATH = join(
  REPO_ROOT, 'skills', 'session-end', 'references', 'session-summary-template.md',
);

// ---------------------------------------------------------------------------
// Tmpdir helpers
// ---------------------------------------------------------------------------

let tmpDirs = [];

afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tmpDirs = [];
});

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'so-phase23-'));
  tmpDirs.push(d);
  return d;
}

function makeEmptyVault(root) {
  const vaultDir = join(root, 'vault');
  mkdirSync(join(vaultDir, '01-projects'), { recursive: true });
  return vaultDir;
}

// ---------------------------------------------------------------------------
// A — Probe contract (smoke)
// ---------------------------------------------------------------------------

describe('A — vault-staleness probe contract', () => {
  it('A1: runProbe from vault-staleness.mjs is an async function', () => {
    expect(typeof runStaleness).toBe('function');
    // async functions return a Promise
    const root = tmp();
    const result = runStaleness(root, {});
    expect(result).toBeInstanceOf(Promise);
    return result; // let vitest await resolution so it doesn't leak
  });

  it('A1: vault-staleness runProbe returns {findings, metrics, duration_ms} on empty vault dir', async () => {
    const root = tmp();
    const vaultDir = makeEmptyVault(root);

    const result = await runStaleness(root, {
      'vault-integration': { 'vault-dir': vaultDir },
    });

    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.metrics).toBeDefined();
    expect(typeof result.metrics).toBe('object');
    expect(typeof result.duration_ms).toBe('number');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('A1: vault-staleness result.findings is empty when no projects exist', async () => {
    const root = tmp();
    const vaultDir = makeEmptyVault(root);

    const result = await runStaleness(root, {
      'vault-integration': { 'vault-dir': vaultDir },
    });

    expect(result.findings).toHaveLength(0);
    expect(result.metrics.scanned_projects).toBe(0);
  });

  it('A2: runProbe from vault-narrative-staleness.mjs is an async function', () => {
    expect(typeof runNarrative).toBe('function');
    const root = tmp();
    const result = runNarrative(root, {});
    expect(result).toBeInstanceOf(Promise);
    return result;
  });

  it('A2: vault-narrative-staleness runProbe returns {findings, metrics, duration_ms} on empty vault dir', async () => {
    const root = tmp();
    const vaultDir = makeEmptyVault(root);

    const result = await runNarrative(root, {
      'vault-integration': { 'vault-dir': vaultDir },
    });

    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.metrics).toBeDefined();
    expect(typeof result.metrics).toBe('object');
    expect(typeof result.duration_ms).toBe('number');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('A2: vault-narrative-staleness result.findings is empty when no projects exist', async () => {
    const root = tmp();
    const vaultDir = makeEmptyVault(root);

    const result = await runNarrative(root, {
      'vault-integration': { 'vault-dir': vaultDir },
    });

    expect(result.findings).toHaveLength(0);
    expect(result.metrics.scanned_projects).toBe(0);
  });

  it('A3: vault-staleness probe appends exactly one JSONL record per run', async () => {
    const root = tmp();
    const vaultDir = makeEmptyVault(root);
    const jsonlPath = join(root, '.orchestrator', 'metrics', 'vault-staleness.jsonl');

    // Create a stale project so the probe goes past early-exit and writes JSONL
    const projectDir = join(vaultDir, '01-projects', 'proj-a');
    mkdirSync(projectDir, { recursive: true });
    const staleDate = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    writeFileSync(
      join(projectDir, '_overview.md'),
      `---\nslug: proj-a\ntier: active\nlastSync: ${staleDate}\n---\n`,
      'utf8',
    );

    await runStaleness(root, { 'vault-integration': { 'vault-dir': vaultDir } });

    expect(existsSync(jsonlPath)).toBe(true);
    const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.probe).toBe('vault-staleness');
    expect(typeof record.timestamp).toBe('string');
  });

  it('A3: vault-narrative-staleness probe appends exactly one JSONL record per run', async () => {
    const root = tmp();
    const vaultDir = makeEmptyVault(root);
    const jsonlPath = join(root, '.orchestrator', 'metrics', 'vault-narrative-staleness.jsonl');

    // Create a project with a stale narrative file
    const projectDir = join(vaultDir, '01-projects', 'proj-b');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, '_overview.md'),
      `---\nslug: proj-b\ntier: active\n---\n`,
      'utf8',
    );
    const staleDate = new Date(Date.now() - 90 * 86400 * 1000).toISOString();
    writeFileSync(
      join(projectDir, 'context.md'),
      `---\nupdated: ${staleDate}\n---\n\n# Context\n`,
      'utf8',
    );

    await runNarrative(root, { 'vault-integration': { 'vault-dir': vaultDir } });

    expect(existsSync(jsonlPath)).toBe(true);
    const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.probe).toBe('vault-narrative-staleness');
    expect(typeof record.timestamp).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// B — Config schema
// ---------------------------------------------------------------------------

describe('B — vault-staleness config schema', () => {
  it('B1: vault-staleness.enabled: false parses without errors', () => {
    const errs = validateVaultStaleness({ enabled: false });
    expect(errs).toHaveLength(0);
  });

  it('B1: absent enabled field (default false) parses without errors', () => {
    const errs = validateVaultStaleness({});
    expect(errs).toHaveLength(0);
  });

  it('B2: mode=warn is accepted', () => {
    const errs = validateVaultStaleness({ mode: 'warn' });
    expect(errs).toHaveLength(0);
  });

  it('B2: mode=strict is accepted', () => {
    const errs = validateVaultStaleness({ mode: 'strict' });
    expect(errs).toHaveLength(0);
  });

  it('B2: mode=off is accepted', () => {
    const errs = validateVaultStaleness({ mode: 'off' });
    expect(errs).toHaveLength(0);
  });

  it('B2: mode=hard is REJECTED — not a valid enum value (#217 canonical)', () => {
    const errs = validateVaultStaleness({ mode: 'hard' });
    expect(errs.length).toBeGreaterThan(0);
    // Error message must mention the valid choices
    expect(errs.some((e) => e.includes('strict') || e.includes('warn') || e.includes('off'))).toBe(true);
  });

  it('B3: thresholds with top=30, active=60, archived=180 parses without errors', () => {
    const errs = validateVaultStaleness({
      thresholds: { top: 30, active: 60, archived: 180 },
    });
    expect(errs).toHaveLength(0);
  });

  it('B3: omitting all thresholds is valid (all have defaults)', () => {
    const errs = validateVaultStaleness({ enabled: true, mode: 'warn' });
    expect(errs).toHaveLength(0);
  });

  it('B4: thresholds.top as string "thirty" is rejected', () => {
    const errs = validateVaultStaleness({ thresholds: { top: 'thirty' } });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('top'))).toBe(true);
  });

  it('B4: thresholds.active as zero is rejected (must be positive)', () => {
    const errs = validateVaultStaleness({ thresholds: { active: 0 } });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('active'))).toBe(true);
  });

  it('B4: thresholds.archived as negative is rejected', () => {
    const errs = validateVaultStaleness({ thresholds: { archived: -1 } });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('archived'))).toBe(true);
  });

  it('B4: enabled as non-boolean (number 1) is rejected', () => {
    const errs = validateVaultStaleness({ enabled: 1 });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('boolean'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C — Phase 2.3 spec presence in SKILL.md
// ---------------------------------------------------------------------------

describe('C — Phase 2.3 spec presence in references/phase-2-quality-gate.md', () => {
  const skillContent = readFileSync(SKILL_PATH, 'utf8');
  const phase2Content = readFileSync(PHASE2_PATH, 'utf8');

  // Extract the Phase 2.3 section. It is the LAST section of the Phase 2 reference
  // file (Phase 2.5 Custom Phases — which legitimately uses the `hard` enum — stayed
  // in SKILL.md), so the slice runs to end-of-file and still cannot span it.
  const phase23Start = phase2Content.indexOf('### 2.3 Vault Staleness Check');
  const phase23Section = phase23Start !== -1 ? phase2Content.slice(phase23Start) : '';

  it('C0: the SKILL.md Phase 2 stub names Phase 2.3 and routes to the reference file', () => {
    const idx2 = skillContent.indexOf('## Phase 2: Quality Gate');
    const idx25 = skillContent.indexOf('## Phase 2.5:', idx2);
    const stub = skillContent.slice(idx2, idx25);
    expect(stub).toContain('2.3 Vault Staleness Check');
    expect(stub).toContain('references/phase-2-quality-gate.md');
  });

  it('C1: contains "### 2.3 Vault Staleness Check" heading', () => {
    expect(phase23Start).not.toBe(-1);
  });

  it('C2: gate references vault-staleness.enabled', () => {
    expect(phase23Section).toContain('vault-staleness.enabled');
  });

  it('C2: gate references "true" as the expected value', () => {
    // The gate condition should check for "true" (either === true, is true, or is not `true`)
    expect(phase23Section).toMatch(/true/);
  });

  it('C3: all three valid mode values (off, warn, strict) appear in Phase 2.3', () => {
    expect(phase23Section).toContain('off');
    expect(phase23Section).toContain('warn');
    expect(phase23Section).toContain('strict');
  });

  it('C3: the word "hard" does not appear anywhere in Phase 2.3 (#217 canonical fix)', () => {
    // "hard" was replaced by "strict" in issue #217 — must not be present
    expect(phase23Section).not.toMatch(/\bhard\b/);
  });

  it('C3: Phase 2.5 (which legitimately uses the `hard` enum) is NOT in the Phase 2 reference file', () => {
    expect(phase2Content).not.toContain('## Phase 2.5:');
    expect(skillContent).toContain('## Phase 2.5: Custom Phases (#637)');
  });

  it('C4: Phase 2.3 imports vault-staleness.mjs probe', () => {
    expect(phase23Section).toContain('vault-staleness.mjs');
  });

  it('C4: Phase 2.3 imports vault-narrative-staleness.mjs probe', () => {
    expect(phase23Section).toContain('vault-narrative-staleness.mjs');
  });

  it('C4: Phase 2.3 references runProbe for invoking the probes', () => {
    expect(phase23Section).toContain('runProbe');
  });

  it('C5: strict-mode block path mentions AskUserQuestion as the override mechanism', () => {
    expect(phase23Section).toContain('AskUserQuestion');
  });

  it('C6: Phase 2.3 mentions "Deviation" or "Deviations" for the strict-mode override log', () => {
    expect(phase23Section).toMatch(/Deviation/);
  });

  it('C6: Phase 2.3 references STATE.md as the target for the Deviation log entry', () => {
    expect(phase23Section).toContain('STATE.md');
  });
});

// ---------------------------------------------------------------------------
// D — Phase 6 Final Report Docs Health line
// ---------------------------------------------------------------------------

describe('D — Phase 6 Final Report Docs Health line', () => {
  const skillContent = readFileSync(SKILL_PATH, 'utf8');
  // The Session Summary template moved to references/session-summary-template.md
  // (#1157); the Docs Health line lives there, so the whole template file is the
  // section under test.
  const phase6Section = readFileSync(SUMMARY_TEMPLATE_PATH, 'utf8');
  const phase6Start = skillContent.indexOf('## Phase 6:');

  it('D1: Phase 6 section exists', () => {
    expect(phase6Start).not.toBe(-1);
  });

  it('D1: the SKILL.md Phase 6 stub routes to references/session-summary-template.md', () => {
    expect(skillContent.slice(phase6Start)).toContain('references/session-summary-template.md');
  });

  it('D1: Phase 6 Docs Health line contains "Vault staleness"', () => {
    expect(phase6Section).toContain('Vault staleness');
  });

  it('D1: Phase 6 contains the "findings present (warn mode)" rendering case', () => {
    // The spec documents this as the case when findings > 0 in warn mode
    // Look for keywords that identify stale findings output
    expect(phase6Section).toMatch(/stale/i);
  });

  it('D1: Phase 6 contains the "skipped" rendering case (disabled or mode=off)', () => {
    expect(phase6Section).toContain('skipped');
  });

  it('D1: Phase 6 contains the "clean" rendering case', () => {
    expect(phase6Section).toContain('clean');
  });

  it('D1: all three Docs Health render cases (findings/skipped/clean) are covered in one cohesive block', () => {
    // Find the Docs Health line and verify all three case keywords appear in close proximity
    const docsHealthIdx = phase6Section.indexOf('Vault staleness');
    expect(docsHealthIdx).not.toBe(-1);

    // Slice a generous 500-char window around the Vault staleness mention
    const window = phase6Section.slice(docsHealthIdx, docsHealthIdx + 500);
    const hasFindings = /stale|finding/i.test(window);
    const hasSkipped = /skipped/i.test(window);
    const hasClean = /clean/i.test(window);

    expect(hasFindings).toBe(true);
    expect(hasSkipped).toBe(true);
    expect(hasClean).toBe(true);
  });
});
