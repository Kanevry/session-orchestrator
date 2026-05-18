/**
 * tests/unit/wave-loop-schema-validation.test.mjs
 *
 * Vitest suite for wave-executor's validateAgentOutput wiring (issue #451).
 *
 * Tests the feature-flag logic that controls whether schema validation runs
 * after each agent completes in a wave, and how violations are handled under
 * the different `enforce` modes (warn | strict | off).
 *
 * NOTE: This suite tests the LOGIC of the wave-loop integration layer, not
 * the underlying validateAgentOutput internals (those live in
 * agent-output-schema.test.mjs). The integration seam is mocked so these
 * tests exercise wave-loop behaviour without needing real agent schemas.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Inline simulation of the wave-loop integration logic
//
// The actual wave-loop is a Markdown skill document (not a JS module), so we
// inline the integration contract here as a pure function that tests can call.
// This is the same pattern used by pool.mjs — the "real" coordinator will call
// validateAgentOutput inline after each agent completes; these tests verify
// the branching logic independently.
// ---------------------------------------------------------------------------

/**
 * Simulate wave-loop post-agent validation logic.
 *
 * @param {object} opts
 * @param {object}   opts.sessionConfig   - The session config block.
 * @param {object[]} opts.agentResults    - Array of { agentName, raw } objects.
 * @param {Function} opts.validateFn      - Injected validateAgentOutput (for mocking).
 * @returns {Promise<{
 *   records: Array<object>,      // annotated agent records
 *   blockingViolations: Array<object>  // non-empty only when enforce=strict
 * }>}
 */
async function runWaveSchemaValidation({ sessionConfig, agentResults, validateFn }) {
  const cfg = sessionConfig?.['output-schema-validation'] ?? {};
  const enabled = cfg.enabled === true;
  const enforce = cfg.enforce ?? 'warn';

  const records = [];
  const blockingViolations = [];

  for (const { agentName, raw } of agentResults) {
    const record = { agentName };

    if (!enabled) {
      // Feature flag OFF — no validation, no schema_status field on the record.
      records.push(record);
      continue;
    }

    const result = await validateFn({ agentName, raw });

    if (result.mode === 'unvalidated') {
      // Agent has no output-schema declaration — silent skip (backward-compat).
      records.push(record);
      continue;
    }

    if (result.mode === 'parse-error') {
      // No fenced JSON block or malformed JSON — log warning, do NOT block.
      record.schema_warning = `parse-error: ${result.errors?.[0]?.message ?? 'unknown'}`;
      records.push(record);
      continue;
    }

    // mode === 'validated'
    if (result.ok) {
      record.schema_status = 'ok';
    } else {
      record.schema_violation = true;
      record.schema_errors = result.errors ?? [];

      if (enforce === 'strict') {
        blockingViolations.push({ agentName, errors: result.errors });
      }
      // enforce === 'warn': annotate record, continue (no blocking)
      // enforce === 'off': still record schema_violation for observability when ok=false
    }

    records.push(record);
  }

  return { records, blockingViolations };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wave-loop schema validation integration', () => {
  let validateFn;

  beforeEach(() => {
    validateFn = vi.fn();
  });

  // -------------------------------------------------------------------------
  // 1. Feature flag OFF (default) — no validation, no schema_status
  // -------------------------------------------------------------------------
  it('skips validation entirely when output-schema-validation.enabled is false (default)', async () => {
    const sessionConfig = {}; // no output-schema-validation key → defaults to disabled
    const agentResults = [{ agentName: 'code-implementer', raw: '```json\n{}\n```' }];

    const { records, blockingViolations } = await runWaveSchemaValidation({
      sessionConfig,
      agentResults,
      validateFn,
    });

    expect(validateFn).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty('schema_status');
    expect(records[0]).not.toHaveProperty('schema_violation');
    expect(blockingViolations).toHaveLength(0);
  });

  it('skips validation when enabled is explicitly false', async () => {
    const sessionConfig = { 'output-schema-validation': { enabled: false, enforce: 'warn' } };
    const agentResults = [{ agentName: 'test-writer', raw: '```json\n{}\n```' }];

    const { records } = await runWaveSchemaValidation({
      sessionConfig,
      agentResults,
      validateFn,
    });

    expect(validateFn).not.toHaveBeenCalled();
    expect(records[0]).not.toHaveProperty('schema_status');
  });

  // -------------------------------------------------------------------------
  // 2. Feature flag ON + agent with schema + valid output → schema_status: 'ok'
  // -------------------------------------------------------------------------
  it('sets schema_status:ok on record when agent output passes validation', async () => {
    validateFn.mockResolvedValue({ ok: true, parsed: { status: 'done' }, mode: 'validated' });

    const sessionConfig = { 'output-schema-validation': { enabled: true, enforce: 'warn' } };
    const agentResults = [{ agentName: 'code-implementer', raw: '```json\n{"status":"done"}\n```' }];

    const { records, blockingViolations } = await runWaveSchemaValidation({
      sessionConfig,
      agentResults,
      validateFn,
    });

    expect(validateFn).toHaveBeenCalledOnce();
    expect(validateFn).toHaveBeenCalledWith({
      agentName: 'code-implementer',
      raw: '```json\n{"status":"done"}\n```',
    });
    expect(records[0].schema_status).toBe('ok');
    expect(records[0]).not.toHaveProperty('schema_violation');
    expect(blockingViolations).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 3. Feature flag ON + agent with schema + invalid output + enforce=warn
  //    → schema_violation:true but wave is NOT blocked
  // -------------------------------------------------------------------------
  it('annotates schema_violation:true but does not block under enforce:warn', async () => {
    const schemaErrors = [{ instancePath: '/status', message: 'must be equal to one of the allowed values' }];
    validateFn.mockResolvedValue({
      ok: false,
      parsed: { status: 'finished' },
      mode: 'validated',
      errors: schemaErrors,
    });

    const sessionConfig = { 'output-schema-validation': { enabled: true, enforce: 'warn' } };
    const agentResults = [{ agentName: 'code-implementer', raw: '```json\n{"status":"finished"}\n```' }];

    const { records, blockingViolations } = await runWaveSchemaValidation({
      sessionConfig,
      agentResults,
      validateFn,
    });

    expect(records[0].schema_violation).toBe(true);
    expect(records[0].schema_errors).toEqual(schemaErrors);
    expect(records[0]).not.toHaveProperty('schema_status');
    // Wave must NOT be blocked under warn mode
    expect(blockingViolations).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 4. Feature flag ON + agent with schema + invalid output + enforce=strict
  //    → wave-blocking signal returned
  // -------------------------------------------------------------------------
  it('returns wave-blocking violation under enforce:strict when output is invalid', async () => {
    const schemaErrors = [{ instancePath: '/blockers', message: 'must be array' }];
    validateFn.mockResolvedValue({
      ok: false,
      parsed: { status: 'done', task_id: 'X' },
      mode: 'validated',
      errors: schemaErrors,
    });

    const sessionConfig = { 'output-schema-validation': { enabled: true, enforce: 'strict' } };
    const agentResults = [{ agentName: 'db-specialist', raw: '```json\n{}\n```' }];

    const { records, blockingViolations } = await runWaveSchemaValidation({
      sessionConfig,
      agentResults,
      validateFn,
    });

    // Record is still annotated
    expect(records[0].schema_violation).toBe(true);
    expect(records[0].schema_errors).toEqual(schemaErrors);

    // Blocking violation surface
    expect(blockingViolations).toHaveLength(1);
    expect(blockingViolations[0].agentName).toBe('db-specialist');
    expect(blockingViolations[0].errors).toEqual(schemaErrors);
  });

  it('does not block when output is valid under enforce:strict', async () => {
    validateFn.mockResolvedValue({ ok: true, parsed: {}, mode: 'validated' });

    const sessionConfig = { 'output-schema-validation': { enabled: true, enforce: 'strict' } };
    const agentResults = [{ agentName: 'code-implementer', raw: '```json\n{}\n```' }];

    const { records, blockingViolations } = await runWaveSchemaValidation({
      sessionConfig,
      agentResults,
      validateFn,
    });

    expect(records[0].schema_status).toBe('ok');
    expect(blockingViolations).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5. Feature flag ON + agent WITHOUT schema (mode: 'unvalidated') → silent skip
  // -------------------------------------------------------------------------
  it('silently skips agents without a declared schema (mode:unvalidated backward-compat)', async () => {
    validateFn.mockResolvedValue({ ok: true, parsed: null, mode: 'unvalidated' });

    const sessionConfig = { 'output-schema-validation': { enabled: true, enforce: 'warn' } };
    // agent-without-schema is one of the 7 agents not yet enrolled in #417
    const agentResults = [{ agentName: 'agent-without-schema', raw: 'Some prose output' }];

    const { records, blockingViolations } = await runWaveSchemaValidation({
      sessionConfig,
      agentResults,
      validateFn,
    });

    expect(validateFn).toHaveBeenCalledOnce();
    // Record carries no schema_status or schema_violation — silent skip
    expect(records[0]).not.toHaveProperty('schema_status');
    expect(records[0]).not.toHaveProperty('schema_violation');
    expect(records[0]).not.toHaveProperty('schema_warning');
    expect(blockingViolations).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 6. parse-error mode → warning logged, wave not blocked
  // -------------------------------------------------------------------------
  it('logs a warning on parse-error mode without blocking the wave', async () => {
    validateFn.mockResolvedValue({
      ok: false,
      parsed: null,
      mode: 'parse-error',
      errors: [{ message: 'No fenced ```json block found in agent output' }],
    });

    const sessionConfig = { 'output-schema-validation': { enabled: true, enforce: 'warn' } };
    const agentResults = [{ agentName: 'code-implementer', raw: 'Just prose, no JSON.' }];

    const { records, blockingViolations } = await runWaveSchemaValidation({
      sessionConfig,
      agentResults,
      validateFn,
    });

    expect(records[0]).toHaveProperty('schema_warning');
    expect(records[0].schema_warning).toMatch(/parse-error/);
    expect(records[0]).not.toHaveProperty('schema_violation');
    expect(blockingViolations).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 7. Multiple agents in one wave — mixed validation outcomes
  // -------------------------------------------------------------------------
  it('processes multiple agents per wave with independent validation results', async () => {
    validateFn
      .mockResolvedValueOnce({ ok: true, parsed: {}, mode: 'validated' }) // agent 1
      .mockResolvedValueOnce({ ok: false, parsed: {}, mode: 'validated', errors: [{ message: 'x' }] }) // agent 2
      .mockResolvedValueOnce({ ok: true, parsed: null, mode: 'unvalidated' }); // agent 3

    const sessionConfig = { 'output-schema-validation': { enabled: true, enforce: 'warn' } };
    const agentResults = [
      { agentName: 'code-implementer', raw: 'r1' },
      { agentName: 'test-writer', raw: 'r2' },
      { agentName: 'no-schema-agent', raw: 'r3' },
    ];

    const { records, blockingViolations } = await runWaveSchemaValidation({
      sessionConfig,
      agentResults,
      validateFn,
    });

    expect(records).toHaveLength(3);
    expect(records[0].schema_status).toBe('ok');
    expect(records[1].schema_violation).toBe(true);
    expect(records[2]).not.toHaveProperty('schema_status');
    expect(records[2]).not.toHaveProperty('schema_violation');
    expect(blockingViolations).toHaveLength(0); // enforce=warn → no blocking
  });
});
