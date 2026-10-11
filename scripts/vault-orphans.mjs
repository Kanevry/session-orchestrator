#!/usr/bin/env node
/**
 * vault-orphans.mjs - CLI for `findVaultOrphans` (#1563, session-end Phase 3.7e).
 *
 * Names the untracked files in the Meta-Vault modified since a given instant
 * (the session's start). Read-only: it never commits, moves or deletes anything
 * in the vault. See scripts/lib/session-end/vault-orphans.mjs for the design.
 *
 * USAGE
 *   node scripts/vault-orphans.mjs --since <ISO> [--vault-dir <dir>] [--json]
 *
 * EXIT CODES
 *   0  measured (including zero candidates)
 *   1  bad arguments
 *   2  could not measure (no vault dir resolvable, not a git repo, git failed)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { findVaultOrphans } from './lib/session-end/vault-orphans.mjs';
import { _parseVaultIntegration } from './lib/config/vault-integration.mjs';
import { loadHostPaths } from './lib/config/host-paths.mjs';
import { resolveVaultDir } from './lib/config.mjs';
import { expandTilde } from './lib/common.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const HELP = `vault-orphans.mjs - name untracked vault files written since a session started (#1563)

USAGE
  node scripts/vault-orphans.mjs --since <ISO> [--vault-dir <dir>] [--json]

DESCRIPTION
  Runs the read-only \`git -C <vault-dir> ls-files --others --exclude-standard\`
  and lists every untracked file whose mtime is at or after --since. Files whose
  frontmatter names one of this plugin's generators (\`_generator:
  session-orchestrator-...\`) are left out: their writer owns them.

  The results are CANDIDATES: mtime is a hint, not proof that this session
  wrote the file. Nothing is committed, moved or deleted.

OPTIONS
  --since <ISO>       Required. ISO 8601 instant with Z or an offset, e.g. the
                      STATE.md \`started_at\` (2026-10-11T08:00:00.000Z).
  --vault-dir <dir>   Vault working tree. Default: the host-local resolution
                      SO_VAULT_DIR > owner.yaml > committed
                      vault-integration.vault-dir in ./CLAUDE.md or ./AGENTS.md.
  --json              Print the result object as JSON on stdout.
  --help              Show this help.
  --version           Print the plugin version.

EXIT CODES
  0  measured, including zero candidates
  1  bad arguments
  2  could not measure (no vault dir, not a git repo, git failed)

EXAMPLE
  node scripts/vault-orphans.mjs --since 2026-10-11T08:00:00.000Z --json
`;

/** ISO 8601 with an explicit zone - a zone-less value would be read as local time. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Resolve the vault dir like the other vault writers: SO_VAULT_DIR > owner.yaml
 * `vault-dirs:` cwd match > owner.yaml `paths.vault-dir` > committed value.
 *
 * @returns {string|null}
 */
function resolveDefaultVaultDir() {
  let content = '';
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const p = join(process.cwd(), name);
    if (existsSync(p)) {
      try {
        content = readFileSync(p, 'utf8');
        break;
      } catch {
        /* try the next file */
      }
    }
  }
  const vi = _parseVaultIntegration(content);
  const value = resolveVaultDir(vi['vault-dir'], loadHostPaths()).value;
  return typeof value === 'string' && value.trim() !== '' ? expandTilde(value) : null;
}

/** @param {{status: 'ok', candidates: Array<{path: string}>, total: number, truncated: boolean, untracked: number}} r */
function renderHuman(r, since) {
  const lines = [];
  if (r.total === 0) {
    lines.push(`vault-orphans: no untracked vault file modified since ${since} (${r.untracked} untracked in total)`);
  } else {
    lines.push(
      `vault-orphans: ${r.total} untracked vault file(s) modified since ${since} - candidates only, ` +
        `mtime does not prove this session wrote them (${r.untracked} untracked in total)`,
    );
    for (const c of r.candidates) lines.push(`  ${c.path}`);
    if (r.truncated) lines.push(`  ... showing ${r.candidates.length} of ${r.total}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * CLI entry.
 *
 * @param {string[]} [argv]
 * @param {{stdout: {write: Function}, stderr: {write: Function}}} [io]
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        since: { type: 'string' },
        'vault-dir': { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    io.stderr.write(`vault-orphans: ${err.message}\nRun with --help for usage.\n`);
    return 1;
  }

  if (values.help) {
    io.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    io.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  const since = values.since;
  const sinceMs = typeof since === 'string' && ISO_RE.test(since) ? Date.parse(since) : NaN;
  if (!Number.isFinite(sinceMs)) {
    io.stderr.write('vault-orphans: --since <ISO> is required, e.g. 2026-10-11T08:00:00.000Z\n');
    return 1;
  }
  if (values['vault-dir'] !== undefined && values['vault-dir'].trim() === '') {
    io.stderr.write('vault-orphans: --vault-dir must not be empty\n');
    return 1;
  }

  const vaultDir =
    values['vault-dir'] !== undefined ? expandTilde(values['vault-dir']) : resolveDefaultVaultDir();
  const result = findVaultOrphans({ vaultDir, sinceMs });

  if (result.status !== 'ok') {
    io.stderr.write(
      `vault-orphans: could not measure (${result.reason}${result.detail ? `: ${result.detail}` : ''})\n`,
    );
    if (values.json) io.stdout.write(`${JSON.stringify(result)}\n`);
    return 2;
  }

  io.stdout.write(values.json ? `${JSON.stringify(result)}\n` : renderHuman(result, since));
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
