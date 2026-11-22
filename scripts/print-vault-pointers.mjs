#!/usr/bin/env node
/**
 * print-vault-pointers.mjs — session-start vault pointers (#2169).
 *
 * Runs ONE ranked search over the operator's knowledge vault with the session's
 * topic and prints a short block of candidate pointers for the coordinator's
 * briefing (session-start Phase 6.6.1). Agents rarely call a search tool on
 * their own, so the start step lays the pointers down; the coordinator decides
 * which of them fit. The block is labelled as candidates and never passed on
 * to subagents automatically.
 *
 * Opt-in: prints nothing unless `vault-integration.briefing-search: true` is set
 * in the Session Config host file (CLAUDE.md / AGENTS.md). With the key unset
 * no search runs and no event is written.
 *
 * A host that switched the integration off (`SO_VAULT_INTEGRATION=off` or
 * owner.yaml, `resolveVaultIntegrationHost`) runs no search either.
 *
 * Search command, resolved in this order:
 *   1. `vault-search` on PATH (Node's own PATH lookup, as for any CLI tool);
 *   2. `python3 <vault-dir>/scripts/retrieval/vault_search.py`, where vault-dir
 *      is `vault-integration.vault-dir` after host-local resolution
 *      (SO_VAULT_DIR > owner.yaml > committed, `resolveVaultDir`).
 * When vault-dir names a directory, the command gets `VAULT_ROOT=<vault-dir>`
 * and the block header names that root, so the pointers can be opened from a
 * repo that is not the vault.
 * Contract of the command: `-n <N> <words>`, stdout lines
 * `relative/path.md:START-END  Heading`, exit 0 = hits, 1 = none, 2 = error.
 *
 * Never blocks or fails a session start: every failure (no key, no command,
 * exit 1/2, timeout, malformed output, unreadable config) prints NOTHING and
 * exits 0, and a process-wide deadline ends the run even if stdin or the
 * event webhook hangs. The topic reaches the command as one argv element,
 * never through a shell, reduced to letters, digits, spaces and hyphens.
 *
 * Exit code: always 0 (including EPIPE), a deliberate exception to
 * `.claude/rules/cli-design.md`. Data → stdout, nothing on stderr.
 */

import { parseArgs } from 'node:util';
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import { findProjectRoot, expandTilde } from './lib/common.mjs';
import { _parseVaultIntegration } from './lib/config/vault-integration.mjs';
import { loadHostPaths, resolveVaultIntegrationHost } from './lib/config/host-paths.mjs';
import { resolveVaultDir } from './lib/config.mjs';
import { emitEvent } from './lib/events.mjs';
import { spawn } from './lib/native-command.mjs';
import { assertNoWrapperForgery, sanitizeProse } from './lib/reconcile/sanitize.mjs';
import { readProcessLocalSessionIds } from './lib/session-identity/own-session.mjs';

process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
  throw err;
});

const HELP = `Usage: node scripts/print-vault-pointers.mjs [--topic <words>] [--json] [--no-event]

Session-start vault pointers (#2169). Runs one ranked vault search with the
topic and prints at most 5 candidate pointers in at most 600 characters.
Opt-in: does nothing unless vault-integration.briefing-search is true.

Options:
  --topic <words>  Search topic. Without it the topic is read from stdin,
                   the safe form for text from an issue or the operator:
                   write it to a file, then redirect that file in
                   (never a heredoc: a line equal to its end word ends it):
                     node scripts/print-vault-pointers.mjs < "$topic_file"
  --json           Print {source, root, pointers:[{path,start,end,heading}]}
                   instead of the Markdown block (same caps).
  --no-event       Do not write orchestrator.vault.pointers_shown / pointers_skipped.
  --help, -h       Show this help.

Exit code: always 0. Any failure (key off, command missing, exit 1/2,
timeout after 5 s, malformed output) prints nothing.
`;

/** Hard limit for the search command, in ms (issue #2169 acceptance criterion). */
const SEARCH_TIMEOUT_MS = 5000;
/** At most this many pointers in the block. */
const MAX_POINTERS = 5;
/** Hard cap on the whole block, header and newlines included. */
const MAX_BLOCK_CHARS = 600;
/** Longest query handed to the command; cut at a word boundary. */
const MAX_QUERY_CHARS = 120;
/** Longest heading kept per pointer line. */
const MAX_HEADING_CHARS = 60;
/** Stdout beyond this is not a pointer list; the run counts as malformed. */
const MAX_STDOUT_BYTES = 64 * 1024;
/**
 * Whole-run deadline: search limit plus room for node start, config read and
 * the event write. Ends a run whose stdin is never closed or whose optional
 * event webhook (3 s, events.mjs) is still pending.
 */
const RUN_DEADLINE_MS = SEARCH_TIMEOUT_MS + 3000;

const EVENT_TYPE = 'orchestrator.vault.pointers_shown';
// Written when the step was switched on and had a query but showed nothing, so that
// "the search found nothing" and "the search never ran" can be told apart later.
const SKIP_EVENT_TYPE = 'orchestrator.vault.pointers_skipped';

/** `relative/path.md:START-END  Heading` — the command's documented line shape. */
const POINTER_LINE_RE = /^([^\s:][^:\n]*\.md):(\d+)-(\d+) {2}(.*)$/;

/**
 * Reduce free text to a search query: only letters, digits, spaces and hyphens
 * survive, no word starts with a hyphen (it would read as an option), and the
 * result is cut at a word boundary to MAX_QUERY_CHARS.
 * @param {string} text
 * @returns {string} '' when nothing usable is left
 */
function sanitizeQuery(text) {
  const words = String(text)
    .replace(/[^\p{L}\p{N} -]/gu, ' ')
    .split(' ')
    .map((w) => w.replace(/^-+/, ''))
    .filter(Boolean);
  let query = '';
  for (const word of words) {
    const next = query ? `${query} ${word}` : word;
    if (next.length > MAX_QUERY_CHARS) break;
    query = next;
  }
  return query;
}

/**
 * Read a config host file only when it is a regular file. O_NONBLOCK: a FIFO
 * at the path would otherwise block this synchronous open, and with it the
 * run-deadline timer, for good; the fstat then refuses anything but a regular
 * file (same guard as context-threshold.mjs). Symlinks are followed.
 * @param {string} file
 * @returns {string} '' when the file is not a readable regular file
 */
function readRegularFile(file) {
  let fd;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return '';
  }
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd, 'utf8') : '';
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the vault-integration block the way vault-backfill.mjs does: the block
 * parser plus host-local resolution, never `parseSessionConfig` (it throws on
 * an invalid value in any unrelated block).
 * @param {string} repoRoot
 * @returns {{briefingSearch: boolean, hostOff: boolean, vaultDir: string|null}}
 */
function readVaultConfig(repoRoot) {
  let content = '';
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const file = join(repoRoot, name);
    if (existsSync(file)) {
      content = readRegularFile(file);
      break;
    }
  }
  const hostCtx = loadHostPaths();
  const vi = resolveVaultIntegrationHost(_parseVaultIntegration(content), hostCtx);
  const dir = resolveVaultDir(vi['vault-dir'], hostCtx).value;
  return {
    briefingSearch: vi['briefing-search'] === true,
    hostOff: vi['host-override'] !== null && vi.mode === 'off',
    vaultDir: typeof dir === 'string' && dir.trim() !== '' ? expandTilde(dir.trim()) : null,
  };
}

/**
 * Run one search command. Resolves with its stdout and exit code, or with
 * `{ code: null }` on spawn failure, timeout or oversized output. Never rejects.
 *
 * Not `spawnSync` and not `spawnInGroup`: a `vault-search` wrapper that starts
 * python WITHOUT `exec` leaves a grandchild holding the stdout pipe, and
 * `spawnSync`'s timeout kills only the direct child, then keeps waiting for
 * that pipe. `spawnInGroup` merges stderr into the output (the command's hint
 * line) and waits a 10 s kill grace. Here the child leads its own process group
 * and the whole group gets SIGKILL at the deadline; the promise settles at the
 * deadline whether or not the pipe ever closes.
 * @param {string} cmd
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{code: number|null, stdout: string, enoent: boolean}>}
 */
function runSearch(cmd, args, env) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let bytes = 0;
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const killGroup = () => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      child.stdout?.destroy();
      child.unref();
    };
    const timer = setTimeout(() => {
      killGroup();
      finish({ code: null, stdout: '', enoent: false, timedOut: true });
    }, SEARCH_TIMEOUT_MS);
    try {
      child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        env,
        shell: false,
        ...(process.platform === 'win32' ? { windowsHide: true } : { detached: true }),
      });
    } catch (err) {
      finish({ code: null, stdout: '', enoent: err?.code === 'ENOENT' });
      return;
    }
    child.on('error', (err) => finish({ code: null, stdout: '', enoent: err?.code === 'ENOENT' }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > MAX_STDOUT_BYTES) {
        killGroup();
        finish({ code: null, stdout: '', enoent: false });
        return;
      }
      stdout += chunk;
    });
    child.on('close', (code) => finish({ code: typeof code === 'number' ? code : null, stdout, enoent: false }));
  });
}

/** Control and format characters (ANSI escapes, bidi overrides, zero-width). */
const INVISIBLE_RE = /[\p{Cc}\p{Cf}]/u;

/**
 * Parse the command's stdout. Any line that does not match the documented
 * shape, a path that is absolute, has a `..` segment or carries an invisible
 * character, a line range that starts below 1 or ends before it starts, or a heading `sanitizeProse` rejects (delivery-wrapper forgery)
 * makes the whole output malformed. Headings are note text going into a
 * prompt: they pass through `sanitizeProse`, the same guard the learnings
 * index uses, and are collapsed to one line.
 * @param {string} stdout
 * @returns {{path: string, start: number, end: number, heading: string}[]|null}
 */
function parsePointers(stdout) {
  const lines = stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  if (lines.length === 0) return null;
  const pointers = [];
  for (const line of lines) {
    const m = POINTER_LINE_RE.exec(line);
    if (!m) return null;
    const path = m[1];
    if (path.startsWith('/') || path.split('/').includes('..') || INVISIBLE_RE.test(path)) return null;
    let heading;
    try {
      // The path goes into the prompt as well: a note file name can carry a delivery wrapper.
      assertNoWrapperForgery(path, 'path');
      heading = sanitizeProse(m[4], { field: 'heading', maxBytes: 400 });
    } catch {
      return null;
    }
    heading = heading.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
    const start = Number(m[2]);
    const end = Number(m[3]);
    // Lines count from 1; 0-0 or 20-3 names no readable range.
    if (start < 1 || end < start) return null;
    pointers.push({ path, start, end, heading });
  }
  return pointers;
}

/**
 * Render the block within MAX_POINTERS and MAX_BLOCK_CHARS. Headings are
 * shortened first; a pointer that still does not fit is dropped whole, never
 * cut, so a printed path is always complete.
 * @param {{path: string, start: number, end: number, heading: string}[]} pointers
 * @param {string|null} root — vault root the paths are relative to, or null
 * @returns {{text: string, shown: {path: string, start: number, end: number, heading: string}[]}}
 */
function renderBlock(pointers, root) {
  const home = homedir();
  const shownRoot = root && (root === home || root.startsWith(home + sep)) ? `~${root.slice(home.length)}` : root;
  const header = shownRoot
    ? `Vault pointers (candidates; paths relative to ${shownRoot}):`
    : 'Vault pointers (candidates; paths relative to the vault-search root):';
  let text = header;
  const shown = [];
  for (const p of pointers.slice(0, MAX_POINTERS)) {
    const heading = p.heading.length > MAX_HEADING_CHARS ? `${p.heading.slice(0, MAX_HEADING_CHARS - 1)}…` : p.heading;
    const line = `- ${p.path}:${p.start}-${p.end}${heading ? `  ${heading}` : ''}`;
    // +2: the newline before this line and the trailing newline of the block.
    if (text.length + line.length + 2 > MAX_BLOCK_CHARS) break;
    text += `\n${line}`;
    shown.push({ ...p, heading });
  }
  return { text: shown.length > 0 ? `${text}\n` : '', shown };
}

/** Read the topic from stdin when it is piped in (no `--topic`). */
async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.length > 4000) break;
  }
  return data;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  let opts;
  try {
    opts = parseArgs({
      args: argv,
      options: {
        topic: { type: 'string' },
        json: { type: 'boolean', default: false },
        'no-event': { type: 'boolean', default: false },
      },
      strict: true,
    }).values;
  } catch {
    return;
  }

  const repoRoot = findProjectRoot(process.cwd());
  const config = readVaultConfig(repoRoot);
  if (!config.briefingSearch || config.hostOff) return;

  const query = sanitizeQuery(opts.topic ?? (await readStdin()));
  if (query === '') return;
  const args = ['-n', String(MAX_POINTERS), query];
  const [nativeId] = readProcessLocalSessionIds();
  const localSession = nativeId ? { native_session_id: nativeId } : {};
  const skip = async (reason) => {
    if (opts['no-event']) return;
    try {
      await emitEvent(SKIP_EVENT_TYPE, { reason, ...localSession }, { repoRoot, webhookPayload: { reason } });
    } catch {
      // An unwritten metric must never cost the briefing.
    }
  };

  // A configured vault that exists pins the search root, so the pointers are
  // relative to a directory the block can name.
  const root = config.vaultDir && existsSync(config.vaultDir) ? config.vaultDir : null;
  // VAULT_SEARCH_LEXICAL: the search may have an embedding arm that sends the query to an external
  // provider. This step runs unattended on every session start, so it asks for words only: no topic
  // leaves the host and no network wait eats into the 5 s limit.
  const env = { ...process.env, VAULT_SEARCH_LEXICAL: '1', ...(root ? { VAULT_ROOT: root } : {}) };

  let source = 'path';
  let result = await runSearch('vault-search', args, env);
  if (result.enoent && root) {
    const script = join(root, 'scripts', 'retrieval', 'vault_search.py');
    if (!existsSync(script)) return skip('no-command');
    source = 'vault-dir';
    result = await runSearch('python3', [script, ...args], env);
  }
  if (result.enoent) return skip('no-command');
  if (result.timedOut) return skip('timeout');
  if (result.code === 1) return skip('no-hits');
  if (result.code !== 0) return skip('search-error');

  const pointers = parsePointers(result.stdout);
  if (!pointers) return skip('malformed-output');
  const { text, shown } = renderBlock(pointers, root);
  if (text === '') return skip('over-budget');

  // Write first: the block must not wait on the event write. No
  // process.exit() after it (#876): let the pipe drain.
  process.stdout.write(opts.json ? `${JSON.stringify({ source, root, pointers: shown })}\n` : text);

  if (!opts['no-event']) {
    try {
      const paths = shown.map((p) => p.path);
      // Vault paths and the native session ID stay in the local ledger.
      const webhookPayload = { count: paths.length, source };
      await emitEvent(EVENT_TYPE, { paths, ...webhookPayload, ...localSession }, { repoRoot, webhookPayload });
    } catch {
      // An unwritten metric must never cost the briefing.
    }
  }
}

setTimeout(() => process.exit(0), RUN_DEADLINE_MS).unref();

try {
  await main();
} catch {
  // Every failure prints nothing and exits 0.
}
