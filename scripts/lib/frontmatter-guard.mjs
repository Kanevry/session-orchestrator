/**
 * Frontmatter-Guard library (issue #328).
 *
 * Reads the canonical vault-frontmatter Zod schema source and exposes helpers
 * for generating a contextual schema snippet that can be injected into agent
 * prompts before vault-write tasks.
 *
 * Pure ESM, no top-level side effects. All I/O is wrapped in functions.
 * Uses `node:fs` and `node:crypto` only — no external dependencies.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Absolute path to the canonical vault-frontmatter schema source. */
const SCHEMA_SOURCE_PATH = join(
  homedir(),
  'Projects/projects-baseline/packages/zod-schemas/src/vault-frontmatter.ts',
);

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
  let mtime;
  try {
    mtime = statSync(SCHEMA_SOURCE_PATH).mtimeMs;
  } catch {
    // File missing or inaccessible
    return null;
  }

  if (_cache.mtime === mtime && _cache.result !== null) {
    return _cache.result;
  }

  let text;
  try {
    text = readFileSync(SCHEMA_SOURCE_PATH, 'utf8');
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
 * @param {string} schemaText
 * @returns {string}
 */
export function computeSchemaHash(schemaText) {
  return createHash('sha256').update(schemaText).digest('hex').slice(0, 8);
}

/**
 * Generate a deterministic Markdown snippet documenting the vault frontmatter
 * schema, suitable for injection into agent prompts before vault-write tasks.
 *
 * @param {{ typeEnum: string[], statusEnum: string[], requiredFields: string[], idRegex: string, tagsRegex: string }} schema
 * @returns {string}
 */
export function generateFrontmatterSnippet(schema) {
  const { typeEnum, statusEnum, requiredFields, idRegex, tagsRegex: _tagsRegex } = schema;

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
