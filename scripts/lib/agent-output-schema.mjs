/**
 * agent-output-schema.mjs — Runtime validation seam for agent JSON outputs.
 *
 * Issue #417 — JSON-schema-per-agent-output contract.
 *
 * Each agent MAY declare an `output-schema:` field in its YAML frontmatter
 * pointing at a JSON Schema 2020-12 file under `agents/schemas/`. This module
 * loads the schema lazily, extracts the LAST fenced ```json block from the
 * agent's raw return text (mirrors the session-reviewer.md:168-183 pattern),
 * parses it, and validates against the schema using AJV 2020.
 *
 * Backward-compat: agents without `output-schema:` return
 * `{ ok: true, parsed: null, mode: 'unvalidated' }`.
 *
 * Design notes:
 *   - AJV is lazy-imported via `import('ajv/dist/2020.js')` so plugin startup
 *     does not pay for it when no validation is requested.
 *   - Schema compile results are cached per-process in a `Map<agentName, validate>`.
 *   - Never throws. All failure modes are reported via the structured result
 *     object's `mode` discriminator.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAjv2020 } from './ajv-loader.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/lib → repo root → agents/schemas/
const SCHEMAS_DIR = join(__dirname, '..', '..', 'agents', 'schemas');

// Per-process compile cache: agentName → AJV ValidateFunction
const compileCache = new Map();

const getAjv = getAjv2020;

/**
 * Load and parse the JSON schema for a given agent.
 *
 * @param {string} agentName - Agent name (e.g. "code-implementer"), without extension.
 * @returns {Promise<object|null>} Parsed schema object, or null if schema file absent.
 */
const AGENT_NAME_RE = /^[a-z0-9-]+$/;

export async function loadAgentSchema(agentName) {
  if (typeof agentName !== 'string' || agentName === '') return null;
  if (!AGENT_NAME_RE.test(agentName)) return null;
  const schemaPath = join(SCHEMAS_DIR, `${agentName}.schema.json`);
  let raw;
  try {
    raw = await readFile(schemaPath, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Extract the LAST fenced ```json block from a raw text body.
 * Mirrors the session-reviewer.md:168-183 contract — when an agent's output
 * contains multiple json blocks (prose example + final summary), the trailing
 * block is the machine-readable summary.
 *
 * @param {string} raw
 * @returns {{ found: boolean, json?: string }}
 */
export function extractLastJsonBlock(raw) {
  if (typeof raw !== 'string' || raw === '') return { found: false };
  // Match ```json ... ``` non-greedy across newlines. Capture the body.
  const re = /```json\s*\n([\s\S]*?)\n```/g;
  let match;
  let last = null;
  while ((match = re.exec(raw)) !== null) {
    last = match[1];
  }
  if (last === null) return { found: false };
  return { found: true, json: last };
}

/**
 * Validate an agent's raw output against its declared schema.
 *
 * @param {object} args
 * @param {string} args.agentName - Agent name (matches schemas/<name>.schema.json).
 * @param {string} args.raw       - Raw agent return text (may contain prose + fenced blocks).
 * @returns {Promise<{
 *   ok: boolean,
 *   parsed?: object|null,
 *   errors?: Array<object>,
 *   mode: 'validated'|'unvalidated'|'parse-error'|'schema-error'
 * }>}
 */
export async function validateAgentOutput({ agentName, raw }) {
  // 1. Load schema (or signal unvalidated mode for backward-compat).
  const schema = await loadAgentSchema(agentName);
  if (schema === null) {
    return { ok: true, parsed: null, mode: 'unvalidated' };
  }

  // 2. Extract last JSON block.
  const extracted = extractLastJsonBlock(raw);
  if (!extracted.found) {
    return {
      ok: false,
      parsed: null,
      mode: 'parse-error',
      errors: [{ message: 'No fenced ```json block found in agent output' }],
    };
  }

  // 3. Parse JSON.
  let parsed;
  try {
    parsed = JSON.parse(extracted.json);
  } catch (err) {
    return {
      ok: false,
      parsed: null,
      mode: 'parse-error',
      errors: [{ message: `JSON parse failed: ${err.message}` }],
    };
  }

  // 4. Compile (or fetch cached) AJV validator.
  let validate = compileCache.get(agentName);
  if (validate === undefined) {
    try {
      const ajv = await getAjv();
      validate = ajv.compile(schema);
      compileCache.set(agentName, validate);
    } catch (err) {
      return {
        ok: false,
        parsed,
        mode: 'schema-error',
        errors: [{ message: `Schema compile failed: ${err.message}` }],
      };
    }
  }

  // 5. Validate.
  const valid = validate(parsed);
  if (!valid) {
    return {
      ok: false,
      parsed,
      mode: 'validated',
      errors: validate.errors ?? [],
    };
  }
  return { ok: true, parsed, mode: 'validated' };
}

/**
 * Clear the per-process compile cache. Test-only hook.
 */
export function _clearCompileCache() {
  compileCache.clear();
}
