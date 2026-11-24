#!/usr/bin/env node
/**
 * directory-preflight.mjs — report what the Claude plugin directory scan objects to in
 * the curated public snapshot of a source commit, before the export (#2216).
 * Library: scripts/lib/directory-preflight.mjs.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { MODES, runDirectoryPreflight } from './lib/directory-preflight.mjs';
import { createGitRunner } from './lib/github-export.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { computeSnapshotTree } from './lib/snapshot-probe.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const HELP = `Usage: node scripts/directory-preflight.mjs [options]

Measures the curated public snapshot of a source commit (the tree the policy in
.orchestrator/policy/public-export.json publishes) against the mechanical rules of the
Claude plugin directory scan: file count, text files over 256 KiB, binaries the validator
does not inspect, an MCP server declared in .mcp.json and inline, line-ending rules
without eol=lf, package.json beside a lockfile. The index and the working tree stay
untouched; building the snapshot tree writes unreferenced tree objects, as the export does.

Options:
  --source <rev>   source commit (default HEAD)
  --mode <mode>    ${MODES.join(' | ')} (default warn)
                   off     measure nothing, exit 0 (output says checked: false)
                   warn    report findings, exit 0
                   strict  exit 3 on a blocking finding or an empty listing; holds stay a
                           report, because a reviewer decides them; exit 0 is no
                           listing clearance
  --json           print one JSON object instead of the human summary
  --version        print the plugin version
  -h, --help       show this help

Exit codes:
  0  measured (or mode off); in strict mode: no blocking finding
  1  usage error
  2  system error: the source does not resolve or git could not read the tree
  3  strict mode and at least one blocking finding
`;

/**
 * Measure one tree object. Split from the source lookup so a git failure on the tree
 * can be exercised with a stub runner.
 * @param {{ git: import('./lib/github-export.mjs').GitRunner, tree: string, mode: string }} opts
 * @returns {{ ok: false, system: true, reason: string } | ReturnType<typeof runDirectoryPreflight>}
 */
export function preflightTree({ git, tree, mode }) {
  const ls = git(['ls-tree', '-r', '-l', '-z', tree]);
  if (ls.status !== 0) return { ok: false, system: true, reason: 'ls-tree of the snapshot tree failed' };
  const entries = ls.stdout.split('\0').filter(Boolean).flatMap((row) => {
    // `<mode> <type> <oid> <size>\t<path>`; a submodule has size `-` and is no file.
    const tab = row.indexOf('\t');
    const [, type, , size] = row.slice(0, tab).split(/\s+/);
    return type === 'blob' ? [{ path: row.slice(tab + 1), size: Number(size) }] : [];
  });
  const listed = new Set(entries.map((e) => e.path));
  // A listed file that cannot be read is a git failure. Returning null for it would
  // make the blocking checks pass on exactly the tree they could not inspect.
  const read = (path) => {
    if (!listed.has(path)) return null;
    const res = git(['cat-file', 'blob', `${tree}:${path}`]);
    if (res.status !== 0) throw new Error(`cat-file of ${path} in the snapshot tree failed`);
    return res.stdout;
  };
  try {
    return runDirectoryPreflight({ mode, entries, read });
  } catch (err) {
    return { ok: false, system: true, reason: err.message };
  }
}

/**
 * @param {{ repoRoot: string, source?: string, mode?: string, git?: import('./lib/github-export.mjs').GitRunner }} opts
 * @returns {{ ok: false, system: true, reason: string } | (ReturnType<typeof runDirectoryPreflight> & { sourceSha?: string, snapshotTree?: string })}
 */
export function preflightSource({ repoRoot, source = 'HEAD', mode = 'warn', git = createGitRunner(repoRoot) }) {
  if (mode === 'off') return runDirectoryPreflight({ mode, entries: [], read: () => null });
  const snap = computeSnapshotTree({ repoRoot, source, git });
  if (!snap.ok) return { ok: false, system: true, reason: snap.reason };
  const result = preflightTree({ git, tree: snap.snapshotTree, mode });
  return result.system ? result : { ...result, sourceSha: snap.sourceSha, snapshotTree: snap.snapshotTree };
}

function render(result) {
  if (result.mode === 'off') return 'directory preflight: off, not checked\n';
  const lines = [`directory preflight (${result.mode}): ${result.files} files, ${(result.bytes / 1048576).toFixed(1)} MiB, snapshot tree ${result.snapshotTree.slice(0, 12)}`];
  if (result.findings.length === 0) lines.push('  no findings');
  for (const f of result.findings) {
    lines.push(`  ${f.severity === 'blocking' ? 'BLOCKING' : 'hold    '} ${f.code}: ${f.message}`);
    for (const p of (f.paths ?? []).slice(0, 8)) lines.push(`             ${p}`);
    if ((f.paths?.length ?? 0) > 8) lines.push(`             … ${f.paths.length - 8} more`);
  }
  if (!result.checked) lines.push('  NOT CHECKED: the listing was empty, so no measurement backs this result');
  else if (result.holds.length > 0) lines.push(`  ok is no listing clearance: ${result.holds.length} hold(s) stay open for a reviewer (${result.holds.join(', ')})`);
  return `${lines.join('\n')}\n`;
}

export function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        source: { type: 'string', default: 'HEAD' },
        mode: { type: 'string', default: 'warn' },
        json: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version}\n`);
    return 0;
  }
  if (!MODES.includes(values.mode)) {
    process.stderr.write(`unknown mode '${values.mode}' (known: ${MODES.join(', ')})\n`);
    return 1;
  }
  const result = preflightSource({ repoRoot: REPO_ROOT, source: values.source, mode: values.mode });
  if (result.system) {
    process.stderr.write(`directory preflight: ${result.reason}\n`);
    return 2;
  }
  process.stdout.write(values.json ? `${JSON.stringify(result)}\n` : render(result));
  return result.ok ? 0 : 3;
}

if (isMainModule(import.meta.url)) process.exitCode = main();
