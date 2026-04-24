#!/usr/bin/env node
// Fixture: references blocked-commands.json policy.
import { readFileSync } from 'node:fs';
const policyPath = '.orchestrator/policy/blocked-commands.json';
try {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  void policy;
} catch { /* fixture: swallow — production version would block */ }
process.exit(0);
