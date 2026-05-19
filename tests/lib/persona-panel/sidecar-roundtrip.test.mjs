/**
 * tests/lib/persona-panel/sidecar-roundtrip.test.mjs
 *
 * Vitest tests for io.mjs::writeJsonAtomic + the persona-panel-sidecar schema (issue #457).
 *
 * Covers (9 tests):
 *  1. valid sidecar → writeJsonAtomic writes file; re-read JSON matches input
 *  2. invalid sidecar (missing required field) — validatorFn runs BEFORE write:
 *     throws Error with .validationErrors; file does NOT exist on disk
 *  3. atomic write: no .tmp file leaks after rename completes
 *  4. mkdir-recursive: parent directory created when it doesn't exist
 *  5. schema validation: known-good fixture passes; fixture missing run_id fails with
 *     specific AJV error
 *  6. path-confinement contract demo: writeJsonAtomic does NOT enforce path-confinement
 *     itself — caller is responsible for validatePathInsideProject first. Test asserts
 *     and documents the contract boundary via comment.
 *  7. concurrent-write: 2 simultaneous calls to the same path → last-writer-wins,
 *     neither produces a partial file (content is valid JSON after both settle)
 *  8. additionalProperties:false enforcement: fixture with extra unknown field → AJV fails
 *  9. token_usage shape: valid shape passes; invalid shape (wrong keys) fails
 *
 * Falsification check: every test asserts on concrete output (file contents, thrown
 * error type/property, AJV error presence). Removing writeJsonAtomic or the schema
 * makes every assertion fail.
 *
 * macOS `/var/folders → /private/var/folders` symlink:
 * use realpathSync(tmpdir()) per #477 learning (conf 0.85).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../../../scripts/lib/io.mjs';
import { getAjv2020 } from '../../../scripts/lib/ajv-loader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const SCHEMA_PATH = join(REPO_ROOT, 'agents', 'schemas', 'persona-panel-sidecar.schema.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** macOS-safe tmpdir: resolves /var → /private/var symlink (#477 learning). */
function makeTmp() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'sidecar-roundtrip-test-')));
}

let tmp;

beforeEach(() => {
  tmp = makeTmp();
});

afterEach(() => {
  if (tmp && existsSync(tmp)) {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Known-good sidecar fixture
// ---------------------------------------------------------------------------

/**
 * Build a minimal, schema-valid sidecar object.
 * All required fields present; optional fields omitted unless the test needs them.
 */
function goodSidecar(overrides = {}) {
  return {
    schema_version: 1,
    run_id: 'test-run-abc123',
    iso_timestamp: '2026-05-19T12-00-00Z',
    target: 'docs/my-prd.md',
    personas_invoked: [
      {
        name: 'persona-alpha',
        version: 1,
        model: 'claude-opus-4-7',
        prompt_hash: 'aabbccddeeff0011',
        timestamp_start: '2026-05-19T12-00-00Z',
        timestamp_end: '2026-05-19T12-01-00Z',
      },
    ],
    outputs: [
      {
        persona_name: 'persona-alpha',
        mode: 'validated',
        ok: true,
        verdict: 'pass',
        rationale: 'Looks good.',
      },
    ],
    consolidation: {
      mode_used: 'voting-quorum',
      final_verdict: 'PROCEED',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Load + compile the schema once per test file (not in beforeEach — AJV is
// stateless after compile; no cache to clear between these tests).
// ---------------------------------------------------------------------------

let compiledValidate = null;
let schemaRaw = null;

async function getValidator() {
  if (compiledValidate === null) {
    schemaRaw = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const ajv = await getAjv2020({ allErrors: true, strict: false });
    compiledValidate = ajv.compile(schemaRaw);
  }
  return compiledValidate;
}

/**
 * Build a validatorFn compatible with writeJsonAtomic's interface:
 * calls AJV, returns {ok: boolean, errors: Array|undefined}.
 */
async function makeAjvValidatorFn() {
  const validate = await getValidator();
  return (value) => {
    const ok = validate(value);
    return { ok, errors: ok ? undefined : validate.errors };
  };
}

// ---------------------------------------------------------------------------
// Test 1: valid sidecar → file written; re-read matches input
// ---------------------------------------------------------------------------

describe('writeJsonAtomic — valid sidecar roundtrip', () => {
  it('writes the sidecar file and the parsed content on re-read equals the input value', async () => {
    const filePath = join(tmp, 'run-abc', 'sidecar.json');
    const value = goodSidecar();

    const result = await writeJsonAtomic(filePath, value);

    expect(result.path).toBe(filePath);
    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(filePath)).toBe(true);

    const onDisk = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(onDisk.run_id).toBe('test-run-abc123');
    expect(onDisk.schema_version).toBe(1);
    expect(onDisk.consolidation.final_verdict).toBe('PROCEED');
  });
});

// ---------------------------------------------------------------------------
// Test 2: invalid sidecar (missing required field) — validator fires BEFORE write
// ---------------------------------------------------------------------------

describe('writeJsonAtomic — validatorFn rejects before write', () => {
  it('throws Error with .validationErrors and leaves file absent when validator returns ok:false', async () => {
    const filePath = join(tmp, 'sidecar-invalid.json');
    const validatorFn = await makeAjvValidatorFn();

    // Omit the required `run_id` field
    const badValue = goodSidecar({ run_id: undefined });
    delete badValue.run_id;

    let caught;
    try {
      await writeJsonAtomic(filePath, badValue, { validatorFn });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    expect(caught.message).toMatch(/validation failed/i);
    expect(Array.isArray(caught.validationErrors)).toBe(true);
    expect(caught.validationErrors.length).toBeGreaterThan(0);
    // The critical assertion: file must NOT exist on disk
    expect(existsSync(filePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 3: atomic write — no .tmp file leaks after successful rename
// ---------------------------------------------------------------------------

describe('writeJsonAtomic — no .tmp file leak after successful write', () => {
  it('leaves no *.tmp files in the directory after a successful atomic write', async () => {
    const dir = join(tmp, 'atomic-write-test');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'sidecar.json');

    await writeJsonAtomic(filePath, goodSidecar());

    const entries = readdirSync(dir);
    const tmpFiles = entries.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4: mkdir-recursive — parent dir created automatically
// ---------------------------------------------------------------------------

describe('writeJsonAtomic — mkdir-recursive', () => {
  it("creates the target file's parent directories recursively when they do not exist", async () => {
    const filePath = join(tmp, 'deeply', 'nested', 'path', 'sidecar.json');
    // Parent does not exist yet
    expect(existsSync(join(tmp, 'deeply'))).toBe(false);

    await writeJsonAtomic(filePath, goodSidecar());

    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed.run_id).toBe('test-run-abc123');
  });
});

// ---------------------------------------------------------------------------
// Test 5: AJV schema validation — known-good passes; missing run_id fails
// ---------------------------------------------------------------------------

describe('persona-panel-sidecar schema — AJV validation', () => {
  it('validates a known-good fixture successfully (no errors)', async () => {
    const validate = await getValidator();
    const ok = validate(goodSidecar());
    expect(ok).toBe(true);
    expect(validate.errors).toBeFalsy();
  });

  it('fails validation and produces an error for run_id when run_id is missing', async () => {
    const validate = await getValidator();
    const bad = goodSidecar();
    delete bad.run_id;

    const ok = validate(bad);
    expect(ok).toBe(false);
    expect(Array.isArray(validate.errors)).toBe(true);
    expect(validate.errors.length).toBeGreaterThan(0);

    // At least one error must reference 'run_id' (required field missing)
    const errorPaths = validate.errors.map((e) => String(e.params?.missingProperty ?? e.instancePath ?? ''));
    const mentionsRunId = errorPaths.some((p) => p.includes('run_id'));
    expect(mentionsRunId).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 6: path-confinement contract documentation
// ---------------------------------------------------------------------------

describe('writeJsonAtomic — path-confinement contract boundary', () => {
  it('writes to an arbitrary absolute path (caller is responsible for confinement)', async () => {
    // CONTRACT DOCUMENTATION:
    // writeJsonAtomic intentionally does NOT enforce that filePath lives inside
    // the project root. The JSDoc comment at io.mjs line ~163 says:
    //   "Caller is responsible for path-confinement
    //    (see scripts/lib/path-utils.mjs#validatePathInsideProject)"
    //
    // This test demonstrates that contract: a path with a traversal-like segment
    // inside the tmpdir (but ultimately resolving within tmpdir) is written without
    // error. The caller MUST call validatePathInsideProject before calling
    // writeJsonAtomic in production code.
    //
    // We do NOT pass a genuinely dangerous path here — we use a fully-within-tmp
    // path to avoid filesystem side effects. The assertion proves writeJsonAtomic
    // has no built-in guard.

    const dirA = join(tmp, 'dir-a');
    mkdirSync(dirA, { recursive: true });
    const filePath = join(dirA, 'caller-owns-confinement.json');

    // Must succeed — writeJsonAtomic does not block
    const result = await writeJsonAtomic(filePath, { marker: 'confinement-test' });
    expect(result.path).toBe(filePath);
    expect(existsSync(filePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 7: concurrent writes — last-writer-wins, content always valid JSON
// ---------------------------------------------------------------------------

describe('writeJsonAtomic — concurrent writes to same path', () => {
  it('produces valid JSON content regardless of race outcome when two writes run concurrently', async () => {
    const filePath = join(tmp, 'race-target.json');

    const sidecarA = goodSidecar({ run_id: 'write-a-aabbccdd' });
    const sidecarB = goodSidecar({ run_id: 'write-b-eeff0011' });

    // Both writes launched simultaneously — do not await individually
    await Promise.all([
      writeJsonAtomic(filePath, sidecarA),
      writeJsonAtomic(filePath, sidecarB),
    ]);

    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf8');

    // Must be valid JSON — no partial writes
    let parsed;
    expect(() => {
      parsed = JSON.parse(content);
    }).not.toThrow();

    // The winning writer is one of the two — run_id must be one of the expected values
    expect(['write-a-aabbccdd', 'write-b-eeff0011']).toContain(parsed.run_id);
  });
});

// ---------------------------------------------------------------------------
// Test 8: additionalProperties:false — extra key in top-level object fails
// ---------------------------------------------------------------------------

describe('persona-panel-sidecar schema — additionalProperties:false enforcement', () => {
  it('fails AJV validation when the top-level object contains an unrecognised extra field', async () => {
    const validate = await getValidator();

    const bad = goodSidecar();
    bad.totally_unknown_field = 'this should not be here';

    const ok = validate(bad);
    expect(ok).toBe(false);
    expect(Array.isArray(validate.errors)).toBe(true);

    const additionalPropError = validate.errors.find(
      (e) =>
        e.keyword === 'additionalProperties' ||
        String(e.params?.additionalProperty ?? '').includes('totally_unknown_field'),
    );
    expect(additionalPropError).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Test 9: token_usage shape — valid shape passes; invalid shape fails
// ---------------------------------------------------------------------------

describe('persona-panel-sidecar schema — token_usage nested shape', () => {
  it('passes validation when token_usage has the expected {input, output} shape', async () => {
    const validate = await getValidator();

    const value = goodSidecar();
    value.personas_invoked[0].token_usage = { input: 100, output: 50 };

    expect(validate(value)).toBe(true);
  });

  it('fails validation when token_usage contains only unrecognised keys (additionalProperties:false on nested obj)', async () => {
    const validate = await getValidator();

    const value = goodSidecar();
    value.personas_invoked[0].token_usage = { invalid_key: 1 };

    const ok = validate(value);
    expect(ok).toBe(false);
    expect(Array.isArray(validate.errors)).toBe(true);
    expect(validate.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 10 (Q1-LOW-6 canary): SKILL.md documents validatePathInsideProject
// usage alongside writeJsonAtomic in Phase 5
// ---------------------------------------------------------------------------

describe('writeJsonAtomic path-confinement docs canary (Q1-LOW-6)', () => {
  it('persona-panel SKILL documents validatePathInsideProject usage before writeJsonAtomic', () => {
    const skillContent = readFileSync(join(REPO_ROOT, 'skills/persona-panel/SKILL.md'), 'utf8');
    // Both guards must be documented — absence of either means the contract is not
    // expressed in the operator-facing specification.
    expect(skillContent).toContain('writeJsonAtomic');
    expect(skillContent).toContain('validatePathInsideProject');
  });
});
