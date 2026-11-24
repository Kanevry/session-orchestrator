#!/usr/bin/env node
/** Read-only setup pre-check CLI (#2230): what the repo has, per item, with a reason. */
import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';
import { runSetupPrecheck } from './lib/setup-precheck.mjs';

const HELP = `Usage: node scripts/setup-precheck.mjs [--repo-root <abs path>] [--json]

Measure the repo setup without writing anything: git, vcs, packageManager,
test, typecheck, lint. Each item is detected, skipped (with the reason) or unknown.

  --repo-root <dir>  Repository root (absolute; default: cwd)
  --json             Print the result as ONE JSON line
  --help             Show this help

Exit codes: 0 check ran (skipped items are results, not errors), 2 bad arguments
`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      json: { type: 'boolean' },
      'repo-root': { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  }));
  if (values['repo-root'] !== undefined && !isAbsolute(values['repo-root'])) {
    throw new Error('--repo-root must be an absolute path');
  }
} catch (error) {
  process.stderr.write(`setup-precheck: ${error.message}\n`);
  process.exit(2);
}

if (values.help) {
  process.stdout.write(HELP);
} else {
  const result = runSetupPrecheck({ repoRoot: values['repo-root'] || process.cwd() });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    // Human form: "not found" reads as a finding, not as the tool giving up; JSON keeps the enum.
    const label = (status) => (status === 'skipped' ? 'not found' : status);
    for (const item of result.items) {
      const detail =
        item.status === 'detected' ? (item.value ?? item.reason) : (item.reason ?? item.value);
      process.stdout.write(`${item.key}: ${label(item.status)} — ${detail}\n`);
    }
    const { detected, skipped, unknown } = result.summary;
    process.stdout.write(
      `summary: ${detected} detected, ${skipped} not found, ${unknown} unknown — read-only, nothing changed\n`,
    );
  }
}
