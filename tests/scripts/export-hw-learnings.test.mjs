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
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
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
  promoteHwLearnings,
} from '../../scripts/export-hw-learnings.mjs';
import { CURRENT_ANONYMIZATION_VERSION } from '@lib/learnings.mjs';

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

// ---------------------------------------------------------------------------
// Part A — Expanded regex coverage
// ---------------------------------------------------------------------------

describe('anonymizeString — Linux system paths', () => {
  it('redacts /root paths', () => {
    const s = 'Config loaded from /root/.config/app/settings.json';
    expect(anonymizeString(s)).not.toMatch(/\/root\//);
    expect(anonymizeString(s)).toContain('<redacted-path>');
  });

  it('redacts /var paths', () => {
    const s = 'Log written to /var/log/session-orchestrator/run.log';
    expect(anonymizeString(s)).not.toMatch(/\/var\//);
    expect(anonymizeString(s)).toContain('<redacted-path>');
  });

  it('redacts /opt paths', () => {
    const s = 'Binary at /opt/homebrew/bin/node crashed';
    expect(anonymizeString(s)).not.toMatch(/\/opt\//);
    expect(anonymizeString(s)).toContain('<redacted-path>');
  });

  it('redacts /tmp paths', () => {
    const s = 'Temp file: /tmp/so-wt-abc123/output.json';
    expect(anonymizeString(s)).not.toMatch(/\/tmp\//);
    expect(anonymizeString(s)).toContain('<redacted-path>');
  });

  it('redacts /mnt paths', () => {
    const s = 'Mounted at /mnt/data/projects';
    expect(anonymizeString(s)).not.toMatch(/\/mnt\//);
    expect(anonymizeString(s)).toContain('<redacted-path>');
  });

  it('redacts /srv paths', () => {
    const s = 'Served from /srv/www/app/public';
    expect(anonymizeString(s)).not.toMatch(/\/srv\//);
    expect(anonymizeString(s)).toContain('<redacted-path>');
  });

  it('redacts /etc paths', () => {
    const s = 'Config at /etc/hosts was modified';
    expect(anonymizeString(s)).not.toMatch(/\/etc\//);
    expect(anonymizeString(s)).toContain('<redacted-path>');
  });

  it('redacts /usr paths', () => {
    const s = 'Library in /usr/local/lib/node_modules/vitest';
    expect(anonymizeString(s)).not.toMatch(/\/usr\//);
    expect(anonymizeString(s)).toContain('<redacted-path>');
  });
});

describe('anonymizeString — Windows paths with spaces', () => {
  it('redacts Windows backslash paths with spaces', () => {
    const s = 'Installed at C:\\Program Files\\MyApp\\bin\\app.exe';
    expect(anonymizeString(s)).not.toMatch(/Program Files/);
    expect(anonymizeString(s)).toContain('<redacted-path>');
  });

  it('redacts Windows forward-slash normalized paths', () => {
    const s = 'Found at C:/Users/foo/bar/project/src/index.js';
    expect(anonymizeString(s)).not.toMatch(/C:\/Users/);
    expect(anonymizeString(s)).toContain('<redacted-path>');
  });
});

describe('anonymizeString — IPv4 addresses', () => {
  it('redacts 192.168.x.x private addresses', () => {
    const s = 'Connected to 192.168.1.1 via LAN';
    expect(anonymizeString(s)).not.toMatch(/192\.168\./);
    expect(anonymizeString(s)).toContain('<IP>');
  });

  it('redacts 10.x.x.x private addresses', () => {
    const s = 'Server at 10.0.0.1 responded';
    expect(anonymizeString(s)).not.toMatch(/10\.0\.0\.1/);
    expect(anonymizeString(s)).toContain('<IP>');
  });

  it('redacts loopback 127.0.0.1', () => {
    const s = 'Bound to 127.0.0.1:8080';
    expect(anonymizeString(s)).not.toMatch(/127\.0\.0\.1/);
    expect(anonymizeString(s)).toContain('<IP>');
  });

  it('redacts public routable addresses', () => {
    const s = 'Origin IP: 203.0.113.42 flagged';
    expect(anonymizeString(s)).not.toMatch(/203\.0\.113\.42/);
    expect(anonymizeString(s)).toContain('<IP>');
  });
});

describe('anonymizeString — GitHub/GitLab VCS URLs', () => {
  it('redacts github.com org/repo URLs', () => {
    const s = 'See https://github.com/alice/private-repo for reference';
    expect(anonymizeString(s)).not.toMatch(/github\.com\/alice/);
    expect(anonymizeString(s)).toContain('<VCS-URL>');
  });

  it('redacts gitlab.com org/repo URLs', () => {
    const s = 'MR at https://gitlab.com/myorg/my-project/merge_requests/42';
    expect(anonymizeString(s)).not.toMatch(/gitlab\.com\/myorg/);
    expect(anonymizeString(s)).toContain('<VCS-URL>');
  });

  it('redacts self-hosted GitLab URLs', () => {
    const s = 'Push to https://gitlab.gotzendorfer.at/user/repo';
    expect(anonymizeString(s)).not.toMatch(/gotzendorfer\.at\/user/);
    expect(anonymizeString(s)).toContain('<VCS-URL>');
  });
});

// ---------------------------------------------------------------------------
// Part B — anonymizeLearning stamps anonymized + version
// ---------------------------------------------------------------------------

describe('anonymizeLearning — metadata stamping', () => {
  it('stamps anonymized: true on the output', () => {
    // Even when entry has anonymized: false (private entry pre-promotion)
    const entry = baseLearning({ scope: 'private', anonymized: false });
    delete entry.anonymization_version;
    const a = anonymizeLearning(entry);
    expect(a.anonymized).toBe(true);
  });

  it('stamps anonymization_version equal to CURRENT_ANONYMIZATION_VERSION', () => {
    const a = anonymizeLearning(baseLearning());
    expect(a.anonymization_version).toBe(CURRENT_ANONYMIZATION_VERSION);
  });

  it('overwrites a stale anonymization_version', () => {
    const a = anonymizeLearning(baseLearning({ anonymization_version: 0 }));
    expect(a.anonymization_version).toBe(CURRENT_ANONYMIZATION_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Part C — Promotion pipeline
// ---------------------------------------------------------------------------

/** Build a minimal private hardware-pattern learning suitable for promotion. */
const privateHwLearning = (overrides = {}) => ({
  id: `priv-${overrides.id ?? '1'}`,
  type: 'hardware-pattern',
  subject: overrides.subject ?? 'oom-kill::linux-x86_64',
  insight: overrides.insight ?? 'OOM kill observed during wave execution.',
  evidence: overrides.evidence ?? 'signal=oom-kill, occurrences=2',
  confidence: 0.5,
  source_session: 'session-abc-2026-04-19',
  created_at: '2026-04-19T10:00:00Z',
  expires_at: '2026-05-19T10:00:00Z',
  scope: 'private',
  host_class: overrides.host_class ?? 'linux-x86_64',
  anonymized: false,
  ...overrides,
});

describe('promoteHwLearnings', () => {
  it('promotes 2 private entries → 2 new public entries, originals preserved', async () => {
    const input = join(tmp, 'learnings.jsonl');
    const e1 = privateHwLearning({ id: '1', subject: 'oom-kill::linux-x86_64' });
    const e2 = privateHwLearning({ id: '2', subject: 'disk-full::linux-x86_64' });
    writeFileSync(input, [e1, e2].map((e) => JSON.stringify(e)).join('\n') + '\n');

    const result = await promoteHwLearnings({ input, dryRun: false });

    expect(result.promoted).toBe(2);
    expect(result.skipped).toBe(0);

    // Read back and verify
    const fileContent = readFileSync(input, 'utf8');
    const lines = fileContent.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4); // 2 originals + 2 public twins

    const privates = lines.filter((l) => l.scope === 'private');
    const publics = lines.filter((l) => l.scope === 'public');
    expect(privates).toHaveLength(2);
    expect(publics).toHaveLength(2);

    // Public twins must pass the privacy contract
    for (const pub of publics) {
      expect(pub.anonymized).toBe(true);
      expect(pub.anonymization_version).toBe(CURRENT_ANONYMIZATION_VERSION);
      expect(pub.host_class).toBeTruthy();
    }
  });

  it('creates a backup file before writing', async () => {
    const input = join(tmp, 'learnings.jsonl');
    writeFileSync(input, JSON.stringify(privateHwLearning()) + '\n');

    await promoteHwLearnings({ input, dryRun: false });

    const files = readdirSync(tmp);
    const backups = files.filter((f) => f.startsWith('learnings.jsonl.bak-'));
    expect(backups).toHaveLength(1);
  });

  it('dry-run: does not mutate learnings.jsonl', async () => {
    const input = join(tmp, 'learnings.jsonl');
    const original = JSON.stringify(privateHwLearning()) + '\n';
    writeFileSync(input, original);

    await promoteHwLearnings({ input, dryRun: true });

    expect(readFileSync(input, 'utf8')).toBe(original);
  });

  it('dry-run: does not create a backup file', async () => {
    const input = join(tmp, 'learnings.jsonl');
    writeFileSync(input, JSON.stringify(privateHwLearning()) + '\n');

    await promoteHwLearnings({ input, dryRun: true });

    const files = readdirSync(tmp);
    const backups = files.filter((f) => f.startsWith('learnings.jsonl.bak-'));
    expect(backups).toHaveLength(0);
  });

  it('skips already-public entries (counts them in skipped)', async () => {
    const input = join(tmp, 'learnings.jsonl');
    const pub = baseLearning({ id: 'pub1' }); // scope=public
    const priv = privateHwLearning({ id: 'priv1' });
    writeFileSync(input, [pub, priv].map((e) => JSON.stringify(e)).join('\n') + '\n');

    const result = await promoteHwLearnings({ input, dryRun: false });

    expect(result.promoted).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('no-op when no private hardware-pattern entries exist', async () => {
    const input = join(tmp, 'learnings.jsonl');
    writeFileSync(input, JSON.stringify(baseLearning()) + '\n'); // already public

    const result = await promoteHwLearnings({ input, dryRun: false });

    expect(result.promoted).toBe(0);
    expect(result.skipped).toBe(1);
    // No backup should be created (nothing written)
    const files = readdirSync(tmp);
    const backups = files.filter((f) => f.startsWith('learnings.jsonl.bak-'));
    expect(backups).toHaveLength(0);
  });

  it('contract-violating entry (missing host_class) throws before any write', async () => {
    const input = join(tmp, 'learnings.jsonl');
    const bad = privateHwLearning({ id: 'bad1', host_class: null });
    writeFileSync(input, JSON.stringify(bad) + '\n');
    const original = readFileSync(input, 'utf8');

    await expect(promoteHwLearnings({ input, dryRun: false })).rejects.toThrow();

    // learnings.jsonl must be untouched
    expect(readFileSync(input, 'utf8')).toBe(original);
  });

  it('promoted entries have insight/evidence redacted', async () => {
    const input = join(tmp, 'learnings.jsonl');
    const e = privateHwLearning({
      id: 'pii1',
      insight: 'OOM at /home/alice/code/project on 192.168.1.10',
      evidence: 'by alice@example.com via https://github.com/alice/repo',
    });
    writeFileSync(input, JSON.stringify(e) + '\n');

    await promoteHwLearnings({ input, dryRun: false });

    const lines = readFileSync(input, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const pub = lines.find((l) => l.scope === 'public');
    expect(pub).toBeTruthy();
    expect(pub.insight).not.toMatch(/\/home\//);
    expect(pub.insight).not.toMatch(/192\.168\./);
    expect(pub.evidence).not.toMatch(/@example\.com/);
    expect(pub.evidence).not.toMatch(/github\.com\/alice/);
  });

  it('returns flags when learnings.jsonl contains malformed lines', async () => {
    const input = join(tmp, 'learnings.jsonl');
    writeFileSync(input, 'not-json\n' + JSON.stringify(privateHwLearning()) + '\n');

    const result = await promoteHwLearnings({ input, dryRun: true });

    expect(result.flags.some((f) => f.includes('malformed'))).toBe(true);
  });
});
