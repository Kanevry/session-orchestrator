/**
 * catalog-loader.mjs — Load + validate persona specs for /persona-panel (#457).
 *
 * Discovers `.claude/personas/*.md` files, parses their YAML frontmatter under
 * the explicit js-yaml CORE_SCHEMA (W1-D4 L1 — disables YAML 1.1 type
 * extensions such as `!!js/function` / `!!js/regexp`), validates them against
 * the persona-spec rules, and returns a Map keyed by persona `name`.
 *
 * Module-level pure functions; mirrors triage-state.mjs shape. Filesystem I/O
 * is concentrated inside `loadCatalog` / `loadPersona` — every other exported
 * function is pure and side-effect-free.
 *
 * ── Security guards baked in ─────────────────────────────────────────────────
 *
 * H1 (path traversal):
 *   - Personas root is resolved relative to the project root and pinned via
 *     `validatePathInsideProject` before any read.
 *   - File names are matched against a strict glob `<safe-name>.md` derived
 *     from `SAFE_PERSONA_NAME_RE`.
 *   - Symlinks are rejected at read time via `lstat` (L3).
 *
 * H2 (model allowlist):
 *   - `model` field validated via ALLOWED_MODEL_ALIASES ∪ MODEL_ID_RE imported
 *     directly from `agent-frontmatter.mjs` — single source of truth.
 *
 * H3 (output_contract structural pre-check):
 *   - `preCheckOutputContract` rejects `$ref`, `$defs`, `definitions`, `allOf`,
 *     `anyOf`, `oneOf`, `not`, and unknown root keys. Operator-authored
 *     schemas must be plain object schemas; combinators and refs are
 *     attack-surface for untrusted YAML.
 *
 * L1: explicit CORE_SCHEMA.
 * L3: symlink rejection.
 * L4: additionalProperties:false-equivalent — unknown frontmatter keys fail
 *     loading.
 *
 * Duplicate `name` across two persona files → DuplicateNameError with both
 * source paths (last-writer-wins would silently shadow whichever file the
 * filesystem enumeration returned second).
 */

import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';

import { findProjectRoot } from '../common.mjs';
import { validatePathInsideProject } from '../path-utils.mjs';
import { ALLOWED_MODEL_ALIASES, MODEL_ID_RE } from '../agent-frontmatter.mjs';

// ---------------------------------------------------------------------------
// Persona-name and frontmatter constants
// ---------------------------------------------------------------------------

/**
 * Strict persona-name allowlist. Mirrors the file-name regex used to
 * enumerate persona files — every persona MUST satisfy both, eliminating
 * any path-traversal vector via `--personas` arguments. (W1-D4 H1.)
 */
export const SAFE_PERSONA_NAME_RE = /^[a-z0-9-]{1,64}$/;

/** Allowed tier values. */
const ALLOWED_TIERS = new Set(['domain-expert', 'buyer-persona', 'auditor', 'compliance', 'reviewer', 'custom']);

/** Required frontmatter keys (W1-D4 L4 — `additionalProperties:false` semantics). */
const REQUIRED_KEYS = new Set([
  'name',
  'schema_version',
  'version',
  'role',
  'model',
  'output_contract',
  'evaluation_criteria',
  'tier',
]);

/**
 * Optional frontmatter keys — keys NOT in REQUIRED_KEYS and NOT in
 * OPTIONAL_KEYS cause the persona to be rejected.
 */
const OPTIONAL_KEYS = new Set([
  'description',
  'color',
  'tags',
  'enabled',
  'sandbox-tier',
]);

/** Forbidden top-level keys in `output_contract`. (W1-D4 H3.) */
const FORBIDDEN_SCHEMA_KEYS = new Set([
  '$ref',
  '$defs',
  'definitions',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
]);

/** Per-criterion length cap (operator-authored prompt-injection guard). */
const MAX_CRITERION_CHARS = 512;

/**
 * Default repo-relative directory containing persona spec files.
 * Override via `opts.personasDir` for tests or alternative layouts.
 */
export const DEFAULT_PERSONAS_DIR = '.claude/personas';

/**
 * Thrown when two persona files declare the same `name`. The error message
 * lists both source paths so the operator can resolve the conflict directly.
 */
export class DuplicateNameError extends Error {
  constructor(name, firstPath, secondPath) {
    super(
      `Duplicate persona name "${name}" found in both:\n  - ${firstPath}\n  - ${secondPath}`,
    );
    this.name = 'DuplicateNameError';
    this.duplicateName = name;
    this.paths = [firstPath, secondPath];
  }
}

/**
 * Thrown when `loadPersona(name)` is called with a name not present in the
 * catalog. Lists the available names so callers can correct the spelling.
 */
export class PersonaNotFoundError extends Error {
  constructor(name, available) {
    super(
      `Persona "${name}" not found. Available: ${available.length === 0 ? '(none)' : available.join(', ')}`,
    );
    this.name = 'PersonaNotFoundError';
    this.requestedName = name;
    this.available = available;
  }
}

// ---------------------------------------------------------------------------
// preCheckOutputContract
// ---------------------------------------------------------------------------

/**
 * Structural pre-check for the operator-authored `output_contract` schema
 * (W1-D4 H3). AJV is still run by persona-runner.mjs::validatePersonaOutput
 * for the actual payload check; this pre-check fails fast on dangerous
 * shapes BEFORE AJV is exposed to them.
 *
 * Rejected shapes:
 *   - Anything that is not a plain object (string, array, null, function, …)
 *   - Top-level `$ref`, `$defs`, `definitions`, `allOf`, `anyOf`, `oneOf`, `not`
 *     (these enable indirection that compounds the schema-DoS attack surface)
 *
 * Allowed: simple object schemas with `type`, `properties`, `required`,
 * `additionalProperties`, `enum`, `items`, `minimum`, `maximum`,
 * `minLength`, `maxLength`, `pattern`, `format`, etc.
 *
 * @param {unknown} schema
 * @returns {{ok: true} | {ok: false, errors: string[]}}
 */
export function preCheckOutputContract(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return {
      ok: false,
      errors: ['output_contract must be a JSON object'],
    };
  }

  const errors = [];
  for (const key of Object.keys(schema)) {
    if (FORBIDDEN_SCHEMA_KEYS.has(key)) {
      errors.push(
        `output_contract.${key} is not permitted (schema combinators and refs are blocked for safety)`,
      );
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// validatePersonaSpec
// ---------------------------------------------------------------------------

/**
 * Validate one parsed persona-spec object.
 *
 * Pure function: no I/O. Use after `yaml.load` to validate the frontmatter
 * shape, model allowlist, evaluation-criteria array, and output_contract
 * structural shape.
 *
 * @param {unknown} rawSpec — result of yaml.load on the frontmatter block
 * @param {string} sourcePath — absolute path of the persona file (for errors)
 * @returns {{ok: true, persona: object} | {ok: false, errors: Array<{path:string, rule:string, message:string}>}}
 */
export function validatePersonaSpec(rawSpec, sourcePath) {
  const errors = [];
  const pushError = (p, rule, message) => {
    errors.push({ path: p, rule, message: `${message} (in ${sourcePath})` });
  };

  if (rawSpec === null || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) {
    return {
      ok: false,
      errors: [{
        path: '$',
        rule: 'shape',
        message: `persona frontmatter must be a YAML mapping at the top level (in ${sourcePath})`,
      }],
    };
  }

  // Required-keys check (W1-D4 L4).
  for (const req of REQUIRED_KEYS) {
    if (!(req in rawSpec)) {
      pushError(req, 'required', `${req} is required`);
    }
  }

  // Unknown-keys check (additionalProperties:false equivalent).
  for (const key of Object.keys(rawSpec)) {
    if (!REQUIRED_KEYS.has(key) && !OPTIONAL_KEYS.has(key)) {
      pushError(key, 'unknown-key', `unknown frontmatter key "${key}" (additionalProperties is closed)`);
    }
  }

  // name
  const name = rawSpec.name;
  if (name !== undefined) {
    if (typeof name !== 'string') {
      pushError('name', 'type', 'name must be a string');
    } else if (!SAFE_PERSONA_NAME_RE.test(name)) {
      pushError('name', 'format', `name must match ${SAFE_PERSONA_NAME_RE} (got ${JSON.stringify(name)})`);
    }
  }

  // schema_version (must equal 1)
  if ('schema_version' in rawSpec && rawSpec.schema_version !== 1) {
    pushError('schema_version', 'enum', `schema_version must equal 1 (got ${JSON.stringify(rawSpec.schema_version)})`);
  }

  // version (string, non-empty)
  if ('version' in rawSpec) {
    if (typeof rawSpec.version !== 'string' || rawSpec.version.trim() === '') {
      pushError('version', 'type', 'version must be a non-empty string');
    }
  }

  // role (string, non-empty)
  if ('role' in rawSpec) {
    if (typeof rawSpec.role !== 'string' || rawSpec.role.trim() === '') {
      pushError('role', 'type', 'role must be a non-empty string');
    }
  }

  // model (allowlist — H2)
  if ('model' in rawSpec) {
    const m = rawSpec.model;
    if (typeof m !== 'string' || m === '') {
      pushError('model', 'type', 'model must be a non-empty string');
    } else if (!ALLOWED_MODEL_ALIASES.has(m) && !MODEL_ID_RE.test(m)) {
      pushError(
        'model',
        'enum',
        `model must be one of ${[...ALLOWED_MODEL_ALIASES].join('|')} or a full model ID like "claude-opus-4-7" (got ${JSON.stringify(m)})`,
      );
    }
  }

  // tier (enum)
  if ('tier' in rawSpec) {
    if (typeof rawSpec.tier !== 'string' || !ALLOWED_TIERS.has(rawSpec.tier)) {
      pushError(
        'tier',
        'enum',
        `tier must be one of ${[...ALLOWED_TIERS].join('|')} (got ${JSON.stringify(rawSpec.tier)})`,
      );
    }
  }

  // evaluation_criteria — non-empty array of short strings
  if ('evaluation_criteria' in rawSpec) {
    const crit = rawSpec.evaluation_criteria;
    if (!Array.isArray(crit) || crit.length === 0) {
      pushError('evaluation_criteria', 'type', 'evaluation_criteria must be a non-empty array');
    } else {
      crit.forEach((c, i) => {
        if (typeof c !== 'string' || c.length === 0) {
          pushError(`evaluation_criteria[${i}]`, 'type', 'each criterion must be a non-empty string');
        } else if (c.length > MAX_CRITERION_CHARS) {
          pushError(
            `evaluation_criteria[${i}]`,
            'maxLength',
            `criterion exceeds ${MAX_CRITERION_CHARS} chars`,
          );
        }
      });
    }
  }

  // output_contract — structural pre-check (H3)
  if ('output_contract' in rawSpec) {
    const pre = preCheckOutputContract(rawSpec.output_contract);
    if (!pre.ok) {
      for (const e of pre.errors) {
        pushError('output_contract', 'shape', e);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, persona: /** @type {object} */ (rawSpec) };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Match the YAML frontmatter block at the head of a markdown file. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Strip and parse the YAML frontmatter block from a markdown file's contents.
 *
 * Uses `yaml.CORE_SCHEMA` explicitly (W1-D4 L1) — disables YAML 1.1 type
 * extensions like `!!js/function` and `!!js/regexp`.
 *
 * @param {string} contents
 * @param {string} sourcePath
 * @returns {{ok: true, frontmatter: object, body: string} | {ok: false, error: string}}
 */
function parseFrontmatterBlock(contents, sourcePath) {
  const match = FRONTMATTER_RE.exec(contents);
  if (match === null) {
    return {
      ok: false,
      error: `${sourcePath}: missing YAML frontmatter (file must begin with --- … ---)`,
    };
  }

  const [, fmText, body] = match;
  let parsed;
  try {
    parsed = yaml.load(fmText, { schema: yaml.CORE_SCHEMA });
  } catch (err) {
    // yaml.load throws YAMLException with `.mark.line` / `.mark.column`.
    const where = err?.mark
      ? `line ${err.mark.line + 1}, column ${err.mark.column + 1}`
      : 'unknown location';
    return {
      ok: false,
      error: `${sourcePath}: YAML parse error at ${where}: ${err.message ?? err}`,
    };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: `${sourcePath}: frontmatter must be a YAML mapping (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`,
    };
  }

  return { ok: true, frontmatter: parsed, body: body.startsWith('\n') ? body.slice(1) : body };
}

/**
 * Read one persona file, rejecting symlinks (L3) and enforcing the safe-name
 * pattern at the file level. Returns the parsed-and-validated persona OR a
 * structured error.
 *
 * @param {string} absPath — already-validated absolute path under personasRoot
 * @returns {Promise<{ok: true, persona: object, frontmatter: object, body: string, sourcePath: string}
 *                  | {ok: false, errors: Array<{path:string, rule:string, message:string}>, sourcePath: string}>}
 */
async function loadOnePersonaFile(absPath) {
  // L3 — symlink rejection.
  let stat;
  try {
    stat = await lstat(absPath);
  } catch (err) {
    return {
      ok: false,
      sourcePath: absPath,
      errors: [{ path: '$', rule: 'read-error', message: `lstat failed: ${err.message ?? err}` }],
    };
  }
  if (stat.isSymbolicLink()) {
    return {
      ok: false,
      sourcePath: absPath,
      errors: [{ path: '$', rule: 'symlink', message: 'persona files must not be symbolic links' }],
    };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      sourcePath: absPath,
      errors: [{ path: '$', rule: 'type', message: 'persona path must be a regular file' }],
    };
  }

  let raw;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      sourcePath: absPath,
      errors: [{ path: '$', rule: 'read-error', message: `read failed: ${err.message ?? err}` }],
    };
  }

  const fm = parseFrontmatterBlock(raw, absPath);
  if (!fm.ok) {
    return {
      ok: false,
      sourcePath: absPath,
      errors: [{ path: '$', rule: 'yaml-parse', message: fm.error }],
    };
  }

  const validation = validatePersonaSpec(fm.frontmatter, absPath);
  if (!validation.ok) {
    return { ok: false, sourcePath: absPath, errors: validation.errors };
  }

  return {
    ok: true,
    persona: validation.persona,
    frontmatter: fm.frontmatter,
    body: fm.body,
    sourcePath: absPath,
  };
}

/**
 * Resolve + validate the personas directory.
 *
 * @param {{personasDir?: string, projectRoot?: string}} opts
 * @returns {{personasRoot: string, projectRoot: string}}
 * @throws {Error} when the resolved path escapes the project root
 */
function resolvePersonasRoot(opts) {
  const projectRoot = opts.projectRoot ?? findProjectRoot();
  const rel = opts.personasDir ?? DEFAULT_PERSONAS_DIR;
  const guard = validatePathInsideProject(rel, projectRoot);
  if (!guard.ok) {
    throw new Error(
      `personas directory ${JSON.stringify(rel)} is not inside the project root (reason=${guard.reason}${guard.error ? `: ${guard.error}` : ''})`,
    );
  }
  return { personasRoot: guard.lexicalPath, projectRoot };
}

// ---------------------------------------------------------------------------
// loadCatalog
// ---------------------------------------------------------------------------

/**
 * Load every persona under `<projectRoot>/<personasDir>/*.md`.
 *
 * Failure modes (in priority order):
 *   (a) Personas directory does not exist → throw with helpful message
 *   (b) Directory exists but contains no `*.md` → returns empty Map (NOT an error;
 *       caller decides whether empty is allowed)
 *   (c) A persona has unrecoverable validation errors → throw with all errors aggregated
 *   (d) Two personas share `name` → throw DuplicateNameError
 *
 * @param {{personasDir?: string, projectRoot?: string}} [opts]
 * @returns {Promise<Map<string, {persona: object, frontmatter: object, body: string, sourcePath: string}>>}
 */
export async function loadCatalog(opts = {}) {
  const { personasRoot } = resolvePersonasRoot(opts);

  let entries;
  try {
    entries = await readdir(personasRoot, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(
        `personas directory not found: ${personasRoot} (create .claude/personas/ or pass --personas-dir)`,
        { cause: err },
      );
    }
    throw err;
  }

  // Filter to `<safe-name>.md` files only — any other entry (dotfile,
  // subdirectory, weird extension) is silently skipped to keep the directory
  // forward-compatible with future tooling (README.md, fixtures/, etc.).
  const candidates = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => n.endsWith('.md'))
    .filter((n) => {
      const base = n.slice(0, -'.md'.length);
      return SAFE_PERSONA_NAME_RE.test(base);
    })
    .sort(); // deterministic enumeration order

  const map = new Map();
  const validationErrors = [];

  for (const fname of candidates) {
    // Re-validate the per-file path inside the personas root — defence-in-depth
    // against a personasRoot that somehow contains a traversal seam.
    const guard = validatePathInsideProject(fname, personasRoot);
    if (!guard.ok) {
      validationErrors.push({
        sourcePath: path.join(personasRoot, fname),
        errors: [{ path: '$', rule: 'path-traversal', message: `entry rejected (reason=${guard.reason})` }],
      });
      continue;
    }

    const result = await loadOnePersonaFile(guard.realPath ?? guard.lexicalPath);
    if (!result.ok) {
      validationErrors.push({ sourcePath: result.sourcePath, errors: result.errors });
      continue;
    }

    const name = result.persona.name;
    if (map.has(name)) {
      const existing = map.get(name);
      throw new DuplicateNameError(name, existing.sourcePath, result.sourcePath);
    }
    map.set(name, {
      persona: result.persona,
      frontmatter: result.frontmatter,
      body: result.body,
      sourcePath: result.sourcePath,
    });
  }

  if (validationErrors.length > 0) {
    const lines = validationErrors.flatMap(({ sourcePath, errors }) =>
      errors.map((e) => `  ${sourcePath} :: ${e.path}: ${e.message}`),
    );
    throw new Error(`persona validation failed:\n${lines.join('\n')}`);
  }

  return map;
}

// ---------------------------------------------------------------------------
// loadPersona
// ---------------------------------------------------------------------------

/**
 * Load one persona by `name`. Used by the `--personas <comma,list>` CLI arg.
 *
 * Validates `name` against `SAFE_PERSONA_NAME_RE` before any filesystem
 * lookup, so a malicious operator can't smuggle traversal sequences through
 * the argument.
 *
 * @param {string} name
 * @param {{personasDir?: string, projectRoot?: string}} [opts]
 * @returns {Promise<{persona: object, frontmatter: object, body: string, sourcePath: string}>}
 * @throws {TypeError}        if name is not a string
 * @throws {Error}            if name fails SAFE_PERSONA_NAME_RE
 * @throws {PersonaNotFoundError} if name is not in the catalog
 */
export async function loadPersona(name, opts = {}) {
  if (typeof name !== 'string') {
    throw new TypeError(`loadPersona: name must be a string (got ${typeof name})`);
  }
  if (!SAFE_PERSONA_NAME_RE.test(name)) {
    throw new Error(
      `loadPersona: name ${JSON.stringify(name)} fails ${SAFE_PERSONA_NAME_RE} — refusing to read`,
    );
  }
  const catalog = await loadCatalog(opts);
  const hit = catalog.get(name);
  if (hit === undefined) {
    throw new PersonaNotFoundError(name, [...catalog.keys()].sort());
  }
  return hit;
}
