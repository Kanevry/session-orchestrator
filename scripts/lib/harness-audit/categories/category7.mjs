/**
 * category7.mjs — Category 7: Policy Freshness (weight: 10)
 *
 * Checks: blocked-commands-schema, blocked-commands-min-rules,
 *         parallel-sessions-rules, ecosystem-schema-optional
 *
 * Stdlib only: node:fs, node:path.
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { safeRead, safeJson, pass, fail } from './helpers.mjs';

export function runCategory7(root) {
  const checks = [];

  // c7.1 blocked-commands-schema
  {
    const p = join(root, '.orchestrator/policy/blocked-commands.json');
    const relPath = '.orchestrator/policy/blocked-commands.json';
    const text = safeRead(p);
    const json = safeJson(text);
    if (!json) {
      checks.push(fail('blocked-commands-schema', 3, relPath,
        { version: null, ruleCount: 0 },
        'blocked-commands.json missing or invalid JSON'));
    } else {
      const version = json.version !== undefined ? json.version : null;
      const rationale = typeof json.rationale === 'string';
      const rules = Array.isArray(json.rules);
      const ruleCount = rules ? json.rules.length : 0;
      if (version !== null && rationale && rules) {
        checks.push(pass('blocked-commands-schema', 3, 3, relPath,
          { version, ruleCount },
          `blocked-commands.json valid: version=${version}, ${ruleCount} rules`));
      } else {
        checks.push(fail('blocked-commands-schema', 3, relPath,
          { version, ruleCount },
          `blocked-commands.json missing fields: ${[version === null && 'version', !rationale && 'rationale', !rules && 'rules'].filter(Boolean).join(', ')}`));
      }
    }
  }

  // c7.2 blocked-commands-min-rules
  {
    const p = join(root, '.orchestrator/policy/blocked-commands.json');
    const relPath = '.orchestrator/policy/blocked-commands.json';
    const text = safeRead(p);
    const json = safeJson(text);
    if (!json || !Array.isArray(json.rules)) {
      checks.push(fail('blocked-commands-min-rules', 3, relPath,
        { ruleCount: 0, wellFormedCount: 0 },
        'blocked-commands.json missing or has no rules array'));
    } else {
      const rules = json.rules;
      const validSeverities = ['block', 'warn'];
      const wellFormedRules = rules.filter((r) =>
        typeof r.id === 'string' &&
        typeof r.pattern === 'string' &&
        typeof r.severity === 'string' &&
        validSeverities.includes(r.severity)
      );
      if (rules.length >= 10 && wellFormedRules.length === rules.length) {
        checks.push(pass('blocked-commands-min-rules', 3, 3, relPath,
          { ruleCount: rules.length, wellFormedCount: wellFormedRules.length },
          `${rules.length} rules, all well-formed`));
      } else {
        checks.push(fail('blocked-commands-min-rules', 3, relPath,
          { ruleCount: rules.length, wellFormedCount: wellFormedRules.length },
          `${rules.length} rules (need ≥10), ${wellFormedRules.length} well-formed`));
      }
    }
  }

  // c7.3 parallel-sessions-rules
  {
    const p = join(root, '.claude/rules/parallel-sessions.md');
    const relPath = '.claude/rules/parallel-sessions.md';
    const text = safeRead(p);
    if (!text || statSync(join(root, relPath), { throwIfNoEntry: false })?.size === 0) {
      checks.push(fail('parallel-sessions-rules', 2, relPath,
        { psaCodesFound: [] },
        'parallel-sessions.md missing or empty'));
    } else {
      const psaCodes = ['PSA-001', 'PSA-002', 'PSA-003', 'PSA-004'];
      const psaCodesFound = psaCodes.filter((c) => text.includes(c));
      if (psaCodesFound.length === 4) {
        checks.push(pass('parallel-sessions-rules', 2, 2, relPath,
          { psaCodesFound },
          'parallel-sessions.md contains all 4 PSA codes'));
      } else {
        const missing = psaCodes.filter((c) => !text.includes(c));
        checks.push(fail('parallel-sessions-rules', 2, relPath,
          { psaCodesFound },
          `parallel-sessions.md missing PSA codes: ${missing.join(', ')}`));
      }
    }
  }

  // c7.4 ecosystem-schema-optional
  {
    const p = join(root, '.orchestrator/policy/ecosystem.schema.json');
    const relPath = '.orchestrator/policy/ecosystem.schema.json';
    if (!existsSync(p)) {
      checks.push(pass('ecosystem-schema-optional', 2, 2, relPath,
        { present: false, valid: null },
        'ecosystem.schema.json absent (optional) — skip'));
    } else {
      const text = safeRead(p);
      const json = safeJson(text);
      if (json !== null) {
        checks.push(pass('ecosystem-schema-optional', 2, 2, relPath,
          { present: true, valid: true },
          'ecosystem.schema.json present and valid JSON'));
      } else {
        checks.push(fail('ecosystem-schema-optional', 2, relPath,
          { present: true, valid: false },
          'ecosystem.schema.json present but invalid JSON'));
      }
    }
  }

  return checks;
}
