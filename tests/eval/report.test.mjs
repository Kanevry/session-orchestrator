/**
 * tests/eval/report.test.mjs
 *
 * Unit tests for the aiat-llm-eval HTML run-report renderer (Epic #803, S5):
 *   - scripts/lib/eval/report.mjs — renderEvalReport / writeEvalReport / escapeHtml
 *
 * Coverage:
 *   - Golden-file byte-stability (FA5 core requirement) — same record + same
 *     generatedAt ⇒ byte-identical HTML, pinned against a checked-in fixture.
 *   - Determinism: rendering twice produces identical strings.
 *   - HTML-escaping of attacker-controlled `evidence` text.
 *   - null-KPI → "not recorded" rendering (never faked as 0).
 *   - "What this report does not prove" section is always present.
 *   - Judge dimensions always carry the ADVISORY — uncalibrated label.
 *   - cannot-determine dimensions are counted correctly in the triage block.
 *   - writeEvalReport: happy path (tmp dir) + never-throw fs-error path.
 *
 * NOW-relativity: renderEvalReport takes `generatedAt` as an explicit
 * parameter (no Date.now() read inside the renderer), so every assertion below
 * uses a FIXED literal ('2026-07-16T12:00:00.000Z') without becoming a
 * time-bomb — the value is never compared against the real clock.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderEvalReport, writeEvalReport, escapeHtml, DEFAULT_EVAL_REPORTS_DIR } from '@lib/eval/report.mjs';
import { unwritablePath } from '../_helpers/unwritable-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORDS_DIR = path.resolve(__dirname, '../fixtures/eval/records');
const GOLDEN_DIR = path.resolve(__dirname, '../fixtures/eval/golden');
const FIXED_GENERATED_AT = '2026-07-16T12:00:00.000Z';

function loadRecordFixture(name) {
  return JSON.parse(readFileSync(path.join(RECORDS_DIR, name), 'utf8'));
}

describe('renderEvalReport — golden-file byte-stability (FA5)', () => {
  // FAKE-REGRESSION (executed 2026-07-16): temporarily changed the header
  // "aiat-llm-eval Run Report" title string in scripts/lib/eval/report.mjs to
  // "aiat-llm-eval Run Report!!" and re-ran this suite → this test went RED
  // (byte-length + content mismatch against the checked-in golden file);
  // reverted the change → GREEN again. This proves the golden-file comparison
  // actually bites on renderer drift, not just a smoke assertion.
  it('renders byte-identical HTML against the checked-in golden file', () => {
    const record = loadRecordFixture('valid-session-eval.json');
    const html = renderEvalReport(record, { generatedAt: FIXED_GENERATED_AT });
    const golden = readFileSync(path.join(GOLDEN_DIR, 'report-v1.html'), 'utf8');
    expect(Buffer.from(html, 'utf8')).toEqual(Buffer.from(golden, 'utf8'));
  });
});

describe('renderEvalReport — determinism', () => {
  it('produces identical output across two calls with the same inputs', () => {
    const record = loadRecordFixture('valid-session-eval.json');
    const a = renderEvalReport(record, { generatedAt: FIXED_GENERATED_AT });
    const b = renderEvalReport(record, { generatedAt: FIXED_GENERATED_AT });
    expect(a).toBe(b);
  });
});

describe('renderEvalReport — HTML escaping', () => {
  it('escapes a script tag planted in dimension evidence', () => {
    const record = loadRecordFixture('valid-session-eval.json');
    record.dimensions[0].evidence = '<script>alert(1)</script>';
    const html = renderEvalReport(record, { generatedAt: FIXED_GENERATED_AT });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes HTML-significant characters in model.id', () => {
    const record = loadRecordFixture('valid-session-eval.json');
    record.model.id = '<b>"quoted"</b>';
    const html = renderEvalReport(record, { generatedAt: FIXED_GENERATED_AT });
    expect(html).not.toContain('<b>"quoted"</b>');
    expect(html).toContain('&lt;b&gt;&quot;quoted&quot;&lt;/b&gt;');
  });

  describe('escapeHtml', () => {
    it('escapes all five HTML-significant characters', () => {
      expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
    });

    it('returns an empty string for null/undefined', () => {
      expect(escapeHtml(null)).toBe('');
      expect(escapeHtml(undefined)).toBe('');
    });
  });
});

describe('renderEvalReport — null-KPI rendering ("don\'t fake perfect")', () => {
  it('renders "not recorded" for a null KPI, never 0 or blank', () => {
    const record = loadRecordFixture('valid-session-eval.json');
    record.kpis.token_input = null;
    const html = renderEvalReport(record, { generatedAt: FIXED_GENERATED_AT });
    expect(html).toContain('<th>Token input</th><td>not recorded</td>');
  });

  it('renders "not recorded" for a null provenance field', () => {
    const record = loadRecordFixture('valid-session-eval.json');
    record.provenance.engine_commit = null;
    const html = renderEvalReport(record, { generatedAt: FIXED_GENERATED_AT });
    expect(html).toContain('<th>Engine commit</th><td>not recorded</td>');
  });
});

describe('renderEvalReport — "What this report does not prove" section', () => {
  it('is always present, including for a record with zero dimensions', () => {
    const record = loadRecordFixture('valid-session-eval.json');
    record.dimensions = [];
    const html = renderEvalReport(record, { generatedAt: FIXED_GENERATED_AT });
    expect(html).toContain('What this report does not prove');
    expect(html).toContain('This is a single run (n=1)');
    expect(html).toContain('This run includes no judge dimensions.');
  });
});

describe('renderEvalReport — judge dimension advisory label', () => {
  it('always attaches the ADVISORY — uncalibrated badge to a judge dimension', () => {
    const record = loadRecordFixture('valid-session-eval.json');
    const html = renderEvalReport(record, { generatedAt: FIXED_GENERATED_AT });
    expect(html).toContain('ADVISORY — uncalibrated');
  });

  it('does not attach the advisory badge to a deterministic dimension', () => {
    const record = loadRecordFixture('valid-session-eval.json');
    record.dimensions = [record.dimensions[0]]; // deterministic only
    const html = renderEvalReport(record, { generatedAt: FIXED_GENERATED_AT });
    expect(html).not.toContain('ADVISORY');
  });
});

describe('renderEvalReport — abstention/triage block', () => {
  it('counts cannot-determine dimensions correctly', () => {
    const record = loadRecordFixture('valid-session-eval.json');
    record.dimensions.push({
      id: 'gate-health',
      method: 'deterministic',
      status: 'cannot-determine',
      evidence: 'no CI record found for this session',
    });
    const html = renderEvalReport(record, { generatedAt: FIXED_GENERATED_AT });
    expect(html).toContain('<strong>cannot-determine dimensions:</strong> 1 of 3 (33.3%)');
    expect(html).toContain('no CI record found for this session');
  });
});

describe('writeEvalReport', () => {
  let dir;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('writes <run_id>.html under the target dir and returns { ok:true, path }', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'eval-report-'));
    const record = loadRecordFixture('valid-session-eval.json');
    const result = writeEvalReport(record, { dir, generatedAt: FIXED_GENERATED_AT });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(dir, `${record.run_id}.html`));
    expect(existsSync(result.path)).toBe(true);
    const written = readFileSync(result.path, 'utf8');
    expect(written).toContain('aiat-llm-eval Run Report');
  });

  it('exposes the canonical default reports directory', () => {
    expect(DEFAULT_EVAL_REPORTS_DIR).toBe('.orchestrator/eval/reports');
  });

  // Finding 4 (security-LOW): a run_id carrying path-traversal / separators must
  // be sanitized into a filename that stays INSIDE the target dir. Non-safe chars
  // (including '/') collapse to '_'; the '.' and '-' in the run_id are preserved.
  it('sanitizes a path-traversal run_id so the file stays inside the target dir', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'eval-report-'));
    const record = { ...loadRecordFixture('valid-session-eval.json'), run_id: '../../etc/passwd' };
    const result = writeEvalReport(record, { dir, generatedAt: FIXED_GENERATED_AT });
    expect(result.ok).toBe(true);
    // '../../etc/passwd' → '.._.._etc_passwd' ('/' → '_', '.' preserved).
    expect(result.path).toBe(path.join(dir, '.._.._etc_passwd.html'));
    expect(path.dirname(result.path)).toBe(dir);
    expect(existsSync(result.path)).toBe(true);
  });

  it('never throws on an unwritable target directory — returns { ok:false, reason:"fs-error" }', () => {
    // /dev/null/<sub> yields a fast, uniform ENOTDIR on mkdirSync for every
    // uid (root and non-root alike) — see tests/_helpers/unwritable-path.mjs
    // (#685 root-as-uid-0 hazard: a procfs path HANGS as root instead).
    if (process.platform === 'win32') return; // POSIX-only construct
    const record = loadRecordFixture('valid-session-eval.json');
    const result = writeEvalReport(record, {
      dir: unwritablePath('eval-report'),
      generatedAt: FIXED_GENERATED_AT,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('fs-error');
  });
});
