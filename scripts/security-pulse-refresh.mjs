#!/usr/bin/env node
/**
 * security-pulse-refresh.mjs — fill the host-local security-pulse cache (#1769, stage 2).
 *
 * Started detached by the session-start probe `security-pulse`; safe to run by hand.
 * Library: scripts/lib/security-pulse/refresh.mjs.
 */
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { refreshSecurityPulse } from './lib/security-pulse/refresh.mjs';

/** Hard overall ceiling: a hung request never leaves a lingering process. */
const PROCESS_DEADLINE_MS = 60_000;

const HELP = `Usage: node scripts/security-pulse-refresh.mjs --repo-root <abs> [--json] [--force]

Refresh the host-local security-pulse cache read by the session-start probe:
Node security floors + CISA KEV ids (host, TTL 6 h) and the OSV lockfile
findings of the repo at HEAD (TTL 6 h or HEAD moved). Cache directory:
<SO_CONFIG_HOME | XDG_CONFIG_HOME/session-orchestrator | ~/.config/session-orchestrator>/security-pulse/

Options:
  --repo-root <abs>  absolute path of the repository (required)
  --json             print the counts-only summary as JSON
  --force            ignore every TTL
  --help, -h         print this help

Output never names a package; it prints counts only.

Exit codes: 0 = ok (also when another refresher holds the lock: skipped=locked)
            1 = bad arguments
            2 = system error (cache unwritable, deadline of ${PROCESS_DEADLINE_MS / 1000} s exceeded)

Example:
  node scripts/security-pulse-refresh.mjs --repo-root "$PWD" --json
`;

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'repo-root': { type: 'string' },
        json: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    process.stderr.write(`security-pulse-refresh: ${err.message}\n${HELP}`);
    return 1;
  }
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const repoRoot = values['repo-root'];
  if (typeof repoRoot !== 'string' || !path.isAbsolute(repoRoot)) {
    process.stderr.write('security-pulse-refresh: --repo-root <absolute path> is required\n');
    return 1;
  }
  try {
    const summary = await refreshSecurityPulse({ repoRoot, force: values.force });
    if (values.json) {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } else if (summary.skipped) {
      process.stdout.write(`security-pulse-refresh: skipped (${summary.skipped})\n`);
    } else {
      const r = summary.repo;
      process.stdout.write(
        `security-pulse-refresh: host node=${summary.host.node} kev=${summary.host.kev}; `
        + `repo ${r.refreshed ? `${r.status} checked=${r.checked} unchecked=${r.unchecked} findings=${r.findings}` : r.status}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`security-pulse-refresh: ${err?.code ?? 'error'}: cache refresh failed\n`);
    return 2;
  }
}

function isEntry() {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  const killer = setTimeout(() => {
    process.stderr.write('security-pulse-refresh: process deadline exceeded\n');
    process.exit(2);
  }, PROCESS_DEADLINE_MS);
  killer.unref();
  main().then((code) => {
    process.exitCode = code;
  });
}
