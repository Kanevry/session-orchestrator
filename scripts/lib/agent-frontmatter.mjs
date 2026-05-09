/**
 * Agent frontmatter validator — plain-JS, no Zod (issue #189).
 *
 * Validates `.claude/agents/*.md` frontmatter against the project-instruction
 * file's Agent Authoring Rules (CLAUDE.md, or AGENTS.md on Codex CLI — see
 * skills/_shared/instruction-file-resolution.md). Catches the two most common
 * silent-failure pitfalls:
 *   (a) `tools` as a JSON array instead of a comma-separated string
 *   (b) `description` as a YAML block scalar (`>` or `|`) instead of an
 *       inline string
 *
 * Modelled after scripts/lib/state-md.mjs (FRONTMATTER_RE, line-by-line
 * key:value parsing) and scripts/lib/config-schema.mjs (error shape).
 *
 * Never throws. Returns structured result objects.
 */

import { readFileSync } from 'node:fs';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Aliases per https://code.claude.com/docs/en/sub-agents § model resolution.
// Full model IDs (claude-{opus|sonnet|haiku}-N-N[-YYYYMMDD]) also accepted via MODEL_ID_RE.
const ALLOWED_MODEL_ALIASES = new Set(['inherit', 'sonnet', 'opus', 'haiku']);
const MODEL_ID_RE = /^claude-(opus|sonnet|haiku)-\d+-\d+(-\d{8})?$/;

// Canonical Anthropic palette (red|blue|green|yellow|purple|orange|pink|cyan)
// plus magenta from plugin-dev SKILL.md for backward-compat.
const ALLOWED_COLORS = new Set(['blue', 'cyan', 'green', 'yellow', 'magenta', 'red', 'purple', 'orange', 'pink']);

/**
 * name must be 3–50 chars, lowercase letters, digits, hyphens only,
 * starting with a lowercase letter.
 */
const NAME_RE = /^[a-z][a-z0-9-]{2,49}$/;

/**
 * Parses the YAML frontmatter block from an agent markdown file.
 *
 * Preserves raw string values so the validator can detect JSON-array tools
 * and block-scalar descriptions without normalising them away.
 *
 * @returns {{ ok: true, frontmatter: Record<string,string>, body: string }
 *          |{ ok: false, errors: Array<{path: string, rule: string, message: string}> }}
 */
export function parseAgentFrontmatter(contents) {
  if (typeof contents !== 'string') {
    return {
      ok: false,
      errors: [{ path: '$', rule: 'type', message: 'contents must be a string' }],
    };
  }

  const match = FRONTMATTER_RE.exec(contents);
  if (!match) {
    return {
      ok: false,
      errors: [
        {
          path: '$',
          rule: 'missing-frontmatter',
          message: 'No YAML front-matter block (expected file to start with ---)',
        },
      ],
    };
  }

  const [, fmText, body] = match;
  const frontmatter = /** @type {Record<string,string>} */ ({});
  const lines = fmText.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (line === '' || /^\s*#/.test(line)) continue;

    // Detect block-scalar indicators on a key line, e.g. `description: >` or `description: |`
    // These are valid YAML but break Claude Code's parser.
    const blockScalarMatch = /^(\w[\w-]*):\s*[>|]\s*$/.exec(line);
    if (blockScalarMatch) {
      // Store a sentinel so the validator can emit the correct rule.
      frontmatter[blockScalarMatch[1]] = '__BLOCK_SCALAR__';
      continue;
    }

    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key === '') continue;
    const value = line.slice(idx + 1).trim();
    frontmatter[key] = value;
  }

  return {
    ok: true,
    frontmatter,
    body: body.startsWith('\n') ? body.slice(1) : body,
  };
}

/**
 * Validates a parsed frontmatter object against CLAUDE.md Agent Authoring Rules.
 *
 * @param {Record<string,string>|null|undefined} frontmatter
 * @returns {{ ok: true }|{ ok: false, errors: Array<{path: string, rule: string, message: string}> }}
 */
export function validateAgentFrontmatter(frontmatter) {
  if (frontmatter === null || frontmatter === undefined || typeof frontmatter !== 'object') {
    return {
      ok: false,
      errors: [{ path: '$', rule: 'missing-frontmatter', message: 'No YAML front-matter block' }],
    };
  }

  const errors = /** @type {Array<{path: string, rule: string, message: string}>} */ ([]);

  // --- name ---
  const name = frontmatter['name'];
  if (name === undefined || name === '') {
    errors.push({
      path: 'name',
      rule: 'required',
      message: 'name is required',
    });
  } else if (!NAME_RE.test(name)) {
    errors.push({
      path: 'name',
      rule: 'name-format',
      message: `name must be 3–50 chars, lowercase letters/digits/hyphens, starting with a letter (got ${JSON.stringify(name)})`,
    });
  }

  // --- description ---
  const description = frontmatter['description'];
  if (description === undefined || description === '') {
    errors.push({
      path: 'description',
      rule: 'required',
      message: 'description is required',
    });
  } else if (description === '__BLOCK_SCALAR__') {
    errors.push({
      path: 'description',
      rule: 'no-block-scalar',
      message:
        'description must be an inline single-line string, not a YAML block scalar (> or |). Put <example> blocks inline.',
    });
  }

  // --- model ---
  const model = frontmatter['model'];
  if (model === undefined || model === '') {
    errors.push({
      path: 'model',
      rule: 'required',
      message: 'model is required',
    });
  } else if (!ALLOWED_MODEL_ALIASES.has(model) && !MODEL_ID_RE.test(model)) {
    errors.push({
      path: 'model',
      rule: 'enum',
      message: `model must be one of ${[...ALLOWED_MODEL_ALIASES].map((m) => JSON.stringify(m)).join('|')} or a full model ID like "claude-opus-4-7" (got ${JSON.stringify(model)})`,
    });
  }

  // --- color ---
  const color = frontmatter['color'];
  if (color === undefined || color === '') {
    errors.push({
      path: 'color',
      rule: 'required',
      message: 'color is required',
    });
  } else if (!ALLOWED_COLORS.has(color)) {
    errors.push({
      path: 'color',
      rule: 'enum',
      message: `color must be one of ${[...ALLOWED_COLORS].map((c) => JSON.stringify(c)).join('|')} (got ${JSON.stringify(color)})`,
    });
  }

  // --- tools (optional) ---
  // Both forms accepted per Anthropic canonical:
  //   1. Comma-separated string: "Read, Edit, Write"
  //   2. JSON array:             ["Read","Edit","Write"]
  // Reject only malformed arrays (non-string elements, parse failures).
  const tools = frontmatter['tools'];
  if (tools !== undefined && tools !== '' && typeof tools === 'string') {
    if (tools.startsWith('[')) {
      let parsed;
      try {
        parsed = JSON.parse(tools);
      } catch {
        errors.push({
          path: 'tools',
          rule: 'malformed-array',
          message: `tools is a malformed JSON array: ${tools}`,
        });
        parsed = null;
      }
      if (parsed !== null) {
        if (!Array.isArray(parsed)) {
          errors.push({
            path: 'tools',
            rule: 'array-expected',
            message: `tools must be an array when using JSON form (got ${typeof parsed})`,
          });
        } else if (!parsed.every((t) => typeof t === 'string')) {
          errors.push({
            path: 'tools',
            rule: 'array-strings-only',
            message: 'tools array must contain only string elements',
          });
        }
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

/**
 * Convenience function: reads a file, parses its frontmatter, and validates it.
 *
 * Never throws. Returns a result object with the file path attached.
 *
 * @param {string} filePath - absolute or relative path to the agent .md file
 * @returns {{ ok: true, file: string }
 *          |{ ok: false, file: string, errors: Array<{path: string, rule: string, message: string}> }}
 */
export function validateAgentFile(filePath) {
  let contents;
  try {
    contents = readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      file: filePath,
      errors: [
        {
          path: '$',
          rule: 'read-error',
          message: `Could not read file: ${err.message}`,
        },
      ],
    };
  }

  const parsed = parseAgentFrontmatter(contents);
  if (!parsed.ok) {
    return { ok: false, file: filePath, errors: parsed.errors };
  }

  const validation = validateAgentFrontmatter(parsed.frontmatter);
  if (!validation.ok) {
    return { ok: false, file: filePath, errors: validation.errors };
  }

  return { ok: true, file: filePath };
}
