/**
 * floating-tags.mjs — Security-Delta check `floating-tag` (#1769, stage 1).
 *
 * Owns the shared container-image reference parser (`parseImageRefs`) and the
 * small async git readers the stage-1 checks share. A ref floats when it is
 * neither digest-pinned nor pinned to a concrete tag: `latest`, no tag,
 * `lts`, `lts-*` or `current`.
 */

import { basename } from 'node:path';
import { promisify } from 'node:util';

import { redactedEnv } from '../redacted-env.mjs';
import { makeCheckResult, makeFinding } from './contract.mjs';
import { execFile } from '../native-command.mjs';

const execFileAsync = promisify(execFile);

const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * git's wording for "this path is not in that tree" — the only error that means absent.
 * A full SHA that names no object gets the same wording (measured in the review
 * of #1774). floating-tag, age-gate and lockfiles run `git diff` over the range
 * first, which fails hard on a missing object; runtime-floor checks only head
 * that way (`git ls-tree`), so a missing base reads as absent there and its
 * findings count as introduced, the conservative direction.
 */
export const PATH_ABSENT = /fatal: path '.*' (?:does not exist in|exists on disk, but not in) /;

/**
 * Environment for a git call whose error text is matched: untranslated
 * messages, because `PATH_ABSENT` matches git's English wording only.
 * The result carries the full env, so it serializes to key names only
 * (SEC-008, SO#1785); ceiling of that redaction: scripts/lib/redacted-env.mjs.
 * @param {NodeJS.ProcessEnv} [env] — base env; tests pass a synthetic one
 * @returns {NodeJS.ProcessEnv}
 */
export function gitEnv(env = process.env) {
  return redactedEnv({ ...env, LC_ALL: 'C', LANG: 'C', LANGUAGE: '' });
}

/**
 * Whether a git ref is safe to pass as an argument: non-empty, no leading `-`
 * (argument injection), only ref characters.
 * @param {unknown} ref
 * @returns {boolean}
 */
export function isSafeRef(ref) {
  return typeof ref === 'string' && /^[\w./@^~][\w./@^~{}-]*$/.test(ref) && !ref.startsWith('-');
}

/**
 * Whether an error came from running git (the execFile wrapper), not from our own code.
 * Node sets `cmd` on every execFile error: a non-zero exit (numeric `code`), a
 * signal, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and a spawn failure (`ENOENT`).
 * Only such an error may count as "unreadable"; anything else (a TypeError, a
 * ContractError) is a defect and must surface as `internal-error`.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isGitExecError(err) {
  return err instanceof Error && typeof (/** @type {{cmd?: unknown}} */ (err).cmd) === 'string';
}

/**
 * Files changed in `base..head` that still exist in head (added, copied, modified, renamed).
 * `-z`: without it `core.quotePath` prints a non-ASCII path as `"dock\303\251r/…"`,
 * which no path predicate matches (#1775).
 * @param {string} repoRoot
 * @param {string} base
 * @param {string} head
 * @returns {Promise<string[]>} repo-relative paths
 */
export async function changedFiles(repoRoot, base, head) {
  const { stdout } = await execFileAsync('git', ['diff', '--name-only', '-z', '--diff-filter=ACMR', base, head, '--'], {
    cwd: repoRoot,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout.split('\0').filter(Boolean);
}

/**
 * Whether `path` exists in the tree of `ref`, without reading its content (#1775:
 * a lockfile above the 16 MB buffer must not read as unreadable just to test existence).
 * `git ls-tree` exits 0 with the entry when present and 0 with no output when
 * absent; a missing commit or tree object exits non-zero and throws. Measured
 * 2026-10-24: `git cat-file -e <ref>:<path>` is NOT usable here — for a missing
 * root tree and for an unknown full SHA it prints the same "path … does not exist /
 * not in" wording as a genuinely absent path.
 * @param {string} repoRoot
 * @param {string} ref
 * @param {string} path  repo-relative
 * @returns {Promise<boolean>}
 */
export async function pathExistsAt(repoRoot, ref, path) {
  // --literal-pathspecs: a path from `diff --name-only` may start with `:`, which
  // ls-tree would otherwise read as pathspec magic and report as absent (#1775).
  const { stdout } = await execFileAsync('git', ['--literal-pathspecs', 'ls-tree', '-z', '--name-only', ref, '--', path], {
    cwd: repoRoot,
    maxBuffer: GIT_MAX_BUFFER,
    env: gitEnv(),
  });
  return stdout.split('\0').includes(path);
}

/**
 * Content of `<ref>:<path>`, or null when the path does not exist at that ref.
 * Any other failure (maxBuffer, a bad ref, an unreadable object) throws: an
 * unread file is unchecked, never absent, which would read as clean (#1774).
 * @param {string} repoRoot
 * @param {string} ref
 * @param {string} path  repo-relative
 * @returns {Promise<string|null>}
 */
export async function showFile(repoRoot, ref, path) {
  try {
    const { stdout } = await execFileAsync('git', ['show', `${ref}:${path}`], {
      cwd: repoRoot,
      maxBuffer: GIT_MAX_BUFFER,
      env: gitEnv(),
    });
    return stdout;
  } catch (err) {
    if (PATH_ABSENT.test(`${err?.stderr ?? ''}\n${err?.message ?? ''}`)) return null;
    throw err;
  }
}

/**
 * All file paths in the tree of `ref`. `-z` keeps non-ASCII paths unquoted (#1775).
 * @param {string} repoRoot
 * @param {string} ref
 * @returns {Promise<string[]>}
 */
export async function listTree(repoRoot, ref) {
  const { stdout } = await execFileAsync('git', ['ls-tree', '-r', '--name-only', '-z', ref], {
    cwd: repoRoot,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout.split('\0').filter(Boolean);
}

/**
 * Whether a path is a Dockerfile (`Dockerfile`, `Dockerfile.prod`, `app.dockerfile`).
 * @param {string} path
 * @returns {boolean}
 */
export function isDockerfile(path) {
  const name = basename(path);
  return /^(?:Dockerfile|Containerfile)(?:\..+)?$/i.test(name) || /\.dockerfile$/i.test(name);
}

const FIXTURE_SEGMENTS = new Set(['fixtures', '__fixtures__', 'testdata', 'test-fixtures']);

/**
 * Whether a path lies under a test-fixture directory (`fixtures`, `__fixtures__`,
 * `testdata`, `test-fixtures` as a directory segment). Fixture files are sample
 * input for tests, not deployed declarations, so the checks skip them.
 * Ceiling (BV-004): a real deployment file under a directory of one of these
 * names is skipped too. Revisit if a repo deploys from such a directory.
 * @param {string} path  repo-relative
 * @returns {boolean}
 */
export function isFixturePath(path) {
  return String(path).split('/').slice(0, -1).some((segment) => FIXTURE_SEGMENTS.has(segment));
}

/**
 * Whether a path is one of the YAML files whose `image:` keys name container images.
 * @param {string} path
 * @returns {boolean}
 */
export function isImageYaml(path) {
  const name = basename(path);
  if (name === '.gitlab-ci.yml') return true;
  if (/^(?:docker-)?compose.*\.ya?ml$/i.test(name)) return true;
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
}

function stripQuotes(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

/**
 * Split an image reference into name, tag and digest.
 * `node:22-alpine@sha256:ab…` → `{ image: 'node', tag: '22-alpine', digest: 'sha256:ab…' }`.
 * A colon before the last `/` is a registry port, not a tag.
 * @param {string} ref
 * @returns {{image:string, tag:string|null, digest:string|null}}
 */
export function splitImageRef(ref) {
  let rest = ref;
  let digest = null;
  const at = rest.indexOf('@');
  if (at !== -1) {
    digest = rest.slice(at + 1) || null;
    rest = rest.slice(0, at);
  }
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    return { image: rest.slice(0, colon), tag: rest.slice(colon + 1) || null, digest };
  }
  return { image: rest, tag: null, digest };
}

function toRef(raw, line) {
  const ref = stripQuotes(raw);
  if (!ref) return null;
  const parts = splitImageRef(ref);
  // `${VAR}` / `$VAR` interpolation resolves at build time — the value is not measurable here.
  return { ...parts, line, ref, measurable: !ref.includes('$') };
}

/**
 * Parse container image references from a Dockerfile (`FROM <ref> [AS x]`) or
 * an image-bearing YAML file (`image: <ref>` and `image:\n  name: <ref>`).
 * `FROM scratch` and `FROM <earlier stage name>` are skipped. Refs with `$`
 * interpolation come back with `measurable: false`.
 *
 * @param {string} text  file content
 * @param {string} file  repo-relative path; decides the syntax
 * @returns {{image:string, tag:string|null, digest:string|null, line:number, ref:string, measurable:boolean}[]}
 */
export function parseImageRefs(text, file) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  const refs = [];
  if (isDockerfile(file)) {
    const stages = new Set();
    lines.forEach((raw, i) => {
      const m = /^\s*FROM\s+(.+)$/i.exec(raw);
      if (!m) return;
      const tokens = m[1].trim().split(/\s+/).filter((t) => !t.startsWith('--'));
      const [refToken, asWord, stage] = tokens;
      if (!refToken) return;
      // Only stages declared EARLIER can be referenced, so check before recording this one.
      const isStageRef = refToken.toLowerCase() === 'scratch' || stages.has(refToken.toLowerCase());
      if (asWord && /^as$/i.test(asWord) && stage) stages.add(stage.toLowerCase());
      if (isStageRef) return;
      const ref = toRef(refToken, i + 1);
      if (ref) refs.push(ref);
    });
    return refs;
  }
  if (!isImageYaml(file)) return refs;
  lines.forEach((raw, i) => {
    const m = /^\s*(?:-\s+)?image\s*:\s*(.*?)\s*(?:#.*)?$/.exec(raw);
    if (!m) return;
    if (m[1]) {
      const ref = toRef(m[1], i + 1);
      if (ref) refs.push(ref);
      return;
    }
    // Block form: `image:` followed by an indented `name: <ref>`.
    for (let j = i + 1; j < lines.length && j <= i + 5; j += 1) {
      const n = /^\s+name\s*:\s*(.*?)\s*(?:#.*)?$/.exec(lines[j]);
      if (n) {
        const ref = toRef(n[1], j + 1);
        if (ref) refs.push(ref);
        return;
      }
    }
  });
  return refs;
}

/**
 * Whether a parsed, measurable ref floats (not digest-pinned and tag missing,
 * `latest`, `lts`, `lts-*` or `current`).
 * @param {{tag:string|null, digest:string|null}} ref
 * @returns {boolean}
 */
export function isFloating(ref) {
  if (ref.digest && ref.digest.startsWith('sha256:')) return false;
  if (!ref.tag) return true;
  const tag = ref.tag.toLowerCase();
  return tag === 'latest' || tag === 'lts' || tag.startsWith('lts-') || tag === 'current';
}

function refKey(ref) {
  return `${ref.image}:${ref.tag ?? ''}@${ref.digest ?? ''}`;
}

/**
 * Report floating image tags in the image-bearing files changed in `base..head`.
 * Never throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string|null} [opts.base]  full SHA; empty → skipped/no-range
 * @param {string} [opts.head]
 * @returns {Promise<ReturnType<typeof makeCheckResult>>}
 */
export async function runFloatingTagCheck({ repoRoot, base, head } = {}) {
  const started = Date.now();
  const done = (r) => makeCheckResult({ id: 'floating-tag', ms: Date.now() - started, ...r });
  try {
    if (!base) return done({ status: 'skipped', reason: 'no-range' });
    if (!isSafeRef(base) || !isSafeRef(head)) return done({ status: 'degraded', reason: 'invalid-ref', unchecked: 1 });
    const files = (await changedFiles(repoRoot, base, head)).filter((f) => !isFixturePath(f) && (isDockerfile(f) || isImageYaml(f)));
    if (files.length === 0) return done({ status: 'skipped', reason: 'no-relevant-change' });

    const findings = [];
    let checked = 0;
    let interpolated = 0;
    let unreadable = 0;
    for (const file of files) {
      let headText;
      try {
        headText = await showFile(repoRoot, head, file);
      } catch (err) {
        if (!isGitExecError(err)) throw err;
        unreadable += 1;
        continue;
      }
      const headRefs = parseImageRefs(headText ?? '', file);
      // An unreadable base leaves open whether a ref is new: report it as introduced.
      let baseKeys = null;
      try {
        baseKeys = new Set(parseImageRefs((await showFile(repoRoot, base, file)) ?? '', file).map(refKey));
      } catch (err) {
        if (!isGitExecError(err)) throw err;
        unreadable += 1;
      }
      for (const ref of headRefs) {
        if (!ref.measurable) {
          interpolated += 1;
          continue;
        }
        checked += 1;
        if (!isFloating(ref)) continue;
        findings.push(
          makeFinding({
            class: 'floating-tag',
            severity: 'medium',
            ecosystem: 'image',
            package: ref.image,
            version: ref.tag,
            file,
            introduced: baseKeys === null || !baseKeys.has(refKey(ref)),
          }),
        );
      }
    }
    // Findings from the readable files stay; the run says it is incomplete.
    if (unreadable > 0) return done({ status: 'degraded', reason: 'unreadable', checked, unchecked: unreadable, findings });
    if (checked === 0) {
      return done({ status: interpolated > 0 ? 'not-measurable' : 'skipped', reason: interpolated > 0 ? 'interpolated' : 'no-image-ref' });
    }
    return done({ status: 'ok', reason: interpolated > 0 ? 'some-interpolated' : null, checked, findings });
  } catch {
    return done({ status: 'degraded', reason: 'internal-error', unchecked: 1 });
  }
}
