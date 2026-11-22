/**
 * offload.mjs — pure helpers for running ux-grill Stufe 1 on a remote-offload host.
 *
 * The run is split in two sides that share these helpers:
 *   - `scripts/ux-grill-offload.mjs` (the caller's machine) builds a `git archive`
 *     image of the target repo, asks `offload` to run the host side, and unpacks
 *     the artefacts it gets back;
 *   - `scripts/ux-grill-offload-host.mjs` (the offload host) builds the app,
 *     serves it on loopback as a child of the offload job, crawls once when no
 *     manifest exists yet, runs `collect()` + `compareRuns()` and frames the
 *     artefacts onto stdout.
 *
 * `offload` itself carries transport, installs of the root package, admission
 * (exit 10 on an overloaded host) and process-group teardown when the caller
 * dies (projects-baseline docs/REMOTE-OFFLOAD.md, #736). Nothing here repeats
 * that; this module only knows the shapes that cross the boundary.
 *
 * Artefacts come back as one gzip'd tar, base64 on stdout between marker lines,
 * because `offload run` passes stdout through but has no fetch-back channel
 * (only `offload claude --write` returns a patch). The sha256 in the BEGIN line
 * makes a truncated or interleaved stream a hard error instead of a half
 * unpacked run directory.
 *
 * @module ux-grill/offload
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Marker prefix of every line this protocol writes to stdout. */
export const FRAME_PREFIX = 'UXGRILL-OFFLOAD';
/** One JSON summary line: `UXGRILL-OFFLOAD RESULT {...}`. */
export const RESULT_TAG = 'RESULT';
const BEGIN_TAG = 'ARTEFACTS-BEGIN';
const CHUNK_TAG = 'ARTEFACTS';
const END_TAG = 'ARTEFACTS-END';
/** base64 characters per stdout line; large lines keep the line count low. */
export const FRAME_CHUNK_CHARS = 64 * 1024;

/** `offload` exit codes this tool translates into an operator message (`offload --help`). */
export const OFFLOAD_EXIT_MESSAGES = Object.freeze({
  1: 'offload rejected the call (usage or host config)',
  2: 'offload host unreachable or not ready',
  3: 'the ux-grill run on the host failed',
  4: 'offload sync failed',
  5: 'the run hit its wall-clock cap (--timeout)',
  8: 'the offload job still has a run in progress',
  10: 'offload refused admission: the host is overloaded right now (offload status); retry later or pick another host with -H',
});

/** Error with a stable `code` for every refusal in this module and its two callers. */
export class OffloadGrillError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'OffloadGrillError';
    this.code = code;
  }
}

/**
 * Admission pre-check from `offload status -H <host> --json`, before an image is
 * built or anything synced. It reads only offload's own verdict for the class
 * (`frei`, `grund`) — never a threshold of its own; `offload run` re-checks at
 * start and may still refuse with exit 10.
 *
 * @param {object} status - parsed `offload status --json`
 * @param {string} klasse - offload job class (`batch`, `gate`, …)
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function admissionFromStatus(status, klasse) {
  const cls = status?.klassen?.[klasse];
  if (!cls || typeof cls.frei !== 'number') {
    return { ok: false, reason: `offload status has no class "${klasse}"` };
  }
  if (cls.grund) {
    return { ok: false, reason: `offload class ${klasse} blocked: ${cls.grund} (load5 ${status.last_5}, cpu idle ${status.cpu_idle})` };
  }
  if (cls.frei <= 0) {
    return { ok: false, reason: `offload class ${klasse} full: ${cls.belegt}/${cls.plaetze} slots in use` };
  }
  return { ok: true };
}

/**
 * The `WT=` path `offload sync` prints on stdout.
 * @param {string} stdout
 * @returns {string}
 */
export function parseSyncWorktree(stdout) {
  const m = /^WT=(\S+)/m.exec(String(stdout ?? ''));
  if (!m) throw new OffloadGrillError('sync-no-worktree', 'offload sync printed no WT= line');
  return m[1];
}

/**
 * Split an operator-supplied command line into argv, substituting `{port}`.
 * No shell is involved: whitespace separates tokens, quotes are not interpreted,
 * so a command needing quoting has to be a script in the target repo.
 *
 * @param {string} line - e.g. `npx next start -H localhost -p {port}`
 * @param {number} port
 * @returns {string[]}
 */
export function commandArgv(line, port) {
  const argv = String(line ?? '').trim().split(/\s+/).filter(Boolean)
    .map((token) => token.split('{port}').join(String(port)));
  if (argv.length === 0) throw new OffloadGrillError('empty-command', 'command line is empty');
  return argv;
}

/**
 * Port of a loopback `base-url`, defaulting by scheme like `URL` does.
 * @param {string} baseUrl
 * @returns {number}
 */
export function portFromBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/**
 * Default build and start commands for an app directory, from its package.json.
 * Next.js gets `next start -H localhost`: with next-intl's `localePrefix:
 * 'as-needed'`, `-H 127.0.0.1` sends unprefixed pages into a 307 loop onto
 * themselves (the rewrite targets `http://localhost:<port>`, which Next treats
 * as a foreign origin; measured on Next 16.4.6, 2026-11-21, Next.js #94745).
 * `localhost` stays loopback for `isLoopbackUrl()`.
 *
 * @param {object|null} pkg - parsed package.json of the app directory
 * @returns {{build: string|null, start: string|null, hostName: string}}
 */
export function defaultAppCommands(pkg) {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (deps.next) {
    return {
      build: pkg?.scripts?.build ? 'npm run build' : null,
      start: 'node_modules/.bin/next start -H localhost -p {port}',
      hostName: 'localhost',
    };
  }
  return { build: pkg?.scripts?.build ? 'npm run build' : null, start: null, hostName: 'localhost' };
}

/**
 * Repo name for the image: the folder of the MAIN checkout, from
 * `git rev-parse --path-format=absolute --git-common-dir`. From a linked
 * worktree `--show-toplevel` names the worktree folder instead, and offload
 * would then clone a full second copy on the host under that name.
 *
 * @param {string} commonDir - absolute git common dir
 * @returns {string}
 */
export function repoNameFromCommonDir(commonDir) {
  const dir = String(commonDir ?? '').replace(/[\\/]+$/, '');
  const name = path.basename(path.basename(dir) === '.git' ? path.dirname(dir) : dir).replace(/\.git$/, '');
  if (!name || name === '.' || name === '..') throw new OffloadGrillError('no-repo-name', `cannot derive a repo name from ${commonDir}`);
  return name;
}

/**
 * Same-origin route paths from a list of hrefs collected on the landing page.
 * Query and fragment are dropped, assets and `/api/…` endpoints skipped, the result is deduplicated in first-seen
 * order, the landing path comes first, and the list is capped.
 *
 * @param {string[]} hrefs - absolute hrefs as the browser resolved them
 * @param {string} baseUrl
 * @param {number} [max=25]
 * @returns {Array<{path: string}>}
 */
export function routesFromLinks(hrefs, baseUrl, max = 25) {
  const base = new URL(baseUrl);
  const seen = new Set(['/']);
  const routes = [{ path: '/' }];
  for (const href of Array.isArray(hrefs) ? hrefs : []) {
    let url;
    try { url = new URL(String(href), base); } catch { continue; }
    if (url.origin !== base.origin) continue;
    const p = url.pathname.replace(/\/+$/, '') || '/';
    if (/\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|xml|txt|json|mp4|webm)$/i.test(p)) continue;
    // An API endpoint is no page: measured 2026-11-21, `/api/download` became a route-unreachable skip.
    if (/^\/api(\/|$)/.test(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    routes.push({ path: p });
    if (routes.length >= max) break;
  }
  return routes;
}

/**
 * Lines of `hostText` that are not already in `localText` — the host ledger is
 * the local ledger shipped in the image plus what this run appended. Matching
 * by content rather than by line count keeps a local ledger that moved on in
 * the meantime intact.
 *
 * @param {string} localText
 * @param {string} hostText
 * @returns {string[]}
 */
export function newLedgerLines(localText, hostText) {
  const have = new Set(String(localText ?? '').split('\n').filter(Boolean));
  return String(hostText ?? '').split('\n').filter((line) => line && !have.has(line));
}

/**
 * Frame a buffer as stdout lines.
 * @param {Buffer} buffer
 * @returns {string[]}
 */
export function encodeArtefactFrames(buffer) {
  const sha = createHash('sha256').update(buffer).digest('hex');
  const b64 = buffer.toString('base64');
  const lines = [`${FRAME_PREFIX} ${BEGIN_TAG} ${buffer.length} ${sha}`];
  for (let i = 0; i < b64.length; i += FRAME_CHUNK_CHARS) {
    lines.push(`${FRAME_PREFIX} ${CHUNK_TAG} ${b64.slice(i, i + FRAME_CHUNK_CHARS)}`);
  }
  lines.push(`${FRAME_PREFIX} ${END_TAG}`);
  return lines;
}

/**
 * Read the RESULT line and the artefact frames back out of a captured stdout.
 * Every non-protocol line is ignored (offload and npm may print around them).
 *
 * @param {string} stdout
 * @returns {{result: object|null, artefacts: Buffer|null}}
 * @throws {OffloadGrillError} `frame-incomplete` / `frame-checksum` / `frame-ambiguous` / `frame-unreadable` on a damaged stream
 */
export function decodeHostOutput(stdout) {
  let result = null;
  let begin = null;
  let ended = false;
  const chunks = [];
  for (const raw of String(stdout ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith(`${FRAME_PREFIX} `)) continue;
    const rest = line.slice(FRAME_PREFIX.length + 1);
    if (rest.startsWith(`${RESULT_TAG} `)) {
      // One run prints one RESULT. A second one is a spoof or a mixed stream.
      if (result !== null) throw new OffloadGrillError('frame-ambiguous', 'host output carries more than one RESULT line');
      try {
        result = JSON.parse(rest.slice(RESULT_TAG.length + 1));
      } catch {
        throw new OffloadGrillError('frame-unreadable', 'host RESULT line is not JSON');
      }
    } else if (rest.startsWith(`${BEGIN_TAG} `)) {
      const [size, sha] = rest.slice(BEGIN_TAG.length + 1).split(' ');
      begin = { size: Number(size), sha };
    } else if (rest === END_TAG) {
      ended = true;
    } else if (rest.startsWith(`${CHUNK_TAG} `) && begin && !ended) {
      chunks.push(rest.slice(CHUNK_TAG.length + 1));
    }
  }
  if (!begin) return { result, artefacts: null };
  if (!ended) throw new OffloadGrillError('frame-incomplete', 'artefact stream ended before its END marker');
  const buffer = Buffer.from(chunks.join(''), 'base64');
  const sha = createHash('sha256').update(buffer).digest('hex');
  if (buffer.length !== begin.size || sha !== begin.sha) {
    throw new OffloadGrillError('frame-checksum', `artefact checksum mismatch (got ${buffer.length} bytes)`);
  }
  return { result, artefacts: buffer };
}
