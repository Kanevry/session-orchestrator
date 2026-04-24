#!/usr/bin/env node
/**
 * CLI wrapper for validateSessionConfig.
 *
 * Reads Session Config JSON from stdin. Inspects the `enforcement` field and:
 *   - "off"             → pass through stdin to stdout unchanged, exit 0
 *   - valid config      → pass through to stdout, exit 0
 *   - invalid + "warn"  → pass through to stdout, print errors to stderr, exit 0
 *   - invalid + "strict"→ errors to stderr, no stdout, exit 1
 *   - malformed JSON    → error to stderr, no stdout, exit 1
 *
 * Used by scripts/parse-config.mjs as an optional validation gate.
 */

import { validateSessionConfig, formatErrors } from './lib/config-schema.mjs';

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks).toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`validate-config: malformed JSON: ${err.message}\n`);
    process.exit(1);
  }

  const result = validateSessionConfig(parsed);
  if (result.ok) {
    process.stdout.write(raw);
    process.exit(0);
  }

  const enforcement = parsed && typeof parsed === 'object' ? parsed['enforcement'] : null;
  const errorBlock = `Session Config validation failed:\n${formatErrors(result.errors)}\n`;

  if (enforcement === 'strict') {
    process.stderr.write(errorBlock);
    process.exit(1);
  }

  process.stderr.write(`⚠ ${errorBlock}`);
  process.stdout.write(raw);
  process.exit(0);
});
