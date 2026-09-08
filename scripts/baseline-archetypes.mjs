#!/usr/bin/env node
/** Data-only lookup for the configured local bootstrap baseline. */
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadBaselineArchetypes } from './lib/baseline-archetypes.mjs';

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: node scripts/baseline-archetypes.mjs [--repo PATH] [--archetype ID]\nOffline, read-only JSON lookup. Exit 0: public/private; exit 2: invalid configuration or contract.\n');
      return 0;
    }
    if (!['--repo', '--archetype'].includes(arg) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      process.stdout.write(`${JSON.stringify({ status: 'error', reason: 'invalid-arguments', archetypes: [], selected: null })}\n`);
      return 2;
    }
    options[arg === '--repo' ? 'repoRoot' : 'archetype'] = argv[++index];
  }
  if (options.repoRoot) options.repoRoot = path.resolve(options.repoRoot);
  const result = await loadBaselineArchetypes(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === 'error' ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main();
