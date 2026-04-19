/**
 * tests/scripts/export-hw-learnings.test.mjs
 *
 * Vitest suite for scripts/export-hw-learnings.mjs (Sub-Epic #160 / #172).
 *
 * Covers: anonymization (paths/emails/tokens/authors), bucketing, filtering
 * (only hardware-pattern AND scope:public), rendering determinism, and the
 * redaction audit requirement from the acceptance criteria ("zero hostnames,
 * paths, emails").
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anonymizeString,
  anonymizeLearning,
  bucketRamGb,
  bucketCpuPct,
  groupByHost,
  renderMarkdown,
  exportHwLearnings,
} from '../../scripts/export-hw-learnings.mjs';

const GENERATED_AT = '2026-04-19T14:00:00Z';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const baseLearning = (overrides = {}) => ({
  id: `hw-${overrides.id ?? '1'}`,
  type: 'hardware-pattern',
  subject: overrides.subject ?? 'oom-kill::macos-arm64-m3pro',
  insight: overrides.insight ?? 'Plain text insight.',
  evidence: overrides.evidence ?? 'signal=oom-kill, occurrences=3',
  confidence: 0.6,
  source_session: 'some-session-id',
  created_at: '2026-04-18T10:00:00Z',
  expires_at: '2026-05-18T10:00:00Z',
  scope: 'public',
  host_class: overrides.host_class ?? 'macos-arm64-m3pro',
  anonymized: true,
  anonymization_version: 1,
  ...overrides,
});

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hw-export-'));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Anonymization — strings
// ---------------------------------------------------------------------------

describe('anonymizeString', () => {
  it('redacts macOS absolute paths', () => {
    const s = 'Failure at /Users/alice/Projects/foo/bar.js was observed';
    expect(anonymizeString(s)).not.toMatch(/\/Users\//);
    expect(anonymizeString(s)).toContain('<redacted-path>');
  });

  it('redacts Linux absolute paths', () => {
    const s = 'Location: /home/bob/code/app';
    expect(anonymizeString(s)).not.toMatch(/\/home\//);
  });

  it('redacts Windows drive-letter paths', () => {
    const s = 'Found at C:\\Users\\charlie\\Dev\\project';
    expect(anonymizeString(s)).not.toMatch(/C:\\Users/);
  });

  it('redacts emails', () => {
    const s = 'reported by alice@example.com';
    expect(anonymizeString(s)).not.toMatch(/@example\.com/);
    expect(anonymizeString(s)).toContain('<redacted-email>');
  });

  it('redacts git-author patterns', () => {
    const s = 'Committed by: Alice Bob <alice@example.com>';
    expect(anonymizeString(s)).not.toMatch(/Alice Bob/);
  });

  it('redacts Signed-off-by lines', () => {
    const s = 'Signed-off-by: Alice <alice@example.com>';
    expect(anonymizeString(s)).toContain('<redacted-signoff>');
  });

  it('redacts long token-shape strings', () => {
    const token = 'abcDEF1234ghi567jklMNO0pq';
    const s = `auth=${token} in header`;
    expect(anonymizeString(s)).not.toContain(token);
    expect(anonymizeString(s)).toContain('<redacted-token>');
  });

  it('passes through ordinary prose unchanged', () => {
    const s = 'System ran low on memory during wave execution.';
    expect(anonymizeString(s)).toBe(s);
  });

  it('is safe on non-string input', () => {
    expect(anonymizeString(42)).toBe(42);
    expect(anonymizeString(null)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

describe('bucketing', () => {
  it('rounds RAM to nearest 1 GB', () => {
    expect(bucketRamGb(7.2)).toBe(7);
    expect(bucketRamGb(7.6)).toBe(8);
    expect(bucketRamGb(16)).toBe(16);
  });

  it('rounds CPU to nearest 10%', () => {
    expect(bucketCpuPct(87)).toBe(90);
    expect(bucketCpuPct(84)).toBe(80);
    expect(bucketCpuPct(95)).toBe(100);
    expect(bucketCpuPct(0)).toBe(0);
  });

  it('returns null on invalid input', () => {
    expect(bucketRamGb('ten')).toBe(null);
    expect(bucketCpuPct(undefined)).toBe(null);
    expect(bucketRamGb(NaN)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// anonymizeLearning — entry-level
// ---------------------------------------------------------------------------

describe('anonymizeLearning', () => {
  it('strips source_session (host-correlated)', () => {
    const a = anonymizeLearning(baseLearning());
    expect(a).not.toHaveProperty('source_session');
  });

  it('scrubs insight and evidence free-form fields', () => {
    const a = anonymizeLearning(
      baseLearning({ insight: 'Crashed in /Users/alice/app.js', evidence: 'By bob@example.com' })
    );
    expect(a.insight).not.toMatch(/\/Users\//);
    expect(a.evidence).not.toMatch(/@example\.com/);
  });

  it('buckets samples[].ram_free_gb and cpu_load_pct', () => {
    const a = anonymizeLearning({
      ...baseLearning(),
      samples: [{ ram_free_gb: 2.9, cpu_load_pct: 87, exit_code: 137 }],
    });
    expect(a.samples[0].ram_free_gb).toBe(3);
    expect(a.samples[0].cpu_load_pct).toBe(90);
    expect(a.samples[0].exit_code).toBe(137);
  });

  it('preserves host_class, scope, anonymized flag', () => {
    const a = anonymizeLearning(baseLearning({ host_class: 'linux-x86_64' }));
    expect(a.host_class).toBe('linux-x86_64');
    expect(a.scope).toBe('public');
    expect(a.anonymized).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// groupByHost
// ---------------------------------------------------------------------------

describe('groupByHost', () => {
  it('groups entries by host_class', () => {
    const g = groupByHost([
      baseLearning({ id: '1', host_class: 'macos-arm64-m3pro', subject: 'oom-kill::macos-arm64-m3pro' }),
      baseLearning({ id: '2', host_class: 'macos-arm64-m3pro', subject: 'thermal-throttle::macos-arm64-m3pro' }),
      baseLearning({ id: '3', host_class: 'linux-x86_64', subject: 'oom-kill::linux-x86_64' }),
    ]);
    expect(g.size).toBe(2);
    expect(g.get('macos-arm64-m3pro').report_count).toBe(2);
    expect(g.get('linux-x86_64').report_count).toBe(1);
  });

  it('subdivides per signal inside each host', () => {
    const g = groupByHost([
      baseLearning({ id: '1', subject: 'oom-kill::macos-arm64-m3pro' }),
      baseLearning({ id: '2', subject: 'oom-kill::macos-arm64-m3pro' }),
      baseLearning({ id: '3', subject: 'thermal-throttle::macos-arm64-m3pro' }),
    ]);
    const host = g.get('macos-arm64-m3pro');
    expect(Array.from(host.signals.keys()).sort()).toEqual(['oom-kill', 'thermal-throttle']);
    expect(host.signals.get('oom-kill').items.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// renderMarkdown — determinism + "no content" handling
// ---------------------------------------------------------------------------

describe('renderMarkdown', () => {
  it('is deterministic across equal inputs (alphabetical ordering)', () => {
    const input = [
      baseLearning({ id: '1', host_class: 'linux-x86_64', subject: 'oom-kill::linux-x86_64' }),
      baseLearning({ id: '2', host_class: 'macos-arm64-m3pro', subject: 'oom-kill::macos-arm64-m3pro' }),
    ];
    const g = groupByHost(input);
    expect(renderMarkdown(g, GENERATED_AT)).toBe(renderMarkdown(g, GENERATED_AT));
  });

  it('alphabetizes hosts within the document', () => {
    const input = [
      baseLearning({ id: '1', host_class: 'zzz-test-host', subject: 'oom-kill::zzz-test-host' }),
      baseLearning({ id: '2', host_class: 'aaa-test-host', subject: 'oom-kill::aaa-test-host' }),
    ];
    const md = renderMarkdown(groupByHost(input), GENERATED_AT);
    expect(md.indexOf('aaa-test-host')).toBeLessThan(md.indexOf('zzz-test-host'));
  });

  it('emits the "no reports" placeholder when empty', () => {
    const md = renderMarkdown(new Map(), GENERATED_AT);
    expect(md).toContain('_No public hardware-pattern learnings to report._');
  });
});

// ---------------------------------------------------------------------------
// Redaction audit — the acceptance criterion
// ---------------------------------------------------------------------------

describe('redaction audit', () => {
  it('generated doc contains zero hostnames, paths, emails', async () => {
    const input = join(tmp, 'learnings.jsonl');
    const output = join(tmp, 'hardware-patterns.md');
    const entries = [
      baseLearning({
        id: '1',
        insight: 'Host alice-macbook.local hit OOM at /Users/alice/code/app.js by alice@example.com',
        evidence: 'signal=oom-kill, host=/Users/alice, occurrences=3',
      }),
      baseLearning({
        id: '2',
        host_class: 'linux-x86_64',
        subject: 'disk-full::linux-x86_64',
        insight: 'Signed-off-by: Bob <bob@example.com> — disk full on /home/bob/data',
      }),
    ];
    writeFileSync(input, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

    await exportHwLearnings({ input, output, dryRun: false, generatedAt: GENERATED_AT });
    const doc = readFileSync(output, 'utf8');

    expect(doc).not.toMatch(/\/Users\//);
    expect(doc).not.toMatch(/\/home\//);
    expect(doc).not.toMatch(/@example\.com/);
    expect(doc).not.toMatch(/alice-macbook/);
    expect(doc).not.toMatch(/Bob <bob/);
    expect(doc).toContain('<redacted-');
  });
});

// ---------------------------------------------------------------------------
// Filtering — only hardware-pattern AND scope=public
// ---------------------------------------------------------------------------

describe('filtering', () => {
  it('excludes non-hardware-pattern types', async () => {
    const input = join(tmp, 'learnings.jsonl');
    const entries = [
      { ...baseLearning({ id: '1' }) },
      { ...baseLearning({ id: '2' }), type: 'fragile-file' },
    ];
    writeFileSync(input, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const r = await exportHwLearnings({ input, output: join(tmp, 'out.md'), dryRun: true, generatedAt: GENERATED_AT });
    expect(r.count).toBe(1);
  });

  it('excludes scope=local and scope=private', async () => {
    const input = join(tmp, 'learnings.jsonl');
    const entries = [
      { ...baseLearning({ id: '1' }) }, // scope=public
      { ...baseLearning({ id: '2' }), scope: 'local', anonymized: false }, // scope=local
      { ...baseLearning({ id: '3' }), scope: 'private', anonymized: false }, // scope=private
    ];
    writeFileSync(input, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const r = await exportHwLearnings({ input, output: join(tmp, 'out.md'), dryRun: true, generatedAt: GENERATED_AT });
    expect(r.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  it('running twice produces identical output (given same generated-at)', async () => {
    const input = join(tmp, 'learnings.jsonl');
    const output = join(tmp, 'out.md');
    writeFileSync(input, JSON.stringify(baseLearning()) + '\n');
    await exportHwLearnings({ input, output, dryRun: false, generatedAt: GENERATED_AT });
    const first = readFileSync(output, 'utf8');
    await exportHwLearnings({ input, output, dryRun: false, generatedAt: GENERATED_AT });
    const second = readFileSync(output, 'utf8');
    expect(second).toBe(first);
  });

  it('creates parent directory if missing', async () => {
    const input = join(tmp, 'learnings.jsonl');
    const output = join(tmp, 'nested', 'deep', 'out.md');
    writeFileSync(input, JSON.stringify(baseLearning()) + '\n');
    await exportHwLearnings({ input, output, dryRun: false, generatedAt: GENERATED_AT });
    expect(existsSync(output)).toBe(true);
  });
});
