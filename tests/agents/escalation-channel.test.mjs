/**
 * tests/agents/escalation-channel.test.mjs
 *
 * #1051 (FA-2) — the `SendMessage` escalation-channel allowlist, pinned on the
 * REAL agent definitions in `agents/`.
 *
 * Bug class this locks in (TV-001), in both directions:
 *
 *   (a) REMOVAL. A diff that strips `, SendMessage` from one of the six
 *       allowlisted `tools:` lines passes every existing check —
 *       `scripts/lib/validate/check-agents.mjs` validates sandbox-tier
 *       CONSISTENCY, never allowlist MEMBERSHIP, and
 *       `tests/unit/sandbox-tier.test.mjs` exercises a SYNTHETIC tool array,
 *       not the shipped files. The escalation channel would silently revert to
 *       pre-#1051 behaviour: an agent that hits a wave-blocking obstacle goes
 *       quiet until its final report. Because CSM-005 mandates SILENT
 *       degradation, that absence is indistinguishable from "no obstacle
 *       occurred" — no runtime error, no gate, no test.
 *
 *   (b) ADDITION. A future agent (or a well-meaning edit) grants `SendMessage`
 *       to one of the eight analysis agents. `agents/AGENTS.md` § Escalation
 *       Channel (#1051) states the Nicht-Liste is "deliberate, not an
 *       oversight" — their output is a judgment over a whole corpus, so an
 *       early message carries an unfinished verdict the coordinator cannot act
 *       on. Prose alone does not stop that edit; the third group here does.
 *
 * The body assertions are not prose-pinning (TV-002c): the escalation contract
 * IS the agent's behaviour — the paragraph is the only thing that makes the
 * tool a one-shot upward channel rather than a chat. They therefore match the
 * load-bearing tokens (`SendMessage` → `main`, "never wait for a reply",
 * CSM-001 / "upward only") inside a bounded window, never whole sentences, so
 * reasonable rewording survives.
 *
 * Frontmatter is read with a real YAML parser (js-yaml, CORE_SCHEMA) rather
 * than a `^tools:` line regex — see .claude/rules/
 * anti-pattern-a-line-regex-frontmatter-validator-is-blind-*.md.
 *
 * Falsification proof (2026-08-25, re-runnable): three temporary cases copied a
 * real agent file into a mkdtemp fixture dir, mutated the copy, and pointed
 * `readAgentDoc`'s `agentsDir` parameter at it — no `agents/*.md` was touched.
 * Each mutation turned the corresponding group RED:
 *   - strip `, SendMessage` from code-implementer  → group 1: "expected
 *     [ 'Read', 'Edit', 'Write', …(4) ] to include 'SendMessage'"
 *   - add SendMessage to analyst                   → group 3: "expected
 *     [ Array(5) ] to not include 'SendMessage'"
 *   - delete "NEVER wait for a reply (CSM-004);" from test-writer → group 2:
 *     "expected 'SendMessage` to `main` carrying your …' to match
 *     /never wait for a reply/i"
 * The `agentsDir` parameter exists for exactly this re-proof.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');

/** SSOT: agents/AGENTS.md § Escalation Channel (#1051) — "The allowlist is exactly:" */
const ESCALATION_ALLOWLIST = [
  'code-implementer',
  'db-specialist',
  'ui-developer',
  'test-writer',
  'docs-writer',
  'session-reviewer',
];

/** SSOT: agents/AGENTS.md § Escalation Channel — "The Nicht-Liste is deliberate, not an oversight." */
const NICHT_LISTE = [
  'analyst',
  'qa-strategist',
  'architect-reviewer',
  'security-reviewer',
  'ux-evaluator',
  'eval-judge',
  'skill-applied-judge',
  'dialectic-deriver',
];

/** Mirrors FRONTMATTER_RE in scripts/lib/agent-frontmatter.mjs — delimiter split only. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Reads an agent definition and splits it into parsed frontmatter + raw body.
 * `agentsDir` is a parameter so a falsification run can point at a fixture copy.
 */
function readAgentDoc(name, agentsDir = AGENTS_DIR) {
  const file = path.join(agentsDir, `${name}.md`);
  const contents = readFileSync(file, 'utf8');
  const match = FRONTMATTER_RE.exec(contents);
  if (match === null) throw new Error(`${file}: no YAML frontmatter block`);
  return {
    frontmatter: yaml.load(match[1], { schema: yaml.CORE_SCHEMA }),
    body: match[2],
  };
}

/**
 * Exact tool tokens from a parsed `tools:` value. AGENTS.md accepts both the
 * comma-separated string (preferred) and a YAML sequence, so both are handled;
 * token equality — never substring — is what makes the Nicht-Liste assertions
 * bite on a look-alike name.
 */
function toolsOf(frontmatter) {
  const raw = frontmatter?.tools;
  if (Array.isArray(raw)) return raw.map(t => String(t).trim()).filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').map(t => t.trim()).filter(Boolean);
  return [];
}

/**
 * The first bounded window starting at a BODY occurrence of `SendMessage` that
 * also names the coordinator target `main`. Body-only, mirroring
 * tests/lib/validate/check-agents-psa-007.test.mjs § "does not accept a
 * PSA-007 mention in frontmatter as the ban" — the contract has to reach the
 * agent's rules, not just its `tools:` line.
 *
 * 400 chars: the widest measured span from `SendMessage` to `CSM-001` across
 * the six files is 247 (session-reviewer), so this carries ~60% headroom while
 * still forbidding a `SendMessage` mention whose caveats sit sections away.
 */
const CONTRACT_WINDOW = 400;

function escalationWindow(body) {
  const windows = [];
  for (let i = body.indexOf('SendMessage'); i !== -1; i = body.indexOf('SendMessage', i + 1)) {
    windows.push(body.slice(i, i + CONTRACT_WINDOW));
  }
  return windows.find(w => /\bmain\b/.test(w)) ?? null;
}

// ─── Group 1: the six allowlisted agents DECLARE the tool ────────────────────

describe('#1051 — escalation allowlist declares SendMessage', () => {
  it.each(ESCALATION_ALLOWLIST)(
    'agents/%s.md lists SendMessage as an exact tools: token',
    name => {
      const { frontmatter } = readAgentDoc(name);
      expect(toolsOf(frontmatter), `agents/${name}.md tools: lost SendMessage`).toContain('SendMessage');
    },
  );
});

// ─── Group 2: the six carry the escalation CONTRACT in their body ────────────

describe('#1051 — escalation allowlist carries the upward-only contract in its body', () => {
  it.each(ESCALATION_ALLOWLIST)(
    'agents/%s.md body pairs SendMessage with main, "never wait for a reply", and CSM-001',
    name => {
      const { body } = readAgentDoc(name);
      const window = escalationWindow(body);
      expect(window, `agents/${name}.md body has no SendMessage→main escalation paragraph`).toBeTypeOf('string');
      expect(window, `agents/${name}.md dropped the CSM-004 no-wait clause`).toMatch(/never wait for a reply/i);
      expect(window, `agents/${name}.md dropped the CSM-001 upward-only clause`).toMatch(/CSM-001|upward only/i);
    },
  );
});

// ─── Group 3: the Nicht-Liste does NOT get the tool ──────────────────────────

describe('#1051 — Nicht-Liste analysis agents do not get SendMessage', () => {
  it.each(NICHT_LISTE)(
    'agents/%s.md tools: does not contain SendMessage',
    name => {
      const { frontmatter } = readAgentDoc(name);
      expect(
        toolsOf(frontmatter),
        `agents/${name}.md joined the escalation channel; AGENTS.md § Escalation Channel calls the Nicht-Liste deliberate`,
      ).not.toContain('SendMessage');
    },
  );
});

// ─── Group 4: the negative assertion above is not vacuous ────────────────────
// .claude/rules/testing.md § "Negative-Assertion Fake-Regression Check": a green
// "X is NOT present" test proves nothing until the predicate is shown to bite.

describe('#1051 — the tools-membership predicate bites', () => {
  it('reads a YAML sequence tools: value as exact tokens', () => {
    // AGENTS.md accepts the array shape too. A string-only helper would return
    // [] here and make all eight Nicht-Liste assertions pass vacuously.
    expect(toolsOf({ tools: ['Read', 'Grep', 'SendMessage'] })).toEqual(['Read', 'Grep', 'SendMessage']);
  });

  it('does not count a look-alike tool name as SendMessage', () => {
    // A substring predicate (`tools.includes('SendMessage')`) would pass an
    // analysis agent that declared SendMessageDraft straight through group 3.
    expect(toolsOf({ tools: 'Read, Grep, SendMessageDraft' })).toEqual(['Read', 'Grep', 'SendMessageDraft']);
  });
});
