#!/usr/bin/env node
/**
 * check-session-plan-routing.mjs — Verify that skills/session-plan/SKILL.md
 * contains a content-based routing table with all five agent slots and the
 * domain-specific keyword anchors required by Issue #436.
 *
 * Checks:
 *   1. SKILL.md contains "content-based routing table" (heading anchor)
 *   2. SKILL.md contains "session-orchestrator:db-specialist"
 *   3. SKILL.md contains "session-orchestrator:ui-developer"
 *   4. SKILL.md contains "session-orchestrator:security-reviewer"
 *   5. SKILL.md contains "session-orchestrator:test-writer"
 *   6. SKILL.md contains "session-orchestrator:code-implementer"
 *   7. db-domain keyword present (migration|schema|RLS|supabase|postgres)
 *   8. ui-domain keyword present (component|tsx|tailwind|a11y|wcag)
 *   9. security-domain keyword present (csrf|csp|injection|XSS)
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 *
 * Usage:
 *   node scripts/lib/validate/check-session-plan-routing.mjs <plugin-root>
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const pluginRoot = process.argv[2];
if (!pluginRoot) {
  console.error('Usage: check-session-plan-routing.mjs <plugin-root>');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function pass(msg) { console.log(`  PASS: ${msg}`); passed += 1; }
function fail(msg) { console.log(`  FAIL: ${msg}`); failed += 1; }

const SKILL_MD = join(pluginRoot, 'skills/session-plan/SKILL.md');

// ---------------------------------------------------------------------------
// Early-exit if the file doesn't exist
// ---------------------------------------------------------------------------

if (!existsSync(SKILL_MD)) {
  fail('skills/session-plan/SKILL.md does not exist — cannot run routing checks');
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

const skillText = readFileSync(SKILL_MD, 'utf8');

// ---------------------------------------------------------------------------
// Check 1: content-based routing table anchor
// ---------------------------------------------------------------------------

console.log('--- Check 1: session-plan routing — "content-based routing table" anchor ---');

if (/content-based routing table/.test(skillText)) {
  pass('SKILL.md contains "content-based routing table" anchor');
} else {
  fail('SKILL.md missing "content-based routing table" anchor — routing table was not inserted');
}

// ---------------------------------------------------------------------------
// Checks 2–6: all five agent identifiers present
// ---------------------------------------------------------------------------

console.log('');
console.log('--- Check 2: session-plan routing — db-specialist agent identifier ---');
if (/session-orchestrator:db-specialist/.test(skillText)) {
  pass('SKILL.md contains "session-orchestrator:db-specialist"');
} else {
  fail('SKILL.md missing "session-orchestrator:db-specialist" — db routing row absent');
}

console.log('');
console.log('--- Check 3: session-plan routing — ui-developer agent identifier ---');
if (/session-orchestrator:ui-developer/.test(skillText)) {
  pass('SKILL.md contains "session-orchestrator:ui-developer"');
} else {
  fail('SKILL.md missing "session-orchestrator:ui-developer" — ui routing row absent');
}

console.log('');
console.log('--- Check 4: session-plan routing — security-reviewer agent identifier ---');
if (/session-orchestrator:security-reviewer/.test(skillText)) {
  pass('SKILL.md contains "session-orchestrator:security-reviewer"');
} else {
  fail('SKILL.md missing "session-orchestrator:security-reviewer" — security routing row absent');
}

console.log('');
console.log('--- Check 5: session-plan routing — test-writer agent identifier ---');
if (/session-orchestrator:test-writer/.test(skillText)) {
  pass('SKILL.md contains "session-orchestrator:test-writer"');
} else {
  fail('SKILL.md missing "session-orchestrator:test-writer" — test routing row absent');
}

console.log('');
console.log('--- Check 6: session-plan routing — code-implementer agent identifier ---');
if (/session-orchestrator:code-implementer/.test(skillText)) {
  pass('SKILL.md contains "session-orchestrator:code-implementer"');
} else {
  fail('SKILL.md missing "session-orchestrator:code-implementer" — fallback routing row absent');
}

// ---------------------------------------------------------------------------
// Check 7: db-domain keywords
// ---------------------------------------------------------------------------

console.log('');
console.log('--- Check 7: session-plan routing — db-domain keywords present ---');
if (/migration|schema|RLS|supabase|postgres/i.test(skillText)) {
  pass('SKILL.md contains db-domain keyword (migration|schema|RLS|supabase|postgres)');
} else {
  fail('SKILL.md missing db-domain keywords — db routing pattern incomplete');
}

// ---------------------------------------------------------------------------
// Check 8: ui-domain keywords
// ---------------------------------------------------------------------------

console.log('');
console.log('--- Check 8: session-plan routing — ui-domain keywords present ---');
if (/component|tsx|tailwind|a11y|wcag/i.test(skillText)) {
  pass('SKILL.md contains ui-domain keyword (component|tsx|tailwind|a11y|wcag)');
} else {
  fail('SKILL.md missing ui-domain keywords — ui routing pattern incomplete');
}

// ---------------------------------------------------------------------------
// Check 9: security-domain keywords
// ---------------------------------------------------------------------------

console.log('');
console.log('--- Check 9: session-plan routing — security-domain keywords present ---');
if (/csrf|csp|injection|XSS/i.test(skillText)) {
  pass('SKILL.md contains security-domain keyword (csrf|csp|injection|XSS)');
} else {
  fail('SKILL.md missing security-domain keywords — security routing pattern incomplete');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
