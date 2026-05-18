/**
 * tests/unit/agent-schemas-extended.test.mjs
 *
 * Vitest suite for the 7 new agent JSON schemas added in issue #449.
 * Covers:
 *   - analyst, architect-reviewer, qa-strategist, security-reviewer
 *   - session-reviewer, docs-writer, ux-evaluator
 *
 * Per-schema tests:
 *   1. Schema file exists + parses as valid JSON
 *   2. validateAgentOutput() returns {mode: 'validated', ok: true} for valid output
 *   3. validateAgentOutput() returns {mode: 'validated', ok: false} for missing required field
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { loadAgentSchema, validateAgentOutput, _clearCompileCache } from '@lib/agent-output-schema.mjs';

// =============================================================================
// analyst
// =============================================================================

describe('analyst schema', () => {
  beforeEach(() => { _clearCompileCache(); });

  it('schema file exists and parses as valid JSON-Schema-2020-12', async () => {
    const schema = await loadAgentSchema('analyst');
    expect(schema).not.toBeNull();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('https://session-orchestrator.dev/agents/analyst.schema.json');
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('verdict');
    expect(schema.required).toContain('finding_counts');
  });

  it('validates a correct analyst output', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED',
        report_path: '.orchestrator/audits/wave-reviewer-2-analyst.md',
        finding_counts: { high: 0, med: 1, low: 2 },
        scope_drift_count: 0,
        criteria_reviewed: 8,
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'analyst', raw });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('validated');
  });

  it('rejects analyst output missing required field (report_path)', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED',
        finding_counts: { high: 0, med: 0, low: 0 },
        scope_drift_count: 0,
        criteria_reviewed: 3,
        // report_path intentionally omitted
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'analyst', raw });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('validated');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects analyst output with invalid verdict enum', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'OK', // not in enum
        report_path: '.orchestrator/audits/wave-reviewer-2-analyst.md',
        finding_counts: { high: 0, med: 0, low: 0 },
        scope_drift_count: 0,
        criteria_reviewed: 5,
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'analyst', raw });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('validated');
  });
});

// =============================================================================
// architect-reviewer
// =============================================================================

describe('architect-reviewer schema', () => {
  beforeEach(() => { _clearCompileCache(); });

  it('schema file exists and parses as valid JSON-Schema-2020-12', async () => {
    const schema = await loadAgentSchema('architect-reviewer');
    expect(schema).not.toBeNull();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('https://session-orchestrator.dev/agents/architect-reviewer.schema.json');
    expect(schema.required).toContain('verdict');
    expect(schema.required).toContain('files_reviewed');
  });

  it('validates a correct architect-reviewer output', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED_WITH_FOLLOWUPS',
        report_path: '.orchestrator/audits/wave-reviewer-3-architect-reviewer.md',
        finding_counts: { high: 0, med: 1, low: 1 },
        files_reviewed: 6,
        adrs_checked: 2,
        language_md_checked: true,
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'architect-reviewer', raw });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('validated');
  });

  it('rejects architect-reviewer output missing required field (finding_counts)', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED',
        report_path: '.orchestrator/audits/wave-reviewer-3-architect-reviewer.md',
        files_reviewed: 4,
        // finding_counts intentionally omitted
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'architect-reviewer', raw });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('validated');
  });
});

// =============================================================================
// qa-strategist
// =============================================================================

describe('qa-strategist schema', () => {
  beforeEach(() => { _clearCompileCache(); });

  it('schema file exists and parses as valid JSON-Schema-2020-12', async () => {
    const schema = await loadAgentSchema('qa-strategist');
    expect(schema).not.toBeNull();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('https://session-orchestrator.dev/agents/qa-strategist.schema.json');
    expect(schema.required).toContain('verdict');
    expect(schema.required).toContain('gap_counts');
    expect(schema.required).toContain('source_files_reviewed');
    expect(schema.required).toContain('test_files_reviewed');
  });

  it('validates a correct qa-strategist output', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'FIX_REQUIRED',
        report_path: '.orchestrator/audits/wave-reviewer-4-qa-strategist.md',
        gap_counts: { high: 2, med: 1, low: 0 },
        source_files_reviewed: 5,
        test_files_reviewed: 3,
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'qa-strategist', raw });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('validated');
  });

  it('rejects qa-strategist output missing required field (source_files_reviewed)', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED',
        report_path: '.orchestrator/audits/wave-reviewer-4-qa-strategist.md',
        gap_counts: { high: 0, med: 0, low: 0 },
        test_files_reviewed: 2,
        // source_files_reviewed intentionally omitted
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'qa-strategist', raw });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('validated');
  });
});

// =============================================================================
// security-reviewer
// =============================================================================

describe('security-reviewer schema', () => {
  beforeEach(() => { _clearCompileCache(); });

  it('schema file exists and parses as valid JSON-Schema-2020-12', async () => {
    const schema = await loadAgentSchema('security-reviewer');
    expect(schema).not.toBeNull();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('https://session-orchestrator.dev/agents/security-reviewer.schema.json');
    expect(schema.required).toContain('verdict');
    expect(schema.required).toContain('phases');
    expect(schema.required).toContain('files_reviewed');
  });

  it('validates a correct security-reviewer output (no findings)', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED',
        finding_counts: { high: 0, med: 0, low: 0 },
        files_reviewed: 7,
        phases: { context: true, comparative: true, assessment: true },
        findings: [],
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'security-reviewer', raw });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('validated');
  });

  it('validates a security-reviewer output with findings', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'FIX_REQUIRED',
        finding_counts: { high: 1, med: 0, low: 0 },
        files_reviewed: 4,
        phases: { context: true, comparative: true, assessment: true },
        findings: [
          {
            severity: 'HIGH',
            category: 'sql_injection',
            file: 'src/services/search.ts:42',
            confidence: 0.95,
            title: 'Unparameterized user input in search query',
          },
        ],
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'security-reviewer', raw });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('validated');
  });

  it('rejects security-reviewer output missing required field (phases)', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED',
        finding_counts: { high: 0, med: 0, low: 0 },
        files_reviewed: 3,
        // phases intentionally omitted
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'security-reviewer', raw });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('validated');
  });

  it('rejects finding with confidence below 0.7', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED_WITH_FOLLOWUPS',
        finding_counts: { high: 0, med: 1, low: 0 },
        files_reviewed: 2,
        phases: { context: true, comparative: true, assessment: true },
        findings: [
          {
            severity: 'MEDIUM',
            category: 'path_traversal',
            file: 'src/utils/file.ts:15',
            confidence: 0.5, // below 0.7 minimum
            title: 'Potential path traversal',
          },
        ],
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'security-reviewer', raw });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('validated');
  });
});

// =============================================================================
// session-reviewer
// =============================================================================

describe('session-reviewer schema', () => {
  beforeEach(() => { _clearCompileCache(); });

  it('schema file exists and parses as valid JSON-Schema-2020-12', async () => {
    const schema = await loadAgentSchema('session-reviewer');
    expect(schema).not.toBeNull();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('https://session-orchestrator.dev/agents/session-reviewer.schema.json');
    expect(schema.required).toContain('verdict');
    expect(schema.required).toContain('total_findings');
    expect(schema.required).toContain('categories');
    expect(schema.required).toContain('fix_required');
  });

  it('validates a correct session-reviewer output (PROCEED)', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED',
        total_findings: 0,
        high_confidence: 0,
        categories: {
          implementation: 'PASS',
          tests: 'PASS',
          typescript: 'PASS',
          security: 'PASS',
        },
        fix_required: [],
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'session-reviewer', raw });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('validated');
  });

  it('validates session-reviewer output with extended categories (silent_failures, test_depth, type_design)', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED_WITH_FOLLOWUPS',
        total_findings: 2,
        high_confidence: 1,
        categories: {
          implementation: 'PASS',
          tests: 'WARN',
          typescript: 'PASS',
          security: 'PASS',
          silent_failures: 'WARN',
          test_depth: 'WARN',
          type_design: 'PASS',
        },
        fix_required: [],
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'session-reviewer', raw });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('validated');
  });

  it('rejects session-reviewer output missing required field (categories)', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED',
        total_findings: 0,
        high_confidence: 0,
        fix_required: [],
        // categories intentionally omitted
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'session-reviewer', raw });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('validated');
  });

  it('rejects session-reviewer output with invalid typescript category value (WARN not in PASS|FAIL)', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED',
        total_findings: 0,
        high_confidence: 0,
        categories: {
          implementation: 'PASS',
          tests: 'PASS',
          typescript: 'WARN', // only PASS|FAIL allowed for typescript
          security: 'PASS',
        },
        fix_required: [],
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'session-reviewer', raw });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('validated');
  });
});

// =============================================================================
// docs-writer
// =============================================================================

describe('docs-writer schema', () => {
  beforeEach(() => { _clearCompileCache(); });

  it('schema file exists and parses as valid JSON-Schema-2020-12', async () => {
    const schema = await loadAgentSchema('docs-writer');
    expect(schema).not.toBeNull();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('https://session-orchestrator.dev/agents/docs-writer.schema.json');
    expect(schema.required).toContain('verdict');
    expect(schema.required).toContain('status');
    expect(schema.required).toContain('files_updated');
  });

  it('validates a correct docs-writer output', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED',
        status: 'done',
        files_updated: [
          { path: 'README.md', audience: 'user', sections: ['Installation', 'Configuration'] },
          { path: 'CLAUDE.md', audience: 'dev', sections: ['Current State'] },
        ],
        review_markers_added: 0,
        notes: '',
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'docs-writer', raw });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('validated');
  });

  it('validates docs-writer output with empty files_updated (no docs needed)', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED',
        status: 'done',
        files_updated: [],
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'docs-writer', raw });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('validated');
  });

  it('rejects docs-writer output missing required field (status)', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED',
        files_updated: [],
        // status intentionally omitted
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'docs-writer', raw });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('validated');
  });

  it('rejects docs-writer output with invalid audience value', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED',
        status: 'done',
        files_updated: [
          { path: 'README.md', audience: 'admin' }, // not in enum user|dev|vault
        ],
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'docs-writer', raw });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('validated');
  });
});

// =============================================================================
// ux-evaluator
// =============================================================================

describe('ux-evaluator schema', () => {
  beforeEach(() => { _clearCompileCache(); });

  it('schema file exists and parses as valid JSON-Schema-2020-12', async () => {
    const schema = await loadAgentSchema('ux-evaluator');
    expect(schema).not.toBeNull();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('https://session-orchestrator.dev/agents/ux-evaluator.schema.json');
    expect(schema.required).toContain('verdict');
    expect(schema.required).toContain('run_id');
    expect(schema.required).toContain('rubric_version');
    expect(schema.required).toContain('findings_count');
    expect(schema.required).toContain('findings_path');
  });

  it('validates a correct ux-evaluator output (zero findings)', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED',
        run_id: '12345-1715688000123',
        rubric_version: 'v1',
        checks_applied: 4,
        findings_count: 0,
        findings_path: '/abs/path/.orchestrator/metrics/test-runs/12345-1715688000123/findings.jsonl',
        severity_counts: { critical: 0, high: 0, medium: 0, low: 0 },
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'ux-evaluator', raw });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('validated');
  });

  it('validates ux-evaluator output with findings (FIX_REQUIRED)', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'FIX_REQUIRED',
        run_id: '99999-1715688000000',
        rubric_version: 'v1',
        checks_applied: 3,
        findings_count: 2,
        findings_path: '/abs/path/.orchestrator/metrics/test-runs/99999-1715688000000/findings.jsonl',
        severity_counts: { critical: 1, high: 1, medium: 0, low: 0 },
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'ux-evaluator', raw });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('validated');
  });

  it('rejects ux-evaluator output missing required field (findings_path)', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED',
        run_id: '12345-1715688000123',
        rubric_version: 'v1',
        checks_applied: 4,
        findings_count: 0,
        // findings_path intentionally omitted
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'ux-evaluator', raw });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('validated');
  });

  it('rejects ux-evaluator output with invalid verdict', async () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PASS', // not in enum
        run_id: '12345-1715688000123',
        rubric_version: 'v1',
        checks_applied: 4,
        findings_count: 0,
        findings_path: '/abs/path/findings.jsonl',
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'ux-evaluator', raw });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('validated');
  });
});
