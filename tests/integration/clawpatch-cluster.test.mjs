/**
 * tests/integration/clawpatch-cluster.test.mjs
 *
 * High-value end-to-end integration test for the Clawpatch Borrow Cluster.
 *
 * Verifies that the language-mapper pipeline can process a real production
 * source file (scripts/lib/agent-output-schema.mjs) and return a known set
 * of top-level exports.  This is the "consumer-side" smoke test requested
 * in the W4-T1 task brief:
 *
 *   extractSemanticSlices(...) on agent-output-schema.mjs source
 *   → validates known exports list
 *
 * W4-T1 — Clawpatch Borrow Cluster deep-2 integration coverage.
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

const AGENT_OUTPUT_SCHEMA_PATH = path.join(
  REPO_ROOT,
  'scripts',
  'lib',
  'agent-output-schema.mjs',
);

const INDEX_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'language-mappers', 'index.mjs');

// ---------------------------------------------------------------------------
// End-to-end: extractSemanticSlices on a real production .mjs file
// ---------------------------------------------------------------------------

describe('clawpatch-cluster integration — extractSemanticSlices on agent-output-schema.mjs', () => {
  it('returns a slice array with at least 3 items (known exports in the file)', async () => {
    const { extractSemanticSlices } = await import(INDEX_PATH + `?t=${Date.now()}`);
    const content = await readFile(AGENT_OUTPUT_SCHEMA_PATH, 'utf8');

    const slices = await extractSemanticSlices(AGENT_OUTPUT_SCHEMA_PATH, content);

    // The file declares 4 named exports:
    //   loadAgentSchema, extractLastJsonBlock, validateAgentOutput, _clearCompileCache
    // The mapper should find at least 3 of these as function slices.
    expect(Array.isArray(slices)).toBe(true);
    // Floor/ceiling per test-quality.md "Dynamic Artifact Counts" rule
    expect(slices.length).toBeGreaterThanOrEqual(3);
    expect(slices.length).toBeLessThanOrEqual(30);
  });

  it('finds loadAgentSchema as an exported function slice', async () => {
    const { extractSemanticSlices } = await import(INDEX_PATH + `?t=${Date.now()}`);
    const content = await readFile(AGENT_OUTPUT_SCHEMA_PATH, 'utf8');

    const slices = await extractSemanticSlices(AGENT_OUTPUT_SCHEMA_PATH, content);

    const loadAgentSchemaSlice = slices.find(
      (s) => s.kind === 'function' && s.name === 'loadAgentSchema',
    );
    expect(loadAgentSchemaSlice).toBeDefined();
    expect(loadAgentSchemaSlice.exported).toBe(true);
    expect(loadAgentSchemaSlice.file).toBe(AGENT_OUTPUT_SCHEMA_PATH);
    // line number must be a positive integer
    expect(typeof loadAgentSchemaSlice.line).toBe('number');
    expect(loadAgentSchemaSlice.line).toBeGreaterThan(0);
  });

  it('finds extractLastJsonBlock as an exported function slice', async () => {
    const { extractSemanticSlices } = await import(INDEX_PATH + `?t=${Date.now()}`);
    const content = await readFile(AGENT_OUTPUT_SCHEMA_PATH, 'utf8');

    const slices = await extractSemanticSlices(AGENT_OUTPUT_SCHEMA_PATH, content);

    const extractSlice = slices.find(
      (s) => s.kind === 'function' && s.name === 'extractLastJsonBlock',
    );
    expect(extractSlice).toBeDefined();
    expect(extractSlice.exported).toBe(true);
  });

  it('finds validateAgentOutput as an exported function slice', async () => {
    const { extractSemanticSlices } = await import(INDEX_PATH + `?t=${Date.now()}`);
    const content = await readFile(AGENT_OUTPUT_SCHEMA_PATH, 'utf8');

    const slices = await extractSemanticSlices(AGENT_OUTPUT_SCHEMA_PATH, content);

    const validateSlice = slices.find(
      (s) => s.kind === 'function' && s.name === 'validateAgentOutput',
    );
    expect(validateSlice).toBeDefined();
    expect(validateSlice.exported).toBe(true);
  });

  it('all returned slices have the required SemanticSlice shape fields', async () => {
    const { extractSemanticSlices } = await import(INDEX_PATH + `?t=${Date.now()}`);
    const content = await readFile(AGENT_OUTPUT_SCHEMA_PATH, 'utf8');

    const slices = await extractSemanticSlices(AGENT_OUTPUT_SCHEMA_PATH, content);

    for (const slice of slices) {
      // Required fields per the SemanticSlice typedef
      expect(typeof slice.kind).toBe('string');
      expect(typeof slice.name).toBe('string');
      expect(slice.name.length).toBeGreaterThan(0);
      expect(typeof slice.file).toBe('string');
      expect(typeof slice.line).toBe('number');
      expect(typeof slice.endLine).toBe('number');
      expect(typeof slice.exported).toBe('boolean');
      expect(typeof slice.isNested).toBe('boolean');
      // endLine must be >= line
      expect(slice.endLine).toBeGreaterThanOrEqual(slice.line);
    }
  });

  it('returned slices only contain SLICE_KINDS values', async () => {
    const sut = await import(INDEX_PATH + `?t=${Date.now()}`);
    const { extractSemanticSlices, SLICE_KINDS } = sut;
    const content = await readFile(AGENT_OUTPUT_SCHEMA_PATH, 'utf8');

    const slices = await extractSemanticSlices(AGENT_OUTPUT_SCHEMA_PATH, content);

    for (const slice of slices) {
      expect(SLICE_KINDS).toContain(slice.kind);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: pipeline integration — schema validation + language mapping
// ---------------------------------------------------------------------------

describe('clawpatch-cluster integration — validateAgentOutput round-trip', () => {
  it('returns mode=validated + ok=true for a complete test-writer output block', async () => {
    const { validateAgentOutput, _clearCompileCache } = await import(
      path.join(REPO_ROOT, 'scripts', 'lib', 'agent-output-schema.mjs') + `?t=${Date.now()}`
    );
    _clearCompileCache();

    const raw = [
      '## test-writer — W4-T1',
      '',
      'Added 45 new tests across 8 files.',
      '',
      '```json',
      JSON.stringify({
        status: 'done',
        task_id: 'W4-T1',
        files_changed: [
          { path: 'tests/unit/agent-output-schema.test.mjs', tests_added: 12 },
          { path: 'tests/unit/sandbox-tier.test.mjs', tests_added: 8 },
        ],
        blockers: [],
      }),
      '```',
    ].join('\n');

    const result = await validateAgentOutput({ agentName: 'test-writer', raw });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('validated');
    expect(result.parsed.status).toBe('done');
    expect(result.parsed.task_id).toBe('W4-T1');
    expect(result.parsed.files_changed).toHaveLength(2);
    expect(result.parsed.blockers).toHaveLength(0);
  });
});
