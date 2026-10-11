#!/usr/bin/env node
/** Read-only CLI for explicitly supplied, stable snapshot copies (#1462). */
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { auditCheckins } from './lib/fleet-checkin-audit.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const HELP = `Usage: fleet-checkin-audit --input-root DIR --registry FILE --checkins FILE --repo KEY [--repo KEY] --at UTC [--json]
All five input flags are required. --repo may repeat with distinct explicit keys.
--at is an exact UTC instant (YYYY-MM-DDTHH:MM:SS[.sss]Z).
--json emits one JSON report; --help and --version are standalone commands.
Supply complete registry/check-in snapshot copies with capture times matching --at.
Only explicit regular files inside --input-root are read; symlinks are refused.
Use stable trusted copies: simultaneous parent-directory renames are not atomic.
No discovery, live configuration, referenced-repo reads, events or input writes.
Exit 0: measured, including findings; 1: invalid arguments, paths or JSON;
2: unavailable inputs/system I/O; 3: incomplete or not-measurable snapshot evidence.
stdout contains the report; stderr contains only diagnostics.
`;
const failure = (category, exit, errno) => Object.assign(new Error(category), { category, exit, errno });

function argumentsFor(argv) {
  const args = { repos: [], json: false };
  const values = new Map([['--input-root', 'root'], ['--registry', 'registry'], ['--checkins', 'checkins'], ['--at', 'at']]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') { args.json = true; continue; }
    if (flag === '--help' || flag === '--version') {
      if (argv.length !== 1) throw failure('invalid-arguments', 1);
      args.action = flag;
      return args;
    }
    if (flag !== '--repo' && !values.has(flag)) throw failure('invalid-arguments', 1);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw failure('invalid-arguments', 1);
    if (flag === '--repo') args.repos.push(value);
    else {
      const key = values.get(flag);
      if (args[key] !== undefined) throw failure('duplicate-argument', 1);
      args[key] = value;
    }
  }
  if (!args.root || !args.registry || !args.checkins || !args.at || !args.repos.length) throw failure('missing-arguments', 1);
  if (new Set(args.repos).size !== args.repos.length || args.repos.some((repo) => repo.trim() !== repo)) {
    throw failure('invalid-repo-selection', 1);
  }
  const instant = Date.parse(args.at);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(args.at)
    || !Number.isFinite(instant)
    || new Date(instant).toISOString() !== args.at.replace(/Z$/, args.at.includes('.') ? 'Z' : '.000Z')) {
    throw failure('invalid-measurement-time', 1);
  }
  return args;
}

/** Inspect every component before reading contents; parent rename races remain
 * outside this portable path-based reader's guarantee (use stable copies). */
async function inspect(root, name) {
  const target = path.resolve(root, name);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw failure('path-outside-input-root', 1);
  }
  const parsed = path.parse(target);
  let current = parsed.root;
  let stat;
  const components = target.slice(parsed.root.length).split(path.sep);
  for (let i = 0; i < components.length; i++) {
    current = path.join(current, components[i]);
    stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw failure('symlink-input', 1);
    if (i < components.length - 1 && !stat.isDirectory()) throw failure('non-directory-parent', 1);
  }
  if (!stat?.isFile()) throw failure('non-regular-input', 1);
  return { target, stat };
}

async function readSnapshot({ target, stat }) {
  // The parent check above and this open are not atomic: a same-user process can swap a parent
  // directory in between. Fine while the operator names the snapshot files and the result grants
  // nothing; revisit (#1549) once paths come from a foreign owner or the result gates a decision.
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') {
    throw failure('unsupported-safe-open', 2);
  }
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== stat.dev || actual.ino !== stat.ino) throw failure('changed-input-file', 1);
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw failure('malformed-json-or-utf8', 1); }
}

function render(report) {
  if (report.error) return `not-measurable: ${report.error.category}\n`;
  return [`status: ${report.status}`, ...Object.entries(report.metrics).map(([key, metric]) =>
    `${key}: ${metric.status === 'measured' ? metric.value : `not-measurable (${metric.reasons.join(', ')})`}`)].join('\n') + '\n';
}

/** The real CLI boundary; callers may route its output to their own streams. */
export async function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  let args;
  try {
    args = argumentsFor(argv);
    if (args.action === '--help') { io.stdout.write(HELP); return 0; }
    if (args.action === '--version') {
      const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
      io.stdout.write(`${manifest.version}\n`);
      return 0;
    }
    const root = path.resolve(args.root);
    // Inspect BOTH paths before opening either snapshot for content.
    const registryFile = await inspect(root, args.registry);
    const checkinFile = await inspect(root, args.checkins);
    const registry = await readSnapshot(registryFile);
    const checkins = await readSnapshot(checkinFile);
    const report = auditCheckins({ registry, checkins, repos: args.repos, at: args.at });
    io.stdout.write(args.json ? `${JSON.stringify(report)}\n` : render(report));
    return report.status === 'measured' ? 0 : 3;
  } catch (error) {
    const category = error.category || 'input-io-error';
    const errno = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : undefined;
    const report = { version: 1, status: 'not-measurable', error: { category, ...(errno ? { errno } : {}) } };
    io.stderr.write(`fleet-checkin-audit: ${category}${errno ? ` (${errno})` : ''}\n`);
    io.stdout.write((args?.json || argv.includes('--json')) ? `${JSON.stringify(report)}\n` : render(report));
    return error.exit || 2;
  }
}

if (isMainModule(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, () => {
    process.stderr.write('fleet-checkin-audit: output-io-error\n');
    process.exitCode = 2;
  });
}
