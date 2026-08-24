/**
 * tests/scripts/validate/check-agents.test.mjs
 *
 * Integration tests for scripts/lib/validate/check-agents.mjs.
 * Spawns the script as a child process and verifies exit codes + output shape.
 *
 * Shape (consolidated, issue #985 Tier B): every per-rule fixture case is a row
 * in the RULE_CASES table below. Each row spawns the checker ONCE and asserts a
 * normalized verdict `{ status, missing, echoed }` against a hardcoded literal —
 * strictly stronger than the previous per-rule pairs, which spawned the same
 * fixture twice (once for the exit code, once for the message) and could not
 * catch a checker that emitted the right message with the wrong exit code.
 *
 * The Check-9 color-collision cases (#443) were folded in from the former
 * tests/unit/check-agents.test.mjs, which is deleted — it exercised the same
 * script with the same fixture class and the same assertion target.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/lib/validate/check-agents.mjs',
);
const PLUGIN_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function run(pluginRoot) {
  return spawnSync('node', [SCRIPT, pluginRoot], { encoding: 'utf8', timeout: 15_000 });
}

function makeFixture(agents) {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-agents-'));
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(dir, 'agents'), { recursive: true });
  writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'test-plugin', version: '1.0.0' }));
  for (const [filename, content] of Object.entries(agents)) {
    writeFileSync(path.join(dir, 'agents', filename), content);
  }
  return dir;
}

/**
 * Normalize a checker run into a comparable verdict.
 * `missing`  — expected stdout needles that were NOT emitted.
 * `echoed`   — forbidden stdout needles that WERE emitted.
 * Both are empty arrays in the healthy case, so every row's expected value is a
 * hardcoded literal and no branching happens inside the test body.
 */
function verdict(r, { expectStdout = [], forbidStdout = [] } = {}) {
  return {
    status: r.status,
    missing: expectStdout.filter((n) => !r.stdout.includes(n)),
    echoed: forbidStdout.filter((n) => r.stdout.includes(n)),
  };
}

/**
 * YAML-quote a scalar unless the caller deliberately passed a block scalar.
 *
 * The callers below pass JS strings — their quotes are JavaScript's, not YAML's.
 * Interpolating such a value raw produces `description: Use this … <example>Context: …`,
 * an unquoted scalar with a `: ` inside, which is not a valid mapping entry. That
 * was invisible until Check 6 gained a js-yaml parse rule on 2026-08-15; three
 * Check-9 fixtures then failed for a defect in the harness, not in the code under
 * test. Quoting here fixes all of them at the one place that owns YAML emission.
 *
 * A leading `>` or `|` is passed through untouched: the block-scalar fixture exists
 * precisely to prove Check 11 still rejects that form, and quoting it would make
 * that test assert nothing.
 */
function yamlScalar(value) {
  const s = String(value);
  if (/^\s*[>|]/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

/** Frontmatter body for a well-formed agent, parameterized by the fields under test. */
function agentMd({ name, description = 'Some description inline here', model = 'inherit', color = 'blue', tools }) {
  return [
    '---',
    `name: ${name}`,
    `description: ${yamlScalar(description)}`,
    `model: ${model}`,
    `color: ${color}`,
    ...(tools === undefined ? [] : [`tools: ${tools}`]),
    '---',
    '',
  ].join('\n');
}

// The description is single-quoted, and that is load-bearing rather than
// cosmetic: it carries `<example>Context: `, and an unquoted YAML scalar with a
// `: ` inside is not a valid mapping entry. This fixture was unquoted until
// 2026-08-15 and passed, because check-agents.mjs read the frontmatter with
// line regexes and never asked whether it was YAML at all — the same blind spot
// that let 14 of 16 real agents/*.md ship unparseable. Once Check 6 gained a
// js-yaml parse rule, this fixture failed with the production defect's own
// message. Quoting it is the fix; loosening the rule would have re-opened the
// hole. Apostrophes inside a single-quoted scalar double (`''`).
const VALID_AGENT = `---
name: my-agent
description: 'Use this agent when you need to do something. <example>Context: user: "do it" assistant: "done"</example>'
model: inherit
color: blue
tools: Read, Edit, Write
---

# My Agent

- Do NOT run ANY git write operation (\`git add\`, \`git commit\`, \`git stash\`,
  \`git push\`) — the index and stash are shared session resources (PSA-007);
  the coordinator handles ALL VCS operations.
`;

const MISSING_NAME_AGENT = `---
description: Some description inline here
model: inherit
color: blue
---
`;

const BLOCK_SCALAR_AGENT = `---
name: bad-desc
description: >
  This is a block scalar description
  that spans multiple lines.
model: inherit
color: blue
---
`;

// The bug this fixture names (#1029): an agent file whose description silently
// LOSES 96% of its text is green today. This is `agents/eval-judge.md`'s exact
// pre-fix shape — an UNQUOTED scalar whose ` #803` opens a YAML comment, so
// js-yaml returns 51 of 1,180 characters (measured 2026-08-24) and the agent
// picker sees only the stub. Every other rule in the gate passed on it: the
// block is valid YAML, `description` is present and is not a block scalar.
//
// Load-bearing detail — the text BEFORE the ` #` carries no `: `, and the
// `<example>Context: ` that would make the block unparseable sits AFTER it.
// That is precisely why the defect hid: the comment swallows the invalid part,
// so the Check-6 js-yaml parse rule never fires. Moving the hash later would
// turn this into a parse-error fixture and stop testing the truncation rule.
const TRUNCATED_DESC_AGENT = `---
name: truncated-desc
description: Use this agent during the /eval Skill Phase 3 (Epic #803, issue #810) to judge a record slice. <example>Context: user "judge" assistant "judged"</example>
model: inherit
color: blue
---
`;

const NO_COLLISION_PASS = '  PASS: no color collisions among dispatchable agents';

// ---------------------------------------------------------------------------
// Per-rule fixture table — one spawn per row, verdict asserted as a literal.
// ---------------------------------------------------------------------------

const RULE_CASES = [
  // --- required fields ---
  {
    name: 'missing `name` frontmatter field FAILs',
    agents: { 'bad-agent.md': MISSING_NAME_AGENT },
    expected: { status: 1, missing: [], echoed: [] },
    expectStdout: ['  FAIL: bad-agent.md: missing frontmatter fields: name'],
  },
  {
    name: 'fully valid agent PASSes',
    agents: { 'good-agent.md': VALID_AGENT },
    expected: { status: 0, missing: [], echoed: [] },
    expectStdout: ['  PASS: good-agent.md: all required frontmatter fields present'],
  },

  // --- tools field (string form is covered by VALID_AGENT above) ---
  {
    name: 'tools as a JSON array of strings is accepted (Anthropic canonical form)',
    agents: { 'array-tools.md': agentMd({ name: 'array-tools', tools: '["Read", "Edit", "Grep"]' }) },
    expected: { status: 0, missing: [], echoed: [] },
  },
  {
    name: 'tools array with a non-string element FAILs',
    agents: { 'bad-array-tools.md': agentMd({ name: 'bad-array-tools', tools: '["Read", 42, "Grep"]' }) },
    expected: { status: 1, missing: [], echoed: [] },
    expectStdout: ['tools array must contain only string elements'],
  },
  {
    name: 'tools as malformed JSON (trailing comma) FAILs',
    agents: { 'malformed-tools.md': agentMd({ name: 'malformed-tools', tools: '["Read", "Edit",]' }) },
    expected: { status: 1, missing: [], echoed: [] },
    expectStdout: ['malformed JSON array'],
  },

  // --- description ---
  {
    name: 'description as a YAML block scalar (>) FAILs',
    agents: { 'bad-desc.md': BLOCK_SCALAR_AGENT },
    expected: { status: 1, missing: [], echoed: [] },
    expectStdout: ['  FAIL: bad-desc.md: description must be an inline string, not a YAML block scalar'],
  },
  {
    name: 'description truncated by an unquoted ` #` FAILs with the parsed-vs-raw lengths (#1029)',
    agents: { 'truncated-desc.md': TRUNCATED_DESC_AGENT },
    expected: { status: 1, missing: [], echoed: [] },
    expectStdout: [
      "  FAIL: truncated-desc.md: description is silently truncated by an unquoted ' #' — YAML parses 51 of 154 chars",
      'quote the description',
    ],
  },
  {
    name: 'a QUOTED description containing ` #` parses in full and is NOT flagged (#1029)',
    agents: {
      'quoted-hash.md': agentMd({
        name: 'quoted-hash',
        description:
          'Use this agent during the /eval Skill Phase 3 (Epic #803, issue #810) to judge a record slice. <example>Context: user "judge" assistant "judged"</example>',
      }),
    },
    expected: { status: 0, missing: [], echoed: [] },
    forbidStdout: ['silently truncated'],
  },

  // --- model: aliases, full IDs, and rejected shapes (#768) ---
  {
    name: 'model gpt-4 (foreign vendor) FAILs with the allowed-values message',
    agents: { 'bad-model.md': agentMd({ name: 'bad-model', model: 'gpt-4' }) },
    expected: { status: 1, missing: [], echoed: [] },
    expectStdout: [
      "FAIL: bad-model.md: model must be inherit|sonnet|opus|haiku|fable or a full model ID like 'claude-opus-4-7' or 'claude-sonnet-5' (got: 'gpt-4')",
    ],
  },
  {
    name: 'model claude-opus-4-7 (three-part full ID) is accepted',
    agents: { 'full-id.md': agentMd({ name: 'full-id', model: 'claude-opus-4-7' }) },
    expected: { status: 0, missing: [], echoed: [] },
  },
  {
    name: 'model claude-sonnet-4-6 (three-part full ID) is accepted',
    agents: { 'sonnet-id.md': agentMd({ name: 'sonnet-id', model: 'claude-sonnet-4-6' }) },
    expected: { status: 0, missing: [], echoed: [] },
  },
  {
    name: 'model claude-haiku-4-5-20251001 (dated full ID) is accepted',
    agents: { 'dated-id.md': agentMd({ name: 'dated-id', model: 'claude-haiku-4-5-20251001' }) },
    expected: { status: 0, missing: [], echoed: [] },
  },
  {
    name: 'model claude-sonnet-5 (two-part ID, #768) is accepted',
    agents: { 'sonnet-5-id.md': agentMd({ name: 'sonnet-5-id', model: 'claude-sonnet-5' }) },
    expected: { status: 0, missing: [], echoed: [] },
  },
  {
    name: 'model claude-fable-5 (fable family, #768) is accepted',
    agents: { 'fable-5-id.md': agentMd({ name: 'fable-5-id', model: 'claude-fable-5' }) },
    expected: { status: 0, missing: [], echoed: [] },
  },
  {
    name: 'model claude-opus-4-8 (three-part ID) is accepted',
    agents: { 'opus-4-8-id.md': agentMd({ name: 'opus-4-8-id', model: 'claude-opus-4-8' }) },
    expected: { status: 0, missing: [], echoed: [] },
  },
  {
    name: 'model claude-fable (no numeric group) FAILs',
    agents: { 'bad-fable.md': agentMd({ name: 'bad-fable', model: 'claude-fable' }) },
    expected: { status: 1, missing: [], echoed: [] },
  },
  {
    name: 'model claude-5-fable (family token out of position) FAILs',
    agents: { 'bad-order.md': agentMd({ name: 'bad-order', model: 'claude-5-fable' }) },
    expected: { status: 1, missing: [], echoed: [] },
  },

  // --- color palette ---
  {
    name: 'color turquoise (outside the canonical palette) FAILs with the allowed-values message',
    agents: { 'bad-color.md': agentMd({ name: 'bad-color', color: 'turquoise' }) },
    expected: { status: 1, missing: [], echoed: [] },
    expectStdout: [
      "FAIL: bad-color.md: color must be one of blue|cyan|green|yellow|magenta|red|purple|orange|pink (got: 'turquoise')",
    ],
  },
  {
    name: 'color purple is accepted',
    agents: { 'purple-agent.md': agentMd({ name: 'purple-agent', color: 'purple' }) },
    expected: { status: 0, missing: [], echoed: [] },
  },
  {
    name: 'color orange is accepted',
    agents: { 'orange-agent.md': agentMd({ name: 'orange-agent', color: 'orange' }) },
    expected: { status: 0, missing: [], echoed: [] },
  },
  {
    name: 'color pink is accepted',
    agents: { 'pink-agent.md': agentMd({ name: 'pink-agent', color: 'pink' }) },
    expected: { status: 0, missing: [], echoed: [] },
  },

  // --- Check 9: color-collision aggregation (#443, folded in from tests/unit/) ---
  {
    name: 'Check 9: two dispatchable agents sharing a color WARN (exit 0, not FAIL)',
    agents: {
      'alpha.md': agentMd({
        name: 'alpha',
        description: 'Use this agent to do alpha work inline. <example>Context: user: "alpha" assistant: "done"</example>',
        color: 'green',
      }),
      'beta.md': agentMd({
        name: 'beta',
        description: 'Use this agent to do beta work inline. <example>Context: user: "beta" assistant: "done"</example>',
        color: 'green',
      }),
    },
    expected: { status: 0, missing: [], echoed: [] },
    expectStdout: ['WARN: color collision: green shared by dispatchable agents alpha.md, beta.md'],
    forbidStdout: [NO_COLLISION_PASS],
  },
  {
    name: 'Check 9: a dispatchable sharing a color with a non-dispatchable reference doc does NOT warn',
    agents: {
      'gamma.md': agentMd({
        name: 'gamma',
        description: 'Use this agent to do gamma work inline. <example>Context: user: "gamma" assistant: "done"</example>',
        color: 'cyan',
      }),
      'ref-doc.md': agentMd({
        name: 'ref-doc',
        description:
          'Reference documentation (NOT a dispatchable agent) for a coordinator-direct flow. <example>Context: user: "ref" assistant: "noted"</example>',
        color: 'cyan',
      }),
    },
    expected: { status: 0, missing: [], echoed: [] },
    expectStdout: [NO_COLLISION_PASS],
    forbidStdout: ['WARN: color collision'],
  },
  {
    name: 'Check 9: two dispatchable agents with DISTINCT colors emit the PASS line',
    agents: {
      'one.md': agentMd({
        name: 'one',
        description: 'Use this agent for one thing inline. <example>Context: user: "one" assistant: "done"</example>',
        color: 'green',
      }),
      'two.md': agentMd({
        name: 'two',
        description: 'Use this agent for two things inline. <example>Context: user: "two" assistant: "done"</example>',
        color: 'blue',
      }),
    },
    expected: { status: 0, missing: [], echoed: [] },
    expectStdout: [NO_COLLISION_PASS],
    forbidStdout: ['WARN: color collision'],
  },
];

describe('check-agents.mjs — per-rule fixture verdicts', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it.each(RULE_CASES)('$name', ({ agents, expected, expectStdout, forbidStdout }) => {
    dir = makeFixture(agents);
    expect(verdict(run(dir), { expectStdout, forbidStdout })).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Smoke — current repo
// ---------------------------------------------------------------------------

describe('check-agents.mjs — smoke against current repo', () => {
  it('exits 0 with 0 failed checks and one PASS line per agent file', () => {
    const r = run(PLUGIN_REPO);
    const passLines = r.stdout.split('\n').filter((l) => l.startsWith('  PASS:'));
    const match = r.stdout.match(/Results:\s+\d+\s+passed,\s+(\d+)\s+failed/);
    expect(r.status).toBe(0);
    expect(passLines.length).toBeGreaterThanOrEqual(7);
    expect(match).not.toBeNull();
    expect(parseInt(match[1], 10)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SSOT drift-guard (#768): check-agents.mjs must import the model-alias Set
// and model-ID regex from agent-frontmatter.mjs rather than re-declaring its
// own copy. A re-declared inline regex is exactly the drift class #768 fixed
// (the script's palette had drifted out of sync with the SSOT, missing
// "fable" and the two-part Claude-5-shaped ID form).
// ---------------------------------------------------------------------------

/**
 * Detects a re-introduced inline `claude-(opus|sonnet|haiku...)` family regex
 * literal in a script's source text, ignoring the sanctioned SSOT import line
 * itself. Extracted as a standalone function so the fake-regression check
 * below can exercise it against a synthetic drifted fixture without touching
 * production code.
 */
function hasInlineModelFamilyRegex(source) {
  const linesWithoutSsotImport = source.split('\n').filter((l) => !l.includes("from '../agent-frontmatter.mjs'"));
  return linesWithoutSsotImport.some((l) => /claude-\(opus\|sonnet\|haiku/.test(l));
}

describe('check-agents.mjs — model-regex SSOT drift guard (#768)', () => {
  const SCRIPT_SOURCE = readFileSync(SCRIPT, 'utf8');

  it('imports ALLOWED_MODEL_ALIASES and MODEL_ID_RE from agent-frontmatter.mjs', () => {
    expect(SCRIPT_SOURCE).toContain("import { ALLOWED_MODEL_ALIASES, MODEL_ID_RE } from '../agent-frontmatter.mjs'");
  });

  it('the actual check-agents.mjs source has no reintroduced inline model-family regex', () => {
    expect(hasInlineModelFamilyRegex(SCRIPT_SOURCE)).toBe(false);
  });

  it('fake-regression: the drift-guard detector DOES flag a synthetic fixture with a reintroduced inline regex', () => {
    // Proves the detector is not a tautology — it goes "red" (detects true)
    // against a fixture shaped like the pre-#768 drift (own regex literal,
    // no SSOT import), and pins that the guard would have caught it.
    const driftedFixture =
      "import { readFileSync } from 'node:fs';\n" +
      "const MODEL_RE = /^claude-(opus|sonnet|haiku)-\\d+$/;\n" +
      "if (MODEL_RE.test(modelVal)) { /* ... */ }\n";
    expect(hasInlineModelFamilyRegex(driftedFixture)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Missing plugin-root argument
// ---------------------------------------------------------------------------

describe('check-agents.mjs — missing argument', () => {
  it('exits 1 with the usage message on stderr when no plugin-root arg is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage: check-agents.mjs <plugin-root>');
  });
});
