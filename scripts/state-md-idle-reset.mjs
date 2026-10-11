#!/usr/bin/env node
/** session-start Phase 1.5 Idle Reset (#1560): rewrite a completed STATE.md to idle, under the STATE.md lock. */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { resetStateMdToIdleOnDisk } from './lib/state-md/idle-reset.mjs';

const HELP = `Usage: node scripts/state-md-idle-reset.mjs [--repo-root <dir>] [--json]

Reset the repo's STATE.md to idle when its status is completed (session-start
Phase 1.5, Idle Reset rules 1-7): status idle, current-wave 0, Wave History
demoted into Previous Session, Deviations emptied, scope-baseline-* keys
deleted. The five recommendation keys stay in the frontmatter so the Phase 7.5
Mode-Selector can read them. Any other status is a no-op; reasons:
status-not-completed, unparseable, missing (no or empty STATE.md).

  --repo-root <dir>  Repository root holding the state dir (default: cwd)
  --json             Emit {"changed", "reason", "path"} instead of one line
  --help             Show this help
  --version          Show the plugin version

Example: node scripts/state-md-idle-reset.mjs --json
Exit codes: 0 reset or no-op, 1 bad CLI arguments,
            2 I/O error, --repo-root not a directory, or a write the
              STATE.md guards refused
`;

/** Reasons under which writeStateMd refused a wanted write. */
const REFUSED = new Set(['size-ceiling', 'frontmatter-unsafe']);

let options;
try {
  options = parseArgs({
    options: {
      'repo-root': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
      version: { type: 'boolean' },
    },
    allowPositionals: false,
  }).values;
} catch (error) {
  process.stderr.write(`state-md-idle-reset: ${error.message}\n`);
  process.exit(1);
}

if (options.help) {
  process.stdout.write(HELP);
} else if (options.version) {
  process.stdout.write(
    `${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}\n`,
  );
} else {
  const repoRoot = resolve(options['repo-root'] ?? process.cwd());
  // The STATE.md lock would otherwise create <repoRoot>/.orchestrator/ for a
  // root that does not exist and report a harmless-looking `missing`.
  let rootStat;
  try {
    rootStat = statSync(repoRoot, { throwIfNoEntry: false });
  } catch {
    rootStat = undefined; // EACCES / ELOOP: an I/O error, exit 2 below
  }
  if (!rootStat?.isDirectory()) {
    process.stderr.write(`state-md-idle-reset: --repo-root is not a directory: ${repoRoot}\n`);
    process.exit(2);
  }
  let result;
  try {
    result = await resetStateMdToIdleOnDisk(repoRoot);
  } catch (error) {
    process.stderr.write(`state-md-idle-reset: ${error.message}\n`);
    process.exit(2);
  }
  const reason = result.reason ?? null;
  process.stdout.write(
    options.json
      ? `${JSON.stringify({ changed: result.changed, reason, path: result.path })}\n`
      : `${result.changed ? 'reset to idle' : `unchanged (${reason})`}: ${result.path}\n`,
  );
  if (REFUSED.has(reason)) process.exit(2);
}
