/**
 * Frontmatter-Guard library (issue #328).
 *
 * Reads the canonical vault-frontmatter Zod schema source — when a
 * projects-baseline checkout is reachable on this host — and exposes helpers
 * for generating a contextual schema snippet that can be injected into agent
 * prompts before vault-write tasks.
 *
 * Pure ESM, no top-level side effects. All I/O is wrapped in functions.
 * Uses `node:fs` and `node:crypto` only — no external dependencies.
 */

import { digestSha256Short } from './crypto-digest-utils.mjs';
import { resolveHostPath } from './config/host-paths.mjs';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Path of the schema source RELATIVE to a projects-baseline checkout root. */
const SCHEMA_REL_PATH = 'packages/zod-schemas/src/vault-frontmatter.ts';

/** This file lives at `<repoRoot>/scripts/lib/` — two levels up is the repo root. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Candidate projects-baseline checkout roots.
 *
 * The baseline is OPTIONAL and PRIVATE (see `docs/baseline.md`), so this list
 * must never assume a particular operator layout — it carries no host-specific
 * directory names.
 *
 * When the host-local override (`SO_BASELINE_PATH` / `owner.yaml`
 * `paths.baseline-path`) is set it is used ALONE: probing past a wrong explicit
 * value would silently read a DIFFERENT baseline than the one named. Degrading
 * to `null` (and the documented fallback enum set) is the honest outcome there.
 * Only when nothing is configured do the two CONVENTIONS apply — the sibling
 * checkout `scripts/sync-vault-schema.mjs` already uses, then the legacy
 * `~/Projects` default this module shipped with.
 *
 * @returns {string[]}
 */
function baselineCandidates() {
  const configured = resolveHostPath('baseline-path', null);
  if (typeof configured === 'string' && configured.trim() !== '') return [configured.trim()];
  return [
    resolve(REPO_ROOT, '..', 'projects-baseline'),
    join(homedir(), 'Projects', 'projects-baseline'),
  ];
}

/** @type {{ resolved: boolean, value: string|null }} */
const _pathCache = { resolved: false, value: null };

/**
 * Resolve the canonical vault-frontmatter schema source, or `null` when no
 * baseline checkout is reachable on this host.
 *
 * Ceiling: at most two `statSync` calls per invocation, and the result is
 * memoised for the process lifetime. Revisit if the candidate list ever grows
 * past a handful of entries — then it needs a real search, not a probe loop.
 *
 * @param {{ refresh?: boolean }} [opts] — `refresh: true` re-probes (tests only)
 * @returns {string|null}
 */
export function resolveSchemaSourcePath({ refresh = false } = {}) {
  if (!refresh && _pathCache.resolved) return _pathCache.value;
  let found = null;
  for (const base of baselineCandidates()) {
    const candidate = join(base, SCHEMA_REL_PATH);
    try {
      if (statSync(candidate).isFile()) {
        found = candidate;
        break;
      }
    } catch {
      /* candidate absent — try the next one */
    }
  }
  _pathCache.resolved = true;
  _pathCache.value = found;
  return found;
}

/**
 * Fallback enum/field set used when no baseline checkout is reachable.
 *
 * Values mirror `skills/vault-sync/validator.mjs` (`vaultNoteTypeSchema` /
 * `vaultNoteStatusSchema`), which is this repo's own in-tree copy of the
 * canonical schema and is what `vault-sync` actually validates against. Using
 * it means a baseline-less host injects a snippet the local validator accepts,
 * rather than throwing.
 */
const FALLBACK_SCHEMA = Object.freeze({
  typeEnum: Object.freeze([
    'note', 'daily', 'project', 'person', 'reference',
    'idea', 'learning', 'session', 'peer-card', 'board',
  ]),
  statusEnum: Object.freeze([
    'draft', 'active', 'verified', 'archived', 'production',
    'mvp', 'idea', 'maintenance', 'planned', 'paused', 'dead',
  ]),
  requiredFields: Object.freeze(['id', 'type', 'created', 'updated']),
  idRegex: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
  tagsRegex: '^[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$',
  schemaText: null,
});

/** One WARN per process, not one per call — the condition is constant. */
let _warnedFallback = false;

/**
 * In-memory mtime cache so repeated calls within a single process invocation
 * skip the FS read when the file has not changed. Re-reads on mtime change.
 *
 * @type {{ mtime: number | null; result: ReturnType<typeof _parseSchema> | null }}
 */
const _cache = { mtime: null, result: null };

/**
 * Parse the type-enum values out of a Zod `z.enum([...])` call in source text.
 *
 * @param {string} text
 * @param {string} exportName - e.g. 'vaultNoteTypeSchema'
 * @returns {string[]}
 */
function _extractEnum(text, exportName) {
  // Match: export const <name> = z.enum([ ...values... ]);
  const re = new RegExp(
    `export\\s+const\\s+${exportName}\\s*=\\s*z\\.enum\\(\\s*\\[([^\\]]+)\\]`,
    's',
  );
  const match = text.match(re);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/**
 * Internal parser — extracts structured info from the TS source.
 *
 * @param {string} text
 * @returns {{ typeEnum: string[], statusEnum: string[], requiredFields: string[], idRegex: string, tagsRegex: string, schemaText: string }}
 */
function _parseSchema(text) {
  const typeEnum = _extractEnum(text, 'vaultNoteTypeSchema');
  const statusEnum = _extractEnum(text, 'vaultNoteStatusSchema');

  // Required fields are id, type, created, updated — stable; extracted
  // from the schema object declaration (non-optional fields).
  const requiredFields = ['id', 'type', 'created', 'updated'];

  // Regex values — parse from source or use hard-coded fallback that matches
  // the known schema. Prefer source-parse for drift-safety.
  const slugMatch = text.match(/const slugRegex\s*=\s*([^;]+);/);
  const tagMatch = text.match(/const tagPathRegex\s*=\s*([^;]+);/);

  // Convert JS regex literal /pattern/ to pattern string
  const toPattern = (raw) => {
    if (!raw) return null;
    const m = raw.trim().match(/^\/(.+)\/[gimsuy]*$/);
    return m ? m[1] : null;
  };

  const idRegex =
    toPattern(slugMatch?.[1]) ?? '^[a-z0-9]+(?:-[a-z0-9]+)*$';
  const tagsRegex =
    toPattern(tagMatch?.[1]) ??
    '^[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$';

  return { typeEnum, statusEnum, requiredFields, idRegex, tagsRegex, schemaText: text };
}

/**
 * Read and parse the canonical vault-frontmatter schema source.
 *
 * Caches the result in-memory; re-reads only when the file mtime changes.
 * Returns `null` (no throw) if the file is missing or unreadable.
 *
 * @returns {{ typeEnum: string[], statusEnum: string[], requiredFields: string[], idRegex: string, tagsRegex: string, schemaText: string } | null}
 */
export function readVaultSchema() {
  const sourcePath = resolveSchemaSourcePath();
  if (sourcePath === null) return null;

  let mtime;
  try {
    mtime = statSync(sourcePath).mtimeMs;
  } catch {
    // File missing or inaccessible
    return null;
  }

  if (_cache.mtime === mtime && _cache.result !== null) {
    return _cache.result;
  }

  let text;
  try {
    text = readFileSync(sourcePath, 'utf8');
  } catch {
    return null;
  }

  const result = _parseSchema(text);
  _cache.mtime = mtime;
  _cache.result = result;
  return result;
}

/**
 * Compute an 8-character SHA-256 hex prefix of the given schema source text.
 * Stable across calls for the same input — useful as a cache-busting token.
 *
 * Returns `null` when there is NO schema text (absent baseline checkout,
 * `readVaultSchema()` → `null`). Hashing "nothing" previously produced
 * `e3b0c442` — the SHA-256 of the empty string — which is a real-looking token
 * that compares equal across every baseline-less host, so a cache keyed on it
 * would report "schema unchanged" while having measured nothing at all.
 *
 * @param {string|null|undefined} schemaText
 * @returns {string|null} 8-char hex prefix, or `null` when there is no schema
 */
export function computeSchemaHash(schemaText) {
  if (typeof schemaText !== 'string' || schemaText.length === 0) return null;
  return digestSha256Short(schemaText);
}

/**
 * Generate a deterministic Markdown snippet documenting the vault frontmatter
 * schema, suitable for injection into agent prompts before vault-write tasks.
 *
 * Degrades instead of throwing when no schema is available: a host without a
 * projects-baseline checkout gets `readVaultSchema() === null`, and destructuring
 * that killed the caller with `Cannot destructure property 'typeEnum' of
 * 'schema' as it is undefined`. The guard below falls back to FALLBACK_SCHEMA
 * and warns ONCE on stderr — an injected snippet that is one schema-version
 * behind is worth incomparably more than a crashed pre-dispatch hook.
 *
 * @param {{ typeEnum: string[], statusEnum: string[], requiredFields: string[], idRegex: string, tagsRegex: string }|null} [schema]
 * @returns {string}
 */
export function generateFrontmatterSnippet(schema) {
  let source = schema;
  if (source === null || typeof source !== 'object') {
    if (!_warnedFallback) {
      _warnedFallback = true;
      process.stderr.write(
        'frontmatter-guard: no projects-baseline schema reachable — using the in-module ' +
          'fallback enum set (see docs/baseline.md). Set SO_BASELINE_PATH or ' +
          'owner.yaml paths.baseline-path to read the canonical schema.\n',
      );
    }
    source = FALLBACK_SCHEMA;
  }
  const { typeEnum, statusEnum, requiredFields, idRegex, tagsRegex: _tagsRegex } = source;

  const typeList = typeEnum.map((v) => `\`${v}\``).join(' | ');
  const statusList = statusEnum.map((v) => `\`${v}\``).join(' | ');
  const requiredList = requiredFields.map((f) => `\`${f}\``).join(', ');

  return `## Vault Frontmatter Schema (REQUIRED for files under ~/Projects/vault/)

**Required fields (every note):** ${requiredList}

### Enums
- **\`type\`:** ${typeList}
- **\`status\`** (optional): ${statusList}

### Field formats
- \`id\`: kebab-case, 2-128 chars, regex \`${idRegex}\`
- \`tags\`: array of kebab-case strings, \`/\` separator allowed (e.g., \`learning/cli-design\`)
- \`created\` / \`updated\` / \`expires\`: ISO 8601 (\`YYYY-MM-DD\` or \`YYYY-MM-DDTHH:MM:SSZ\`)

### Examples

#### type: reference
\`\`\`yaml
id: parallel-session-rules
type: reference
created: 2026-05-08
updated: 2026-05-08
status: active
tags: [reference/rules]
\`\`\`
#### type: session
\`\`\`yaml
id: session-2026-05-08-deep
type: session
created: 2026-05-08
updated: 2026-05-08
status: archived
tags: [session/deep]
\`\`\`
#### type: learning
\`\`\`yaml
id: w1-discovery-shrinks-scope
type: learning
created: 2026-05-08
updated: 2026-05-08
status: active
\`\`\`
#### type: daily
\`\`\`yaml
id: 2026-05-08
type: daily
created: 2026-05-08
updated: 2026-05-08
\`\`\`
#### type: project
\`\`\`yaml
id: session-orchestrator
type: project
created: 2026-04-01
updated: 2026-05-08
status: active
\`\`\`
`;
}

/**
 * Heuristic detector: returns true when the current task is likely to write
 * vault files, in which case the frontmatter-guard snippet should be injected.
 *
 * Detection rules (OR logic — any match returns true):
 *   1. Any file in `fileScope` whose path contains `/Projects/vault/`.
 *   2. Any file in `fileScope` under known vault subdirectories:
 *      `40-learnings/`, `50-sessions/`, `03-daily/`, `01-projects/`.
 *   3. `taskDescription` mentions "vault" or "vault-mirror" AND contains a
 *      write-intent keyword ("write", "creat", "generat", "emit", "mirror",
 *      "update", "add", "insert").
 *
 * Pure function — no I/O.
 *
 * @param {string} taskDescription
 * @param {string[]} fileScope
 * @returns {boolean}
 */
export function detectVaultTaskScope(taskDescription, fileScope) {
  const VAULT_PATH_RE = /\/Projects\/vault\//;
  const VAULT_SUBDIR_RE = /(?:40-learnings|50-sessions|03-daily|01-projects)\//;

  for (const f of fileScope) {
    if (VAULT_PATH_RE.test(f) || VAULT_SUBDIR_RE.test(f)) {
      return true;
    }
  }

  const desc = taskDescription.toLowerCase();
  const mentionsVault = desc.includes('vault') || desc.includes('vault-mirror');
  const WRITE_INTENT_RE = /\b(?:write[a-z]*|creat[a-z]*|generat[a-z]*|emit[a-z]*|mirror[a-z]*|updat[a-z]*|add[a-z]*|insert[a-z]*)\b/;
  if (mentionsVault && WRITE_INTENT_RE.test(desc)) {
    return true;
  }

  return false;
}
