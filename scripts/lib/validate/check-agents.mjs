#!/usr/bin/env node
// check-agents.mjs — Validate agent .md files have valid YAML frontmatter.
// Usage: check-agents.mjs <plugin-root>
// Outputs lines of the form "  PASS: ..." / "  FAIL: ..."
// Exit 0 = all checks passed; exit 1 = at least one failure.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { ALLOWED_MODEL_ALIASES, MODEL_ID_RE } from '../agent-frontmatter.mjs';
import { extractInitialFrontmatter } from './frontmatter-block.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Lazy-loaded from tier-inference.mjs on first use in Check 8.
let _tierModule = null;
async function getTierModule() {
  if (!_tierModule) {
    _tierModule = await import(join(__dirname, 'tier-inference.mjs'));
  }
  return _tierModule;
}

const [, , pluginRoot] = process.argv;

if (!pluginRoot) {
  console.error('Usage: check-agents.mjs <plugin-root>');
  process.exit(1);
}

const PLUGIN_JSON = join(pluginRoot, '.claude-plugin', 'plugin.json');
const CONVENTIONAL_AGENTS = 'agents';

// Nested instruction files (CLAUDE.md / AGENTS.md) may live in agents/ as
// per-directory authoring conventions (Anthropic large-codebase layered-doc
// pattern). They are NOT agent definitions and must be excluded from
// frontmatter / output-schema / sandbox-tier validation.
const INSTRUCTION_FILENAMES = new Set(['AGENTS.md', 'CLAUDE.md']);
const isAgentDefFile = (f) => f.endsWith('.md') && !INSTRUCTION_FILENAMES.has(f);

let passed = 0;
let failed = 0;

function pass(msg) {
  console.log(`  PASS: ${msg}`);
  passed++;
}

function warn(msg) {
  console.log(`  WARN: ${msg}`);
}

function fail(msg) {
  console.log(`  FAIL: ${msg}`);
  failed++;
}

/**
 * Extract YAML frontmatter content (between first --- and second ---).
 * Returns null if no valid frontmatter block found.
 *
 * Delegates to the shared extractor. This file carried a THIRD verbatim copy of
 * that regex until now (check-skills.mjs and check-commands.mjs held the other
 * two, which is why the extraction was lifted into frontmatter-block.mjs). Only
 * the block-finding is shared — the field RULES stay per-gate and disagree on
 * purpose; see the header of frontmatter-block.mjs.
 *
 * Checks 7-10 only need "text, or nothing"; Check 6 reads the shared
 * diagnostic directly for a precise message.
 */
function extractFrontmatter(content) {
  const extracted = extractInitialFrontmatter(content);
  return extracted.ok ? extracted.yamlText : null;
}

/**
 * Parse a frontmatter block with a real YAML parser (CORE_SCHEMA, matching
 * check-commands.mjs and check-skills.mjs).
 *
 * @param {string} yamlText - the block's inner text, no fences
 * @returns {{ ok: true, data: unknown } | { ok: false, message: string }}
 *   On failure, `message` is a caller-printable reason with a frontmatter-local
 *   line/column when js-yaml supplies one.
 */
function parseFrontmatterYaml(yamlText) {
  let data;
  try {
    data = yaml.load(yamlText, { schema: yaml.CORE_SCHEMA });
  } catch (error) {
    const reason = error?.reason ?? error?.message ?? String(error);
    const location = error?.mark
      ? ` at frontmatter line ${error.mark.line + 1}, column ${error.mark.column + 1}`
      : '';
    return { ok: false, message: `invalid YAML frontmatter: ${reason}${location}` };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, message: 'YAML frontmatter must be a non-null mapping/object' };
  }
  return { ok: true, data };
}

/**
 * Get a scalar field value from frontmatter text.
 * Returns null if field not present.
 */
function getField(fm, name) {
  const m = fm.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

/**
 * Check whether a field key is present in frontmatter (even with empty/block value).
 */
function hasField(fm, name) {
  return new RegExp(`^${name}:`, 'm').test(fm);
}

/**
 * Parse the tools field value into an array of tool name strings.
 * Handles comma-separated strings ("Read, Edit, Write") and JSON arrays.
 * Returns [] if toolsVal is null/empty or unparseable.
 */
function parseToolsValue(toolsVal) {
  if (!toolsVal) return [];
  const v = toolsVal.trim();
  if (v.startsWith('[')) {
    try {
      const arr = JSON.parse(v);
      return Array.isArray(arr) ? arr.filter((t) => typeof t === 'string') : [];
    } catch {
      return [];
    }
  }
  // Comma-separated string: split on comma, strip whitespace.
  return v.split(',').map((t) => t.trim()).filter(Boolean);
}

// ============================================================================
// Check 6: Agent .md files have valid YAML frontmatter
// ============================================================================
console.log('--- Check 6: agent frontmatter ---');

// Resolve agents directory from plugin.json or fall back to conventional location.
let agentsDir;
if (existsSync(PLUGIN_JSON)) {
  let pluginData = {};
  try {
    pluginData = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8'));
  } catch {
    // ignore parse errors — fall back to conventional
  }
  const agentsPath = pluginData.agents;
  if (agentsPath) {
    // Strip leading ./ if present, then join to plugin root
    agentsDir = join(pluginRoot, agentsPath.replace(/^\.\//, ''));
  }
}
if (!agentsDir) {
  agentsDir = join(pluginRoot, CONVENTIONAL_AGENTS);
}

if (!existsSync(agentsDir)) {
  const agentsPath = (() => {
    try {
      return JSON.parse(readFileSync(PLUGIN_JSON, 'utf8')).agents;
    } catch {
      return null;
    }
  })();
  if (agentsPath) {
    fail(`agents path is not a directory: ${agentsPath}`);
  } else {
    fail(`agents directory not found at conventional location: ./${CONVENTIONAL_AGENTS}`);
  }
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const mdFiles = readdirSync(agentsDir).filter(isAgentDefFile);

if (mdFiles.length === 0) {
  fail('agents directory is empty (no .md files)');
} else {
  let parseable = 0;

  for (const agentFile of mdFiles) {
    const agentName = agentFile;
    const filePath = join(agentsDir, agentFile);
    const content = readFileSync(filePath, 'utf8');

    const extracted = extractInitialFrontmatter(content);

    if (!extracted.ok) {
      fail(`${agentName}: ${extracted.diagnostic}`);
      continue;
    }
    const frontmatter = extracted.yamlText;

    // ------------------------------------------------------------------
    // The block is valid YAML.
    //
    // Every rule below reads the block with LINE REGEXES (getField/hasField),
    // which model Claude Code's own lenient loader. That leniency is exactly
    // how 14 of 16 agent definitions sat unparseable in the tree unnoticed: an
    // unquoted single-line `description:` containing a `: ` (e.g.
    // `<example>Context: /plan ...`) is not YAML, and a regex looking only for
    // `^description:` sees nothing wrong. A ` #` inside such a value is worse
    // still — it opens a YAML comment, so the block PARSES while silently
    // truncating the description at that point.
    //
    // A parse failure is reported alone (no fall-through to the field rules):
    // the block is broken at the root, and six regex verdicts stacked on top
    // of it are cascade noise that buries the one defect worth fixing. Same
    // posture as check-skills.mjs R8.
    //
    // ORTHOGONAL to the `description` block-scalar ban further down: this rule
    // demands the block BE YAML; that one forbids one particular valid YAML
    // form the agent loader cannot read. Neither implies the other.
    // ------------------------------------------------------------------
    const parsedFm = parseFrontmatterYaml(frontmatter);
    if (!parsedFm.ok) {
      fail(`${agentName}: ${parsedFm.message}`);
      continue;
    }
    parseable++;

    // ------------------------------------------------------------------
    // Required fields check
    // ------------------------------------------------------------------
    const REQUIRED_FIELDS = ['name', 'description', 'model', 'color'];
    const missingFields = REQUIRED_FIELDS.filter((f) => !hasField(frontmatter, f));

    if (missingFields.length === 0) {
      pass(`${agentName}: all required frontmatter fields present`);
    } else {
      fail(`${agentName}: missing frontmatter fields: ${missingFields.join(' ')}`);
    }

    // ------------------------------------------------------------------
    // Format validation (only when fields are present)
    // ------------------------------------------------------------------

    // description: must be an inline value, not a YAML block scalar (> or |)
    if (hasField(frontmatter, 'description')) {
      const descVal = getField(frontmatter, 'description');
      if (descVal === null || /^[>|]/.test(descVal)) {
        const got = descVal ?? '';
        fail(`${agentName}: description must be an inline string, not a YAML block scalar (got: '${got}')`);
      }
    }

    // model: alias (inherit|sonnet|opus|haiku|fable) OR full model ID
    // (claude-{opus|sonnet|haiku|fable}-N[-N][-YYYYMMDD]).
    // Validated against the SSOT exports from agent-frontmatter.mjs (#768) —
    // do not re-declare the alias set or the model-ID regex here.
    // Per https://code.claude.com/docs/en/sub-agents — the canonical doc accepts both.
    if (hasField(frontmatter, 'model')) {
      const modelVal = getField(frontmatter, 'model');
      if (modelVal === null || (!ALLOWED_MODEL_ALIASES.has(modelVal) && !MODEL_ID_RE.test(modelVal))) {
        const got = modelVal ?? '';
        const aliasList = [...ALLOWED_MODEL_ALIASES].join('|');
        fail(`${agentName}: model must be ${aliasList} or a full model ID like 'claude-opus-4-7' or 'claude-sonnet-5' (got: '${got}')`);
      }
    }

    // color: canonical Anthropic palette (red|blue|green|yellow|purple|orange|pink|cyan) plus magenta from plugin-dev SKILL.md.
    // Source: https://code.claude.com/docs/en/sub-agents § Supported frontmatter fields.
    if (hasField(frontmatter, 'color')) {
      const colorVal = getField(frontmatter, 'color');
      const colorRe = /^(blue|cyan|green|yellow|magenta|red|purple|orange|pink)$/;
      if (colorVal === null || !colorRe.test(colorVal)) {
        const got = colorVal ?? '';
        fail(`${agentName}: color must be one of blue|cyan|green|yellow|magenta|red|purple|orange|pink (got: '${got}')`);
      }
    }

    // tools: optional. Accepts BOTH forms per Anthropic canonical:
    //   1. Comma-separated string: `tools: Read, Grep, Glob`
    //   2. JSON array:             `tools: ["Read", "Grep", "Glob"]`
    // Anthropic's own reference agents (plugins/plugin-dev/agents/*) use array form.
    // Reject only YAML block scalars (`>` or `|`) and malformed arrays (e.g. trailing comma, non-string elements).
    if (hasField(frontmatter, 'tools')) {
      const toolsVal = getField(frontmatter, 'tools');
      if (toolsVal !== null && /^[>|]/.test(toolsVal)) {
        fail(`${agentName}: tools must be a comma-separated string or JSON array, not a YAML block scalar (got: '${toolsVal}')`);
      } else if (toolsVal !== null && /^\[/.test(toolsVal)) {
        // JSON-array form — parse and validate each element is a string
        let parsed;
        try {
          parsed = JSON.parse(toolsVal);
        } catch {
          fail(`${agentName}: tools is a malformed JSON array (got: '${toolsVal}')`);
          parsed = null;
        }
        if (parsed !== null) {
          if (!Array.isArray(parsed)) {
            fail(`${agentName}: tools must be an array when using JSON form (got: '${toolsVal}')`);
          } else if (!parsed.every((t) => typeof t === 'string')) {
            fail(`${agentName}: tools array must contain only string elements (got: '${toolsVal}')`);
          }
        }
      }
    }
  }

  if (parseable === mdFiles.length) {
    pass(`all ${mdFiles.length} agent frontmatter blocks parse as YAML mappings`);
  }
}

// ============================================================================
// Check 7: output-schema field (issue #417) + standalone sidecar schemas (#457).
//   (a) When an agent's frontmatter declares `output-schema:`, the referenced
//       JSON schema file must exist, parse as JSON, and compile under AJV 2020.
//   (b) Any `agents/schemas/*.schema.json` file not referenced by an agent
//       (e.g. persona-panel-sidecar.schema.json) is validated as a standalone
//       schema: must parse + compile under AJV 2020.
// Catches broken schemas at plugin-distribution time rather than runtime.
// ============================================================================
console.log('');
console.log('--- Check 7: agent output-schema files ---');

if (existsSync(agentsDir)) {
  const schemaFiles = readdirSync(agentsDir).filter(isAgentDefFile);
  // Collect agents with output-schema declarations.
  const declared = [];
  for (const agentFile of schemaFiles) {
    const filePath = join(agentsDir, agentFile);
    const content = readFileSync(filePath, 'utf8');
    const fm = extractFrontmatter(content);
    if (!fm) continue;
    if (!hasField(fm, 'output-schema')) continue;
    const schemaRel = getField(fm, 'output-schema');
    if (!schemaRel) continue;
    declared.push({ agentFile, schemaRel });
  }

  // Track every schema file referenced via output-schema so the standalone walk
  // below does not double-validate them.
  const referencedSchemaPaths = new Set();
  for (const { schemaRel } of declared) {
    referencedSchemaPaths.add(resolve(agentsDir, schemaRel));
  }

  // Enumerate standalone schemas: any agents/schemas/*.schema.json file not
  // referenced by an agent frontmatter (sidecar / panel / non-agent schemas).
  const standaloneSchemas = [];
  const schemasDir = join(agentsDir, 'schemas');
  if (existsSync(schemasDir)) {
    const allSchemaFiles = readdirSync(schemasDir).filter((f) => f.endsWith('.schema.json'));
    for (const schemaFile of allSchemaFiles) {
      const absPath = resolve(schemasDir, schemaFile);
      if (referencedSchemaPaths.has(absPath)) continue;
      standaloneSchemas.push({ schemaFile, absPath });
    }
  }

  if (declared.length === 0 && standaloneSchemas.length === 0) {
    // No agents declare output-schema yet and no standalone schemas exist — skip silently.
  } else {
    // Lazy-load shared AJV 2020 instance (W3-Q2 MED-004 fold-in).
    let ajvInstance = null;
    try {
      const { getAjv2020 } = await import('../ajv-loader.mjs');
      ajvInstance = await getAjv2020({ allErrors: true, strict: false });
    } catch (err) {
      fail(`output-schema check: could not load ajv-loader — ${err.message}`);
    }

    if (ajvInstance) {
      // (a) Agent-referenced schemas
      for (const { agentFile, schemaRel } of declared) {
        // Resolve schema path relative to agentsDir (e.g. "schemas/code-implementer.schema.json").
        const schemaPath = resolve(agentsDir, schemaRel);
        if (!existsSync(schemaPath)) {
          fail(`${agentFile}: output-schema file not found: ${schemaRel}`);
          continue;
        }
        let raw;
        try {
          raw = readFileSync(schemaPath, 'utf8');
        } catch (err) {
          fail(`${agentFile}: output-schema read error: ${err.message}`);
          continue;
        }
        let schema;
        try {
          schema = JSON.parse(raw);
        } catch (err) {
          fail(`${agentFile}: output-schema parse error: ${err.message}`);
          continue;
        }
        try {
          ajvInstance.compile(schema);
          pass(`${agentFile}: output-schema validates`);
        } catch (err) {
          fail(`${agentFile}: output-schema error: ${err.message}`);
        }
      }

      // (b) Standalone schemas (#457: sidecar / panel / non-agent-named).
      for (const { schemaFile, absPath } of standaloneSchemas) {
        let raw;
        try {
          raw = readFileSync(absPath, 'utf8');
        } catch (err) {
          fail(`${schemaFile}: standalone schema read error: ${err.message}`);
          continue;
        }
        let schema;
        try {
          schema = JSON.parse(raw);
        } catch (err) {
          fail(`${schemaFile}: standalone schema parse error: ${err.message}`);
          continue;
        }
        try {
          ajvInstance.compile(schema);
          pass(`agents/schemas/${schemaFile}: Draft 2020-12 compiles OK (standalone)`);
        } catch (err) {
          fail(`${schemaFile}: standalone schema compile error: ${err.message}`);
        }
      }
    }
  }
}

// ============================================================================
// Check 8: sandbox-tier field (issue #418) — when present, value must be in
// TIER_ENUM and must be consistent with the agent's tools list.
// When absent, emit WARN with the inferred tier (not FAIL — backward-compat).
// ============================================================================
console.log('');
console.log('--- Check 8: agent sandbox-tier ---');

if (existsSync(agentsDir)) {
  const { TIER_ENUM, inferTierFromTools, validateTierConsistency } = await getTierModule();

  const allMdFiles = readdirSync(agentsDir).filter(isAgentDefFile);
  for (const agentFile of allMdFiles) {
    const filePath = join(agentsDir, agentFile);
    const content = readFileSync(filePath, 'utf8');
    const fm = extractFrontmatter(content);
    if (!fm) continue; // already caught by Check 6

    const toolsVal = getField(fm, 'tools');
    const toolsArray = parseToolsValue(toolsVal);
    const inferred = inferTierFromTools(toolsArray);

    if (!hasField(fm, 'sandbox-tier')) {
      warn(`${agentFile}: sandbox-tier missing — inferred=${inferred}`);
      continue;
    }

    const declared = getField(fm, 'sandbox-tier');
    if (!declared) {
      fail(`${agentFile}: sandbox-tier field is empty`);
      continue;
    }

    if (!TIER_ENUM.includes(declared)) {
      fail(`${agentFile}: sandbox-tier "${declared}" is not valid; must be one of: ${TIER_ENUM.join(', ')}`);
      continue;
    }

    const consistency = validateTierConsistency({ declared, inferred, tools: toolsArray });
    if (!consistency.ok) {
      fail(`${agentFile}: sandbox-tier mismatch — ${consistency.error}`);
      continue;
    }

    pass(`${agentFile}: sandbox-tier OK (${declared})`);
  }
}

// ============================================================================
// Check 9: color-collision aggregation (issue #443).
//   The 9-color palette is an operator side-channel (distinguishes co-running
//   agents at a glance). With more than 9 agents, colors are deliberately
//   shared — but two DISPATCHABLE agents sharing a color is a likely
//   same-wave collision and surfaces as a WARN (not FAIL: deliberate
//   cross-phase shares are legitimate — see agents/AGENTS.md § Color
//   Allocation Strategy).
//   Non-dispatchable reference docs (description contains "NOT a dispatchable"
//   or "Reference documentation") are excluded from the aggregation: they
//   never dispatch as a subagent, so their color can never collide on screen.
// ============================================================================
console.log('');
console.log('--- Check 9: agent color collisions ---');

if (existsSync(agentsDir)) {
  const colorMap = new Map(); // color -> [agentFile, ...]
  const colorMdFiles = readdirSync(agentsDir).filter(isAgentDefFile);
  for (const agentFile of colorMdFiles) {
    const filePath = join(agentsDir, agentFile);
    const content = readFileSync(filePath, 'utf8');
    const fm = extractFrontmatter(content);
    if (!fm) continue; // already caught by Check 6

    const description = getField(fm, 'description') ?? '';
    const isNonDispatchable =
      /NOT a dispatchable/i.test(description) || /Reference documentation/i.test(description);
    if (isNonDispatchable) continue;

    const colorVal = getField(fm, 'color');
    if (!colorVal) continue; // missing/invalid color already caught by Check 6

    if (!colorMap.has(colorVal)) colorMap.set(colorVal, []);
    colorMap.get(colorVal).push(agentFile);
  }

  let collisions = 0;
  for (const [color, names] of colorMap) {
    if (names.length > 1) {
      collisions++;
      warn(`color collision: ${color} shared by dispatchable agents ${names.sort().join(', ')} — confirm they never co-run in one wave (agents/AGENTS.md § Color Allocation Strategy)`);
    }
  }
  if (collisions === 0) {
    pass('no color collisions among dispatchable agents');
  }
}

// ============================================================================
// Check 10: PSA-007 git-write ban on repo-write agents (#724).
//   Every agent that can write the repo (tools list contains an *Edit tool AND
//   Write) MUST carry the subagent git-write prohibition in its BODY: a
//   `PSA-007` reference plus the explicit `git stash` ban line. The git index
//   and stash are shared working-copy resources — a dispatched agent that
//   stages or stashes races its siblings and can silently discard their
//   work-in-progress (.claude/rules/parallel-sessions.md § PSA-007).
//   Structural invariant, so it lives in the gate rather than in a test
//   (.claude/rules/test-value.md § TV-005). Bug it catches: a NEW repo-write
//   agent ships with no ban — exactly the docs-writer gap #724 closed.
//   Agents are discovered dynamically; no hardcoded roster to drift.
// ============================================================================
console.log('');
console.log('--- Check 10: PSA-007 git-write ban (repo-write agents) ---');

if (existsSync(agentsDir)) {
  const psaMdFiles = readdirSync(agentsDir).filter(isAgentDefFile);
  let repoWriteCount = 0;

  for (const agentFile of psaMdFiles) {
    const filePath = join(agentsDir, agentFile);
    const content = readFileSync(filePath, 'utf8');
    const fm = extractFrontmatter(content);
    if (!fm) continue; // already caught by Check 6

    const toolsArray = parseToolsValue(getField(fm, 'tools'));
    // *Edit covers Edit / MultiEdit / NotebookEdit — all repo-mutating.
    const canEdit = toolsArray.some((t) => /Edit$/.test(t));
    if (!canEdit || !toolsArray.includes('Write')) continue;

    repoWriteCount++;

    // Body only: a `description:` that happens to mention PSA-007 must not
    // satisfy the ban — the instruction has to reach the agent's rules.
    const body = content.slice(content.indexOf(`\n---`, 3) + 4);
    const missing = [];
    if (!body.includes('PSA-007')) missing.push('a PSA-007 reference');
    if (!body.includes('git stash')) missing.push('the `git stash` ban line');

    if (missing.length > 0) {
      fail(
        `${agentFile}: repo-write agent (Edit+Write) is missing ${missing.join(' and ')} ` +
          '— see .claude/rules/parallel-sessions.md § PSA-007 and agents/AGENTS.md § Authoring Convention',
      );
    } else {
      pass(`${agentFile}: PSA-007 git-write ban present`);
    }
  }

  if (repoWriteCount === 0) {
    // No repo-write agents in this plugin root — nothing to enforce.
    console.log('  (no repo-write agents found — check skipped)');
  }
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);

process.exit(failed > 0 ? 1 : 0);
