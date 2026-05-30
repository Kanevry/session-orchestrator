#!/usr/bin/env node
// check-subagent-types.mjs — Validate that every
// `subagent_type: "session-orchestrator:<X>"` reference under skills/** resolves
// to an existing agents/<X>.md definition.
//
// Rationale (#614): the session-end auto-dream / auto-dialectic phases shipped
// Agent() dispatch blocks pointing at `subagent_type`s (`memory-cleanup`,
// `evolve`) that were never built. The dead references stayed silent for 7+
// sessions because no mechanical guard asserted dispatch-target existence — the
// symptom was a recurring "auto-dream/dialectic SKIPPED (agent-types
// unavailable)" line in session memories. This validator closes that gap so a
// future dead dispatch reference fails plugin validation instead of shipping.
//
// Usage: check-subagent-types.mjs <plugin-root>
// Outputs lines of the form "  PASS: ..." / "  FAIL: ...".
// Exit 0 = all references resolve; exit 1 = at least one unresolved reference.
//
// Scope: only the `session-orchestrator:` plugin namespace is checked — refs to
// other plugins' agents cannot be validated from here and are ignored.
//
// Inline-ignore: a source line containing the marker `check-subagent-types:ignore`
// is skipped, so prose may document a historical / example dead reference without
// failing the gate (mirrors the repo's `consistency:exempt:` convention).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const IGNORE_MARKER = 'check-subagent-types:ignore';
const REF_RE = /subagent_type:\s*["']session-orchestrator:([a-z0-9-]+)["']/g;

/**
 * Collect every `subagent_type: "session-orchestrator:<X>"` reference under a
 * skills directory tree, recording the agent name and the file:line where it
 * appears. Lines carrying the inline-ignore marker are skipped.
 *
 * @param {string} skillsDir
 * @returns {Array<{agent: string, file: string, line: number}>}
 */
export function collectSubagentTypeRefs(skillsDir) {
  const refs = [];
  walk(skillsDir);
  return refs;

  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const lines = readFileSync(full, 'utf8').split(/\r?\n/);
        lines.forEach((text, idx) => {
          if (text.includes(IGNORE_MARKER)) return;
          REF_RE.lastIndex = 0;
          let m;
          while ((m = REF_RE.exec(text)) !== null) {
            refs.push({ agent: m[1], file: full, line: idx + 1 });
          }
        });
      }
    }
  }
}

/**
 * Run the validator against a plugin root. Prints PASS/FAIL lines and a Results
 * summary; returns the process exit code (0 = all references resolve, 1 = at
 * least one unresolved).
 *
 * @param {string} pluginRoot
 * @returns {number}
 */
export function runCheckSubagentTypes(pluginRoot) {
  const skillsDir = join(pluginRoot, 'skills');
  const agentsDir = join(pluginRoot, 'agents');
  let passed = 0;
  let failed = 0;
  const pass = (msg) => { console.log(`  PASS: ${msg}`); passed++; };
  const fail = (msg) => { console.log(`  FAIL: ${msg}`); failed++; };

  console.log('--- Check: subagent_type references resolve to agent definitions ---');

  if (!existsSync(skillsDir)) {
    // No skills directory — nothing to validate (vacuously OK).
    pass('no skills/ directory — no subagent_type references to check');
  } else {
    const refs = collectSubagentTypeRefs(skillsDir);
    if (refs.length === 0) {
      pass('no subagent_type references found in skills/');
    } else {
      const byAgent = new Map();
      for (const r of refs) {
        if (!byAgent.has(r.agent)) byAgent.set(r.agent, []);
        byAgent.get(r.agent).push(r);
      }
      const relativize = (f) =>
        f.startsWith(pluginRoot) ? f.slice(pluginRoot.length).replace(/^\//, '') : f;

      for (const [agent, locations] of [...byAgent.entries()].sort()) {
        const agentFile = join(agentsDir, `${agent}.md`);
        if (existsSync(agentFile)) {
          const n = locations.length;
          pass(`session-orchestrator:${agent} → agents/${agent}.md (${n} ref${n === 1 ? '' : 's'})`);
        } else {
          for (const loc of locations) {
            fail(
              `session-orchestrator:${agent} → agents/${agent}.md NOT FOUND (referenced at ${relativize(loc.file)}:${loc.line})`,
            );
          }
        }
      }
    }
  }

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

// CLI entry — only when executed directly, never on import (keeps the exports
// safe to import from tests without triggering process.exit).
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const [, , pluginRoot] = process.argv;
  if (!pluginRoot) {
    console.error('Usage: check-subagent-types.mjs <plugin-root>');
    process.exit(1);
  }
  process.exit(runCheckSubagentTypes(pluginRoot));
}
