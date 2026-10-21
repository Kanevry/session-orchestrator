#!/usr/bin/env node
/**
 * snapshot-probe.mjs — run validate-plugin and the test suite on the curated public
 * snapshot tree, materialized outside the repo without a remote (#1712).
 * Library: scripts/lib/snapshot-probe.mjs.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { isMainModule } from './lib/is-main-module.mjs';
import { KNOWN_STEPS, SnapshotProbeSystemError, runSnapshotProbe } from './lib/snapshot-probe.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const HELP = `Usage: node scripts/snapshot-probe.mjs [options]

Builds the curated public GitHub snapshot of a source commit (the tree minus the paths in
.orchestrator/policy/public-export.json — the same helper the export uses), materializes it
under $TMPDIR as a one-commit git repo WITHOUT any remote, and runs the steps there. Catches
tests and validators that depend on a file the public export drops.

Options:
  --source <rev>     source commit (default HEAD)
  --steps <list>     comma-separated steps, from: ${KNOWN_STEPS.join(', ')} (default: both)
  --host <alias>     run the 'test' step on an offload host instead: one 'remote-gate' step
                     (the pre-push router's full gate against the snapshot commit, no gate
                     telemetry); validate-plugin still runs locally
  --local            run the 'test' step (full suite) on this host instead
                     The 'test' step needs exactly one of --host or --local.
  --keep             keep the materialized snapshot directory (printed as dir)
  --no-receipt       do not write .orchestrator/tmp/snapshot-probe/<tree>.json
  --json             print one JSON object instead of the human summary (remote gate
                     output goes to stderr)
  --version          print the plugin version
  -h, --help         show this help

Exit codes:
  0  every step passed
  1  usage error
  2  system error: git, tar or mkdtemp failure, or the remote gate did not run the suite
     to completion (host unknown or not ready, fallback, gate-timeout, a timed-out check,
     no test result) — no receipt is written
  3  the probe ran and the snapshot is red (a step failed or timed out)

A receipt is written only when a suite step ran ('test' or 'remote-gate'); a
--steps validate-plugin run prints its result and leaves any existing receipt untouched.
The release preflight accepts only receipts whose steps include a passing suite step:
'test' (--local) or 'remote-gate' (--host).

Examples:
  node scripts/snapshot-probe.mjs --steps validate-plugin
  node scripts/snapshot-probe.mjs --host m5 --json
  node scripts/snapshot-probe.mjs --local --json
`;

/**
 * Parse argv into probe options.
 * @param {string[]} argv
 * @returns {{ ok: true, opts: object } | { ok: false, error: string } | { ok: true, help: true } | { ok: true, version: true }}
 */
export function parseCli(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        source: { type: 'string', default: 'HEAD' },
        steps: { type: 'string' },
        local: { type: 'boolean', default: false },
        host: { type: 'string' },
        keep: { type: 'boolean', default: false },
        'no-receipt': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (values.help) return { ok: true, help: true };
  if (values.version) return { ok: true, version: true };
  const steps = values.steps === undefined ? [...KNOWN_STEPS] : values.steps.split(',').map((s) => s.trim()).filter(Boolean);
  if (steps.length === 0) return { ok: false, error: '--steps is empty' };
  const unknown = steps.filter((s) => !KNOWN_STEPS.includes(s));
  if (unknown.length > 0) return { ok: false, error: `unknown step(s): ${unknown.join(', ')} (known: ${KNOWN_STEPS.join(', ')})` };
  if (values.local && values.host !== undefined) return { ok: false, error: '--host and --local are mutually exclusive' };
  if (values.host !== undefined && !/^[A-Za-z0-9._-]+$/.test(values.host)) return { ok: false, error: `invalid --host alias '${values.host}'` };
  // Host rule: full suites belong on a remote host; the local host only with --local.
  if (steps.includes('test') && !values.local && values.host === undefined) {
    return { ok: false, error: "the 'test' step runs the full suite — pass --host <alias> or --local, or use --steps validate-plugin" };
  }
  return {
    ok: true,
    opts: { source: values.source, steps, keep: values.keep, writeReceipt: !values['no-receipt'], json: values.json, ...(values.host !== undefined ? { host: values.host } : {}) },
  };
}

function humanSummary(r) {
  const lines = [
    `snapshot probe ${r.ok ? 'GREEN' : 'RED'} — source ${r.sourceSha.slice(0, 12)}, tree ${r.snapshotTree.slice(0, 12)} (route ${r.route})`,
    `files: ${r.counts.source} source, ${r.counts.excluded} excluded, ${r.counts.exported} exported`,
  ];
  for (const s of r.steps) {
    lines.push(`  ${s.name}: ${s.status} (exit ${s.exitCode}, ${Math.round(s.durationMs / 1000)}s)`);
    if (s.reason) lines.push(`    ${s.reason}`);
    if (s.failedFiles) for (const f of s.failedFiles) lines.push(`    FAIL ${f}`);
    if (s.tail) lines.push(...s.tail.split('\n').map((l) => `    | ${l}`));
  }
  if (r.dir) lines.push(`kept: ${r.dir}`);
  return lines.join('\n');
}

/**
 * @param {string[]} argv
 * @param {{ repoRoot?: string, probe?: typeof runSnapshotProbe }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, { repoRoot = REPO_ROOT, probe = runSnapshotProbe } = {}) {
  const parsed = parseCli(argv);
  if (!parsed.ok) {
    process.stderr.write(`snapshot-probe: ${parsed.error}\n\n${HELP}`);
    return 1;
  }
  if (parsed.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.version) {
    process.stdout.write(`${JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version}\n`);
    return 0;
  }
  const { json, ...opts } = parsed.opts;
  let result;
  try {
    result = await probe({ repoRoot, ...opts });
  } catch (err) {
    const message = err instanceof SnapshotProbeSystemError ? err.message : `unexpected failure: ${err?.message ?? err}`;
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    process.stderr.write(`snapshot-probe: ${message}\n`);
    return 2;
  }
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${humanSummary(result)}\n`);
  return result.ok ? 0 : 3;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
