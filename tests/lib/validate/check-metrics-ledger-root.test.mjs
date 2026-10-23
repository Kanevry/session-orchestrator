/**
 * tests/lib/validate/check-metrics-ledger-root.test.mjs
 *
 * Detection table of the #1722 guard. Each row is a way the guard could lie:
 *   - an unrouted metrics join must be reported, also in a file that calls a
 *     resolver elsewhere (the per-file version missed exactly that: five
 *     readers, review 2026-10-22) and also under skills/;
 *   - a relative constant joined to a root by hand must be reported;
 *   - a resolver on the line or within the lookback window, a `ledger-root:`
 *     marker, a constant declaration and a comment must not be (false
 *     positives = a red validator nobody can fix);
 *   - an allowlisted file passes, and an allowlist entry whose file no longer
 *     builds a metrics path is reported (the list must not rot).
 * The live corpus itself is checked by validate-plugin on every run.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { scanMetricsLedgerRoot } from '../../../scripts/lib/validate/check-metrics-ledger-root.mjs';

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'metrics-ledger-root-'));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  return root;
}

describe('scanMetricsLedgerRoot (#1722)', () => {
  it('reports unrouted lines and constants and stale allowlist entries, and nothing else', () => {
    const root = fixture({
      // a resolver call elsewhere in the file must not excuse line 3
      'scripts/mixed.mjs': [
        "import { resolveLedgerPath } from './ledger-path.mjs';",
        "export const a = (r) => resolveLedgerPath('.orchestrator/metrics/a.jsonl', r);",
        "export const b = (r) => path.join(r, '.orchestrator', 'metrics', 'b.jsonl');",
      ].join('\n'),
      'skills/probe.mjs': "export const p = (r) => join(r, '.orchestrator/metrics/p.jsonl');\n",
      // the segment pair split over two lines (vault-staleness-banner, review 2026-10-22)
      'scripts/split.mjs': ['const p = path.join(', '  repoRoot,', "  '.orchestrator',", "  'metrics',", "  'v.jsonl',", ');'].join('\n'),
      'scripts/consts.mjs': [
        "const DEFAULT_FILE = '.orchestrator/metrics/c.jsonl';",
        'export const bad = (r) => path.join(r, DEFAULT_FILE);',
        'export const good = (r) => resolveLedgerPath(DEFAULT_FILE, r);',
      ].join('\n'),
      'hooks/multiline.mjs': [
        'const p = path.join(',
        '  resolveEventsLedgerRoot(root),',
        "  '.orchestrator', 'metrics', 'sessions.jsonl',",
        ');',
      ].join('\n'),
      'scripts/marked.mjs': "// ledger-root: display string only\nconst relPath = '.orchestrator/metrics/x.jsonl';\n",
      'scripts/comment.mjs': "// writes .orchestrator/metrics/x.jsonl via the store\n * also '.orchestrator/metrics' in a doc line\nexport const n = 1;\n",
      'scripts/local.mjs': "export const cache = (r) => r + '/' + '.orchestrator/metrics/cache.jsonl';\n",
      'scripts/gone.mjs': 'export const n = 2;\n',
      'scripts/x.test.mjs': "const p = join(r, '.orchestrator/metrics/t.jsonl');\n",
    });
    const r = scanMetricsLedgerRoot({
      pluginRoot: root,
      allowlist: { 'scripts/local.mjs': 'cache of this tree', 'scripts/gone.mjs': 'was a sink once' },
    });

    expect(r.ok).toBe(false);
    const got = r.findings.map((f) => `${f.kind} ${f.file}:${f.line}`).sort();
    expect(got).toEqual([
      'stale-allowlist scripts/gone.mjs:0',
      'unrouted scripts/mixed.mjs:3',
      'unrouted scripts/split.mjs:3',
      'unrouted skills/probe.mjs:1',
      'unrouted-constant scripts/consts.mjs:2',
    ]);
    expect(r.summary).toMatchObject({ resolved: 2, constants: 1, marked: 1, allowlisted: 1 });
  });
});
