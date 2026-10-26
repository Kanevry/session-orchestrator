/**
 * runtime-floor.mjs — Security-Delta check `runtime-floor` (#1769, stage 1).
 *
 * Compares the Node versions the HEAD tree declares (`.nvmrc`, `.node-version`,
 * `package.json` engines.node, `node:<tag>` images in Dockerfiles and
 * `.gitlab-ci.yml`) against the security floor from the Node release index.
 * Floor per major = the newest index entry of that major with `security: true`.
 */

import { basename } from 'node:path';

import { httpRequest } from '../http-request.mjs';
import { BUDGET, makeCheckResult, makeFinding } from './contract.mjs';
import { isDockerfile, isFixturePath, isGitExecError, isSafeRef, listTree, parseImageRefs, showFile } from './floating-tags.mjs';

export const NODE_INDEX_URL = 'https://nodejs.org/dist/index.json';

/** The index is ~875 entries (measured 2026-10-23); 8 MiB leaves ample headroom. */
const INDEX_MAX_BYTES = 8 * 1024 * 1024;

const ALIASES = new Set(['node', 'latest', 'stable', 'current', 'lts', '*', 'x']);

/**
 * Parse a version string into numeric parts (`v22.23.3` → [22, 23, 3]).
 * @param {string} v
 * @returns {number[]|null}
 */
export function parseVersion(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v).trim());
  if (!m) return null;
  return [m[1], m[2], m[3]].filter((p) => p !== undefined).map(Number);
}

/** @returns {number} negative, zero or positive */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Security floor per major from the parsed Node release index.
 * @param {{version:string, security?:boolean}[]} index
 * @returns {Map<number, number[]>} major → floor version parts
 */
export function securityFloors(index) {
  const floors = new Map();
  for (const entry of Array.isArray(index) ? index : []) {
    if (!entry || entry.security !== true) continue;
    const parts = parseVersion(entry.version);
    if (!parts || parts.length < 3) continue;
    const cur = floors.get(parts[0]);
    if (!cur || compareVersions(parts, cur) > 0) floors.set(parts[0], parts);
  }
  return floors;
}

/**
 * Classify one declared Node version.
 * - `alias`   — `lts/*`, `lts/<name>`, `node`, `latest`, `stable`, `current`, image tag `lts-*`.
 * - `range`   — `>=24.0.0`, `^22.1.0`, `~22.1`, `20.x`, `20.*`, `20 || 22`, `22.1.0 - 22.9.0`.
 *               A range is not a pin: its lower bound is the oldest version it
 *               ADMITS, not the one that runs, so it is never compared to the floor.
 * - `version` — numeric parts (1–3) of a pin; a leading `v` or `=` is allowed
 *               (`v22.23.3`, `=22.23.3`), as is an image-tag suffix (`22.23.3-alpine`).
 * @param {string} raw
 * @returns {{kind:'alias'}|{kind:'range'}|{kind:'version', parts:number[]}|{kind:'unknown'}}
 */
export function classifyDeclaration(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return { kind: 'unknown' };
  if (ALIASES.has(value) || value.startsWith('lts/') || value.startsWith('lts-')) return { kind: 'alias' };
  // Comparators, caret/tilde, `||`, `*`, an `x` version part, or a spaced hyphen range.
  // A bare `-` is NOT a range marker: image tags carry it (`22.23.3-alpine`).
  if (/[<>^~*|]/.test(value) || /(?:^|\.)x(?:\.|$|\s)/.test(value) || /\s-\s/.test(value)) return { kind: 'range' };
  const m = /^(?:v|=)?(\d+(?:\.\d+){0,2})(?![\d.])/.exec(value);
  const parts = m ? parseVersion(m[1]) : null;
  return parts ? { kind: 'version', parts } : { kind: 'unknown' };
}

/**
 * Collect Node version declarations from the tree of `ref`. A file git cannot
 * read is counted in `unreadable`, never taken as absent (#1774).
 * @returns {Promise<{decls: {file:string, raw:string, lineText:string}[], unreadable: number}>}
 */
async function collectDeclarations(repoRoot, ref) {
  const out = [];
  let unreadable = 0;
  const read = async (file) => {
    try {
      return await showFile(repoRoot, ref, file);
    } catch (err) {
      if (!isGitExecError(err)) throw err; // a defect, not a read failure: outer catch → internal-error
      unreadable += 1;
      return null;
    }
  };
  for (const file of ['.nvmrc', '.node-version']) {
    const text = await read(file);
    const line = text?.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (line) out.push({ file, raw: line, lineText: line });
  }
  const pkgText = await read('package.json');
  if (pkgText) {
    try {
      const node = JSON.parse(pkgText)?.engines?.node;
      if (typeof node === 'string' && node.trim()) out.push({ file: 'package.json', raw: node.trim(), lineText: `engines.node=${node.trim()}` });
    } catch {
      // An unparsable package.json declares nothing measurable.
    }
  }
  const tree = await listTree(repoRoot, ref);
  const imageFiles = tree.filter(
    (f) => !f.split('/').includes('node_modules') && !isFixturePath(f) && (isDockerfile(f) || basename(f) === '.gitlab-ci.yml'),
  );
  for (const file of imageFiles) {
    const text = await read(file);
    for (const r of parseImageRefs(text ?? '', file)) {
      if (!r.measurable || !/^(?:docker\.io\/)?(?:library\/)?node$/.test(r.image)) continue;
      out.push({ file, raw: r.tag ?? 'latest', lineText: r.ref });
    }
  }
  return { decls: out, unreadable };
}

/** Whether the declaring line is new relative to the same file at `base`. */
async function isIntroduced(repoRoot, base, decl) {
  const text = await showFile(repoRoot, base, decl.file);
  if (text === null) return true;
  if (decl.file === 'package.json') {
    try {
      const node = JSON.parse(text)?.engines?.node;
      return typeof node !== 'string' || `engines.node=${node.trim()}` !== decl.lineText;
    } catch {
      return true;
    }
  }
  return !text.includes(decl.lineText);
}

/**
 * The version a partial declaration resolves to: an exact X.Y.Z stays itself;
 * X.Y resolves to the newest X.Y.* in the index; a major alone floats to the
 * newest patch and is never below its floor (returns null = no comparison).
 */
function resolveDeclared(parts, index) {
  if (parts.length >= 3) return parts;
  if (parts.length === 1) return null;
  let newest = null;
  for (const entry of index) {
    const p = parseVersion(entry?.version);
    if (p && p[0] === parts[0] && p[1] === parts[1] && (!newest || compareVersions(p, newest) > 0)) newest = p;
  }
  return newest;
}

/**
 * Check declared Node versions against the per-major security floor. Never throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string|null} [opts.base]        empty → skipped/no-range
 * @param {string} [opts.head]
 * @param {number} [opts.deadlineAt]       epoch ms; no request starts after it
 * @param {typeof httpRequest} [opts.request]
 * @returns {Promise<ReturnType<typeof makeCheckResult>>}
 */
export async function runRuntimeFloorCheck({ repoRoot, base, head, deadlineAt, request = httpRequest } = {}) {
  const started = Date.now();
  const deadline = deadlineAt ?? started + BUDGET.networkMs;
  const done = (r) => makeCheckResult({ id: 'runtime-floor', ms: Date.now() - started, ...r });
  let unreadable = 0;
  // Every result after the read: unreadable files make it degraded and count as unchecked.
  const finish = (r) =>
    unreadable === 0
      ? done(r)
      : done({
          ...r,
          status: 'degraded',
          reason: r.status === 'degraded' ? r.reason : 'unreadable',
          unchecked: (r.unchecked ?? 0) + unreadable,
        });
  try {
    if (!base) return done({ status: 'skipped', reason: 'no-range' });
    if (!isSafeRef(base) || !isSafeRef(head)) return done({ status: 'degraded', reason: 'invalid-ref', unchecked: 1 });
    const collected = await collectDeclarations(repoRoot, head);
    const decls = collected.decls;
    unreadable = collected.unreadable;
    if (decls.length === 0) return finish({ status: 'skipped', reason: 'no-node-declaration' });

    const classified = decls.map((d) => ({ ...d, c: classifyDeclaration(d.raw) }));
    const measurable = classified.filter((d) => d.c.kind === 'version');
    if (measurable.length === 0) {
      const alias = classified.some((d) => d.c.kind === 'alias');
      const range = classified.some((d) => d.c.kind === 'range');
      return finish({ status: 'not-measurable', reason: alias ? 'lts-alias' : range ? 'range' : 'unparsable' });
    }
    const majorOnly = measurable.filter((d) => d.c.parts.length === 1);
    const needIndex = measurable.filter((d) => d.c.parts.length > 1);
    if (needIndex.length === 0) return finish({ status: 'ok', checked: majorOnly.length });

    if (Date.now() >= deadline) {
      return finish({ status: 'degraded', reason: 'timeout', checked: majorOnly.length, unchecked: needIndex.length });
    }
    let index;
    try {
      const res = await request(NODE_INDEX_URL, { timeoutMs: Math.max(1, deadline - Date.now()), maxBytes: INDEX_MAX_BYTES });
      if (!res?.ok) throw new Error(`HTTP ${res?.status}`);
      index = await res.json();
      if (!Array.isArray(index)) throw new Error('index is not an array');
    } catch (err) {
      const reason = /timed out|timeout/i.test(String(err?.message)) ? 'timeout' : 'network';
      return finish({ status: 'degraded', reason, checked: majorOnly.length, unchecked: needIndex.length });
    }

    const floors = securityFloors(index);
    const findings = [];
    for (const d of needIndex) {
      const declared = resolveDeclared(d.c.parts, index);
      const floor = floors.get(d.c.parts[0]);
      if (!declared || !floor || compareVersions(declared, floor) >= 0) continue;
      // An unreadable base leaves open whether the line is new: report it as introduced.
      let introduced = true;
      try {
        introduced = await isIntroduced(repoRoot, base, d);
      } catch (err) {
        if (!isGitExecError(err)) throw err;
        unreadable += 1;
      }
      findings.push(
        makeFinding({
          class: 'runtime-floor',
          severity: 'high',
          ecosystem: 'node',
          package: 'node',
          version: d.c.parts.join('.'),
          fixedIn: floor.join('.'),
          file: d.file,
          introduced,
        }),
      );
    }
    return finish({ status: 'ok', checked: measurable.length, findings });
  } catch {
    return done({ status: 'degraded', reason: 'internal-error', unchecked: 1 });
  }
}
