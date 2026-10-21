#!/usr/bin/env node
/**
 * agent-usage-census.mjs — CLI shell over scripts/lib/agent-usage-census.mjs (#1617).
 *
 * Reads Claude Code subagent transcripts (read-only) and reports per agent type:
 * dispatches, observed models, turns and output per run, cache rebuilds after
 * idle gaps, and the median start context. Definitions: see the lib header.
 *
 * Usage: agent-usage-census.mjs [--days N] [--root DIR] [--json] [--top N]
 * Exit:  0 measured · 1 bad argument · 2 root unreadable / measurement failed
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { DEFAULT_DAYS, formatTable, runCensus } from './lib/agent-usage-census.mjs';
import { writeStdoutLineSync } from './lib/io.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const USAGE = 'Usage: agent-usage-census.mjs [--days N] [--root DIR] [--json] [--top N] [--help]';

export function parseArgs(argv) {
  const out = { days: DEFAULT_DAYS, root: path.join(os.homedir(), '.claude', 'projects'), json: false, top: 25, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--help') out.help = true;
    else if (a === '--days' || a === '--top') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) return { error: `${a} requires a positive number` };
      out[a.slice(2)] = v;
    } else if (a === '--root') {
      const v = argv[++i];
      if (!v) return { error: '--root requires a directory' };
      out.root = path.resolve(v);
    } else return { error: `Unknown argument: ${a}` };
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`Error: ${args.error}`);
    console.error(USAGE);
    process.exit(1);
  }
  if (args.help) {
    console.log(USAGE);
    console.log('');
    console.log('Per agent type over the subagent transcripts of the last N days (read-only):');
    console.log('  dispatches, observed models (share of turns), turns/run and output tokens/run (median),');
    console.log('  cache rebuilds after > 5 min gaps, median start context.');
    console.log('');
    console.log(`  --days N   window in days (default ${DEFAULT_DAYS})`);
    console.log('  --root D   transcript root (default ~/.claude/projects)');
    console.log('  --json     machine-readable envelope on stdout');
    console.log('  --top N    rows in the table (default 25)');
    console.log('');
    console.log('Exit: 0 measured · 1 bad argument · 2 root unreadable / measurement failed');
    process.exit(0);
  }
  if (!fs.existsSync(args.root)) {
    console.error(`Error: transcript root does not exist: ${args.root}`);
    process.exit(2);
  }
  let result;
  try {
    result = await runCensus({ root: args.root, days: args.days });
  } catch (err) {
    console.error(`Error: census failed: ${err?.message ?? err}`);
    process.exit(2);
  }
  writeStdoutLineSync(args.json ? JSON.stringify(result, null, 2) : formatTable(result, { top: args.top }));
  process.exit(0);
}

if (isMainModule(import.meta.url)) main();
