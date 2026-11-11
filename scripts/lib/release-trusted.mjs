// scripts/lib/release-trusted.mjs
//
// The receipt for npm trusted publishing (issue #1906, ADR-0018 Route B).
//
// WHY THIS EXISTS:
//   Under Route B the `npm publish` runs in the GitHub Actions workflow of the
//   public mirror, not on the release host. The local release script therefore
//   no longer holds the receipt of the upload. What it can hold instead is a
//   public, login-free proof read back from registry.npmjs.org: version X was
//   published BY our workflow (trusted publisher + SLSA provenance naming the
//   repository, workflow path and tag ref) FROM the commit we pushed, and its
//   content equals the archive the local preflight checked.
//
//   The tarball's sha512 cannot be compared to the local one — GitHub packs
//   its own tarball and gzip bytes may differ — so content is compared per
//   file (`archiveContentManifest` + `compareContentManifests`).
//
// THREE STATES, NEVER TWO:
//   `pending` (version not on the registry yet), `unreadable` (a measurement
//   is missing or not parseable) and `mismatch` (a measurement contradicts the
//   expectation) are kept apart. A missing measurement is never a pass and
//   never a mismatch.
//
// Pure functions plus one injectable-I/O fetcher; node:* only.

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

/** The only package this receipt is ever evaluated for. */
export const TRUSTED_PACKAGE = 'session-orchestrator';

/** Public mirror that hosts the publish workflow (ADR-0018 Option B). */
const TRUSTED_REPOSITORY = 'https://github.com/Kanevry/session-orchestrator';
const TRUSTED_WORKFLOW_PATH = '.github/workflows/publish.yml';
const TRUSTED_BUILDER_ID = 'https://github.com/actions/runner/github-hosted';
const SLSA_V1_PREDICATE = 'https://slsa.dev/provenance/v1';

const REGISTRY_BASE = 'https://registry.npmjs.org';
const ATTESTATIONS_PREFIX = `${REGISTRY_BASE}/-/npm/v1/attestations/`;
const TARBALL_PREFIX = `${REGISTRY_BASE}/${TRUSTED_PACKAGE}/-/`;

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Thrown when a release target is not a plain `X.Y.Z` version. */
export class TrustedTargetError extends Error {
  /** @param {unknown} target the rejected value */
  constructor(target) {
    super(`release target must match X.Y.Z, got ${JSON.stringify(target)}`);
    this.name = 'TrustedTargetError';
  }
}

/** Thrown by `archiveContentManifest` on a malformed, truncated or unsafe tarball. */
export class ArchiveParseError extends Error {
  /** @param {string} message what is wrong, including the byte offset where known */
  constructor(message) {
    super(message);
    this.name = 'ArchiveParseError';
  }
}

/**
 * The identity a genuine publish of `target` must carry in its SLSA provenance.
 *
 * @param {string} target release version, `X.Y.Z`
 * @returns {{repository: string, workflowPath: string, ref: string}}
 * @throws {TrustedTargetError} when `target` is not `X.Y.Z`
 */
export function expectedTrustedIdentity(target) {
  if (typeof target !== 'string' || !SEMVER_RE.test(target)) throw new TrustedTargetError(target);
  return { repository: TRUSTED_REPOSITORY, workflowPath: TRUSTED_WORKFLOW_PATH, ref: `refs/tags/v${target}` };
}

/**
 * Decode a strict base64 string; `null` when it is not base64.
 * `Buffer.from(…, 'base64')` silently drops foreign characters, hence the gate.
 *
 * @param {unknown} s
 * @returns {Buffer|null}
 */
function strictBase64(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0 || !BASE64_RE.test(s)) return null;
  return Buffer.from(s, 'base64');
}

/**
 * Locate and decode the SLSA v1 in-toto statement from the attestations document.
 *
 * @param {unknown} attestations body of `GET <dist.attestations.url>`
 * @returns {{statement: any}|{error: string}}
 */
function readSlsaStatement(attestations) {
  if (attestations === null || attestations === undefined) return { error: 'attestations absent' };
  const list = /** @type {any} */ (attestations)?.attestations;
  if (!Array.isArray(list)) return { error: 'attestations document has no `attestations` array' };
  const entry = list.find((a) => a && a.predicateType === SLSA_V1_PREDICATE);
  if (!entry) return { error: `no ${SLSA_V1_PREDICATE} attestation entry` };
  const bytes = strictBase64(entry?.bundle?.dsseEnvelope?.payload);
  if (!bytes) return { error: 'SLSA dsseEnvelope.payload is not base64' };
  let statement;
  try {
    statement = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { error: 'SLSA dsseEnvelope.payload is not JSON' };
  }
  if (!statement || typeof statement !== 'object' || !Array.isArray(statement.subject) || !statement.predicate) {
    return { error: 'SLSA statement lacks subject[] or predicate' };
  }
  return { statement };
}

/**
 * Hex of the sha512 inside `dist.integrity` (`sha512-<base64>`); `null` when not measurable.
 *
 * @param {unknown} integrity
 * @returns {string|null}
 */
function integrityHex(integrity) {
  if (typeof integrity !== 'string') return null;
  const m = /^sha512-(.+)$/.exec(integrity.trim());
  const bytes = m ? strictBase64(m[1]) : null;
  return bytes && bytes.length === 64 ? bytes.toString('hex') : null;
}

/**
 * One equality check: `null` when the observed value is absent (not measurable),
 * otherwise strict equality.
 *
 * @param {string} name
 * @param {unknown} observed
 * @param {unknown} wanted
 * @returns {{name: string, ok: boolean|null, detail: string}}
 */
function eqCheck(name, observed, wanted) {
  if (observed === undefined || observed === null) {
    return { name, ok: null, detail: `${name}: not present in the registry evidence` };
  }
  const ok = observed === wanted;
  return {
    name,
    ok,
    detail: ok ? `${name}: ${String(observed)}` : `${name}: got ${JSON.stringify(observed)}, want ${JSON.stringify(wanted)}`,
  };
}

/**
 * Verdict over the registry evidence for a trusted (OIDC) publish of `target`.
 *
 * PURE and never throws. States:
 * - `pending`    — `versionDoc` is null/undefined (version not on the registry yet).
 * - `unreadable` — attestations absent/unparseable/without a SLSA v1 entry, or a
 *                  binding field is missing from the evidence (`_npmUser` absent).
 * - `mismatch`   — any binding check measured a contradicting value, including an
 *                  `_npmUser` without `trustedPublisher` (a token publish).
 * - `published`  — every check passed; the commit check may be skipped (`ok: null`)
 *                  when `expected.commit` is absent, and that skip is named in
 *                  `checks` and `detail`.
 *
 * The source commit is read from the `resolvedDependencies` entry whose `uri`
 * is `git+<expected.repository>` (optionally `@<ref>`); without such an entry
 * the commit is unmeasured (`unreadable` when an expected commit is given).
 *
 * Ceiling (BV-004): no local sigstore signature verification of the DSSE
 * envelope. The attestation is trusted via TLS to registry.npmjs.org, and
 * consumers verify signatures with `npm audit signatures`. Revisit trigger: a
 * sigstore verifier becomes an installed dependency of this repo.
 *
 * @param {{
 *   target: string,
 *   versionDoc: any,
 *   attestations: any,
 *   expected: {repository: string, workflowPath: string, ref: string, commit?: string|null},
 * }} input
 * @returns {{ok: boolean, state: 'pending'|'unreadable'|'mismatch'|'published',
 *            checks: Array<{name: string, ok: boolean|null, detail: string}>, detail: string}}
 */
export function evaluateTrustedPublishReceipt({ target, versionDoc, attestations, expected } = /** @type {any} */ ({})) {
  if (versionDoc === null || versionDoc === undefined) {
    return { ok: false, state: 'pending', checks: [], detail: `${TRUSTED_PACKAGE}@${target} is not on the registry yet` };
  }
  const exp = expected || /** @type {any} */ ({});
  const doc = /** @type {any} */ (versionDoc);
  const checks = [];

  // `_npmUser` present without `trustedPublisher` is a MEASURED token publish
  // (npm records the publishing user), so it contradicts the expectation; only
  // an absent `_npmUser` is a missing measurement.
  const npmUser = doc?._npmUser;
  checks.push(
    npmUser && typeof npmUser === 'object' && (npmUser.trustedPublisher === undefined || npmUser.trustedPublisher === null)
      ? { name: 'trusted-publisher', ok: false, detail: 'trusted-publisher: _npmUser has no trustedPublisher (a token publish), want "github"' }
      : eqCheck('trusted-publisher', npmUser?.trustedPublisher?.id, 'github'),
  );
  checks.push(eqCheck('version', doc?.version, target));

  const slsa = readSlsaStatement(attestations);
  if ('error' in slsa) {
    checks.push({ name: 'slsa-provenance', ok: null, detail: `slsa-provenance: ${slsa.error}` });
    return { ok: false, state: 'unreadable', checks, detail: `attestations unreadable: ${slsa.error}` };
  }
  const { statement } = slsa;
  const subject = statement.subject[0];
  const bd = statement.predicate?.buildDefinition;
  const wf = bd?.externalParameters?.workflow;

  checks.push(eqCheck('subject-name', subject?.name, `pkg:npm/${TRUSTED_PACKAGE}@${target}`));

  const distHex = integrityHex(doc?.dist?.integrity);
  const subjHex = typeof subject?.digest?.sha512 === 'string' ? subject.digest.sha512.toLowerCase() : null;
  if (distHex === null || subjHex === null) {
    checks.push({
      name: 'subject-digest',
      ok: null,
      detail: `subject-digest: ${distHex === null ? 'dist.integrity is not a sha512 SRI' : 'SLSA subject has no sha512'}`,
    });
  } else {
    const ok = distHex === subjHex;
    checks.push({
      name: 'subject-digest',
      ok,
      detail: ok ? 'subject-digest: SLSA subject sha512 equals dist.integrity' : 'subject-digest: SLSA subject sha512 differs from dist.integrity',
    });
  }

  checks.push(eqCheck('workflow-repository', wf?.repository, exp.repository));
  checks.push(eqCheck('workflow-path', wf?.path, exp.workflowPath));
  checks.push(eqCheck('workflow-ref', wf?.ref, exp.ref));

  // The source commit comes from the dependency whose uri names the expected
  // repository (sigstore shape `git+https://github.com/<repo>@<ref>`), never
  // from whatever entry happens to be first. No such entry → unmeasured.
  const repoUri = typeof exp.repository === 'string' && exp.repository !== '' ? `git+${exp.repository}` : null;
  const sourceDep = repoUri && Array.isArray(bd?.resolvedDependencies)
    ? bd.resolvedDependencies.find((d) => typeof d?.uri === 'string' && (d.uri === repoUri || d.uri.startsWith(`${repoUri}@`)))
    : undefined;
  const gitCommit = sourceDep?.digest?.gitCommit;
  if (exp.commit === null || exp.commit === undefined) {
    checks.push({ name: 'source-commit', ok: null, detail: 'source-commit: skipped (no expected commit given)' });
  } else if (typeof exp.commit !== 'string' || !COMMIT_RE.test(exp.commit)) {
    checks.push({ name: 'source-commit', ok: false, detail: `source-commit: expected commit ${JSON.stringify(exp.commit)} is not 40 hex` });
  } else {
    checks.push(eqCheck('source-commit', gitCommit, exp.commit));
  }

  checks.push(eqCheck('builder', statement.predicate?.runDetails?.builder?.id, TRUSTED_BUILDER_ID));

  const failed = checks.find((c) => c.ok === false);
  if (failed) return { ok: false, state: 'mismatch', checks, detail: failed.detail };
  // The source-commit check may only be skipped when NO expected commit was
  // given; with a valid expected commit an absent gitCommit is a missing
  // measurement (unreadable), never a pass.
  const commitGiven = exp.commit !== null && exp.commit !== undefined;
  const missing = checks.find((c) => c.ok === null && (c.name !== 'source-commit' || commitGiven));
  if (missing) return { ok: false, state: 'unreadable', checks, detail: missing.detail };

  const skipped = !commitGiven;
  return {
    ok: true,
    state: 'published',
    checks,
    detail: `${TRUSTED_PACKAGE}@${target} published by ${exp.workflowPath} at ${exp.ref}${skipped ? ' — source-commit check SKIPPED (no expected commit)' : ` from ${exp.commit}`}`,
  };
}

/**
 * NUL-terminated string from a header field.
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} len
 */
function cstr(buf, start, len) {
  const field = buf.subarray(start, start + len);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString('utf8');
}

/**
 * Octal numeric header field; throws on anything else (incl. GNU base-256).
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} len
 * @param {string} what
 * @param {number} offset header offset for the message
 */
function octal(buf, start, len, what, offset) {
  const raw = cstr(buf, start, len).trim();
  if (!/^[0-7]+$/.test(raw)) throw new ArchiveParseError(`tar header at ${offset}: ${what} is not octal`);
  return parseInt(raw, 8);
}

/**
 * Parse pax extended-header records (`<len> key=value\n`) into a map.
 * @param {Buffer} body
 * @param {number} offset
 * @returns {Map<string, string>}
 */
function parsePax(body, offset) {
  const out = new Map();
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp === -1) throw new ArchiveParseError(`pax header at ${offset}: record without length`);
    const lenStr = body.subarray(i, sp).toString('ascii');
    const len = Number(lenStr);
    if (!/^\d+$/.test(lenStr) || len <= sp - i || i + len > body.length || body[i + len - 1] !== 0x0a) {
      throw new ArchiveParseError(`pax header at ${offset}: malformed record`);
    }
    const rec = body.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq === -1) throw new ArchiveParseError(`pax header at ${offset}: record without '='`);
    out.set(rec.slice(0, eq), rec.slice(eq + 1));
    i += len;
  }
  return out;
}

/**
 * Normalise an entry path: strip npm's `package/` root, reject unsafe shapes.
 * @param {string} raw
 * @param {number} offset
 */
function safePath(raw, offset) {
  if (raw === '' || raw.startsWith('/') || raw.includes('\\') || /^[A-Za-z]:/.test(raw)) {
    throw new ArchiveParseError(`tar entry at ${offset}: unsafe path ${JSON.stringify(raw)}`);
  }
  const segs = raw.split('/');
  if (segs.includes('..')) throw new ArchiveParseError(`tar entry at ${offset}: '..' segment in ${JSON.stringify(raw)}`);
  const p = raw.startsWith('package/') ? raw.slice('package/'.length) : raw;
  if (p === '') throw new ArchiveParseError(`tar entry at ${offset}: empty path after root strip`);
  return p;
}

/**
 * Per-file content manifest of a gzip'd npm tarball, parsed in memory (never
 * extracted). Supports ustar (incl. the 155-byte prefix field), pax `path=`
 * overrides (typeflag `x`) and GNU long names (typeflag `L`). Regular files
 * (typeflag `0`, NUL or `7`) are collected, directories skipped; any other
 * entry type (links, devices) is rejected because the manifest could not
 * represent it.
 *
 * @param {Buffer|Uint8Array} tgzBuffer gzip'd tar bytes
 * @returns {{files: Array<{path: string, size: number, sha256: string}>, count: number, digest: string}}
 *   `digest` = sha256 hex over `${path}\0${sha256}\n` lines in sorted order.
 * @throws {ArchiveParseError} on bad gzip, truncated header/body, bad checksum,
 *   absolute or `..` paths, duplicate paths or unsupported entry types
 */
export function archiveContentManifest(tgzBuffer) {
  let tar;
  try {
    tar = gunzipSync(tgzBuffer);
  } catch (err) {
    throw new ArchiveParseError(`gunzip failed: ${/** @type {Error} */ (err).message}`);
  }
  /** @type {Map<string, {path: string, size: number, sha256: string}>} */
  const files = new Map();
  let offset = 0;
  /** @type {string|null} */
  let pendingPath = null;
  while (offset < tar.length) {
    if (offset + 512 > tar.length) throw new ArchiveParseError(`truncated tar header at ${offset}`);
    const h = tar.subarray(offset, offset + 512);
    if (h.every((b) => b === 0)) break; // end-of-archive block
    const sum = octal(h, 148, 8, 'checksum', offset);
    let actual = 0;
    for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== actual) throw new ArchiveParseError(`tar header at ${offset}: checksum mismatch`);
    const size = octal(h, 124, 12, 'size', offset);
    const type = String.fromCharCode(h[156]);
    const bodyStart = offset + 512;
    if (bodyStart + size > tar.length) throw new ArchiveParseError(`truncated tar body at ${bodyStart} (${size} bytes declared)`);
    const body = tar.subarray(bodyStart, bodyStart + size);
    const headerOffset = offset;
    offset = bodyStart + Math.ceil(size / 512) * 512;

    if (type === 'x') {
      const p = parsePax(body, headerOffset).get('path');
      if (p !== undefined) pendingPath = p;
      continue;
    }
    if (type === 'L') {
      pendingPath = cstr(body, 0, body.length);
      continue;
    }
    if (type === 'g' || type === 'K') continue; // global pax / GNU long link name: no path for the next entry
    let name = cstr(h, 0, 100);
    if (cstr(h, 257, 6).startsWith('ustar')) {
      const prefix = cstr(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (pendingPath !== null) {
      name = pendingPath;
      pendingPath = null;
    }
    if (type === '5') continue;
    if (type !== '0' && type !== '\0' && type !== '7') {
      throw new ArchiveParseError(`tar entry at ${headerOffset}: unsupported type ${JSON.stringify(type)} for ${JSON.stringify(name)}`);
    }
    const path = safePath(name, headerOffset);
    if (files.has(path)) throw new ArchiveParseError(`tar entry at ${headerOffset}: duplicate path ${JSON.stringify(path)}`);
    files.set(path, { path, size, sha256: createHash('sha256').update(body).digest('hex') });
  }
  const sorted = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const d = createHash('sha256');
  for (const f of sorted) d.update(`${f.path}\0${f.sha256}\n`);
  return { files: sorted, count: sorted.length, digest: d.digest('hex') };
}

/**
 * Per-file diff of two content manifests (local preflight archive vs registry tarball).
 *
 * @param {{files: Array<{path: string, sha256: string}>}} local
 * @param {{files: Array<{path: string, sha256: string}>}} registry
 * @returns {{equal: boolean, onlyLocal: string[], onlyRegistry: string[], changed: string[]}}
 */
export function compareContentManifests(local, registry) {
  const l = new Map(local.files.map((f) => [f.path, f.sha256]));
  const r = new Map(registry.files.map((f) => [f.path, f.sha256]));
  const onlyLocal = [...l.keys()].filter((p) => !r.has(p)).sort();
  const onlyRegistry = [...r.keys()].filter((p) => !l.has(p)).sort();
  const changed = [...l.keys()].filter((p) => r.has(p) && r.get(p) !== l.get(p)).sort();
  return { equal: onlyLocal.length + onlyRegistry.length + changed.length === 0, onlyLocal, onlyRegistry, changed };
}

/**
 * True when `url` parses and its normalised href starts with `prefix`.
 * Normalising first defeats `..` and host tricks in the raw string.
 * @param {unknown} url
 * @param {string} prefix
 */
function underPrefix(url, prefix) {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).href.startsWith(prefix);
  } catch {
    return false;
  }
}

/**
 * True when `url`, normalised by `new URL(...).href`, is exactly the registry
 * tarball of `target` — never another version's or another file under the prefix.
 * @param {unknown} url
 * @param {string} target
 */
function isExactTarballUrl(url, target) {
  if (typeof url !== 'string') return false;
  try {
    return new URL(url).href === `${TARBALL_PREFIX}${TRUSTED_PACKAGE}-${target}.tgz`;
  } catch {
    return false;
  }
}

/**
 * Does sha512(`tarball`) equal the sha512 inside `dist.integrity`? PURE. Checked
 * BEFORE the tarball is parsed, so the parser only ever sees the bytes the
 * registry (and the SLSA subject) vouch for. `false` when either side is not
 * measurable.
 *
 * @param {Buffer|Uint8Array|null|undefined} tarball
 * @param {unknown} integrity `sha512-<base64>`
 * @returns {boolean}
 */
export function tarballMatchesIntegrity(tarball, integrity) {
  const want = integrityHex(integrity);
  if (want === null || !tarball) return false;
  return createHash('sha512').update(tarball).digest('hex') === want;
}

/**
 * Fetch the public, login-free registry evidence for `target`: the version
 * document, its attestations and its tarball. NEVER throws; every failure is
 * collected in `errors`. HTTP 404 on the version document means "not published
 * yet" (`versionDoc: null`, no error). Attestation and tarball URLs are only
 * followed when they point at registry.npmjs.org under the expected paths;
 * any other host is refused without a request.
 *
 * @param {string} target release version, `X.Y.Z`
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [opts]
 * @returns {Promise<{versionDoc: any, attestations: any, tarball: Buffer|null, errors: string[]}>}
 */
export async function fetchTrustedPublishEvidence(target, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  /** @type {{versionDoc: any, attestations: any, tarball: Buffer|null, errors: string[]}} */
  const out = { versionDoc: null, attestations: null, tarball: null, errors: [] };
  if (typeof target !== 'string' || !SEMVER_RE.test(target)) {
    out.errors.push(`invalid target ${JSON.stringify(target)}`);
    return out;
  }
  /**
   * @param {string} url
   * @param {'json'|'bytes'} kind
   * @returns {Promise<{status: number, value?: any}|null>} null on transport/parse error (already recorded)
   */
  const get = async (url, kind) => {
    try {
      const res = await fetchImpl(url, {
        // A redirect could leave registry.npmjs.org after the URL check below.
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: kind === 'json' ? 'application/json' : 'application/octet-stream' },
      });
      if (!res.ok) return { status: res.status };
      const value = kind === 'json' ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, value };
    } catch (err) {
      out.errors.push(`GET ${url} failed: ${/** @type {Error} */ (err)?.message || String(err)}`);
      return null;
    }
  };

  const docUrl = `${REGISTRY_BASE}/${TRUSTED_PACKAGE}/${target}`;
  const doc = await get(docUrl, 'json');
  if (!doc) return out;
  if (doc.status === 404) return out;
  if (doc.status < 200 || doc.status >= 300 || doc.value === undefined) {
    out.errors.push(`GET ${docUrl} returned HTTP ${doc.status}`);
    return out;
  }
  out.versionDoc = doc.value;

  const attUrl = doc.value?.dist?.attestations?.url;
  if (underPrefix(attUrl, ATTESTATIONS_PREFIX)) {
    const att = await get(attUrl, 'json');
    if (att && att.value !== undefined) out.attestations = att.value;
    else if (att) out.errors.push(`GET ${attUrl} returned HTTP ${att.status}`);
  } else {
    out.errors.push(`refused attestations URL ${JSON.stringify(attUrl ?? null)} (must start with ${ATTESTATIONS_PREFIX})`);
  }

  const tgzUrl = doc.value?.dist?.tarball;
  if (isExactTarballUrl(tgzUrl, target)) {
    const tgz = await get(tgzUrl, 'bytes');
    if (tgz && tgz.value !== undefined) out.tarball = tgz.value;
    else if (tgz) out.errors.push(`GET ${tgzUrl} returned HTTP ${tgz.status}`);
  } else {
    out.errors.push(`refused tarball URL ${JSON.stringify(tgzUrl ?? null)} (must be ${TARBALL_PREFIX}${TRUSTED_PACKAGE}-${target}.tgz)`);
  }
  return out;
}
