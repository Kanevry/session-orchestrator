/**
 * ui-touch.mjs — did a change set touch UI, and what is this session's change
 * set? (#1452)
 *
 * The trigger signal for the default-on design review. Two halves:
 *
 *   1. `classifyUiPaths()` — glob classification. The defaults name
 *      APPLICATION UI SOURCE only (components, pages and routes, app styles,
 *      in-app copy catalogues). Reports, research and audit HTML, eval and
 *      fixture pages, scaffolds, exported designs, e-mail templates, video
 *      compositions and tool output are excluded: measured over six repos on
 *      2026-11-12 (MR !413 review), the first defaults matched 974 files in
 *      EventDrop.at and 288 research/audit HTML files in the vault.
 *   2. `resolveSessionChangeSet()` — which files did THIS session change? It
 *      returns `{ ok: false, reason }` whenever git cannot answer, so a blocking
 *      caller can say "unmeasured" instead of reading an empty list as "no UI
 *      touched" (the fail-open of the first version: an unresolvable ref, a
 *      missing git and a non-git directory all passed silently).
 *
 * This module only classifies and measures. It owns no design knowledge: what a
 * reviewer checks lives in agentic-designer's review contract, not here.
 */

import { opendirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { matchGlob } from './glob-match.mjs';
import { spawnSync } from './native-command.mjs';
import { resolveBaselineRange } from './vcs-repo-spec.mjs';

/** Application UI source. Logic files count only inside UI directories. */
export const DEFAULT_UI_GLOBS = Object.freeze([
  '**/*.{tsx,jsx,vue,svelte,astro}',
  '*.{css,scss,sass,less,styl,pcss}',
  '**/{app,apps,src,styles,components,pages,routes,public,site,web,www,packages,lib}/**/*.{css,scss,sass,less,styl,pcss}',
  '**/{app,src,pages,routes,components,content}/**/*.mdx',
  'index.html',
  '**/{app,src,pages,routes,public,site,web,www}/**/*.{html,htm}',
  '**/{app,src,views,layouts,pages,_includes,_layouts}/**/*.{hbs,handlebars,ejs,njk,liquid,pug,erb,twig}',
  '**/{components,views,layouts,screens,pages}/**/*.{ts,js,mjs}',
  'messages/**/*.{json,yml,yaml}',
  '**/{locales,locale,i18n,lang,translations}/**/*.{json,yml,yaml,po,ftl,arb,properties}',
  '**/*.{po,ftl,xcstrings,strings}',
]);

/** Never UI, whatever `include` says. */
export const DEFAULT_UI_EXCLUDES = Object.freeze([
  // tests and stories
  '**/*.{test,spec}.*',
  // (`test`/`tests` directories: see TEST_DIRS, a route may be named `test`)
  '**/{__tests__,__snapshots__,__mocks__,__fixtures__,e2e,cypress,fixture,fixtures,eval,evals}/**',
  '**/*.{stories,story}.*',
  '**/{.storybook,stories}/**',
  // test setup and mocks
  '**/{vitest,jest}.setup.*',
  '**/{setupTests,setup-tests,test-setup}.*',
  '**/{test-utils,testUtils,test-helpers}.*',
  '**/{test-utils,testUtils,test-helpers,mocks}/**',
  // generated and tool output
  '**/{node_modules,dist,build,out,.next,.nuxt,.svelte-kit,.astro,coverage,vendor,.venv,__pycache__}/**',
  // (`target` is build output at these locations: `app/target/page.tsx` is UI)
  'target/**',
  '{apps,packages,crates,modules}/*/target/**',
  '**/{playwright-report,test-results,blob-report,storybook-static,.orchestrator}/**',
  // (not a bare `generated` directory: `src/components/generated/Chart.tsx` is UI)
  '**/{__generated__,gql}/**',
  '**/*.{generated,gen}.*',
  '**/*.d.ts',
  '**/*.min.{css,js}',
  // not the application's rendered UI: docs, research, scaffolds, exports, video
  '{docs,doc,design,designs,assets,marketing,templates,examples,example,research,reports,audits,scripts}/**',
  '{apps,packages}/*/{docs,doc,research,reports,audits,scripts}/**',
  '**/remotion/**',
  // server code: API routes and route handlers, and logic files in api/server
  // directories. Components, pages and styles that merely live in a directory
  // named `api` or `server` (`app/settings/api/page.tsx`,
  // `src/routes/server/+page.svelte`, `src/server/components/Card.vue`) are UI
  // (M1, MR !413 review 4 M-A). Next's `pages/api` and `app/api` hold only
  // API routes, `.tsx` included.
  '**/{pages,app}/api/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,json}',
  '**/app/**/route.{ts,js,mjs,mts}',
  '**/{api,server}/**/*.{ts,js,mjs,cjs,mts,cts,json,html,htm}',
]);

/**
 * E-mail template directories (react-email `emails/`, `mails/`,
 * `email/templates/` …). Excluded unless they sit inside an app route tree
 * (`app/mails/page.tsx` is a real page) or a component/feature tree. A plain
 * `email`/`mail` directory is not a template directory:
 * `src/components/email/EmailInput.tsx` is UI (M1, review 4 M-A).
 */
const EMAIL_TEMPLATE_DIRS = Object.freeze(['**/{emails,mails}/**', '**/{email,mail}/{templates,template}/**']);
const EMAIL_KEEP = Object.freeze(['**/{app,pages,routes,components,features}/**/{emails,mails,email,mail}/**']);
/** Test directories, except a route named `test` inside an app route tree (`app/test/page.tsx`). */
const TEST_DIRS = Object.freeze(['**/{tests,test}/**']);
const TEST_KEEP = Object.freeze(['**/{app,pages,routes}/**/{tests,test}/**']);

function nonEmptyStrings(list) {
  return Array.isArray(list) ? list.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim()) : [];
}

/** Literal glob characters whose meaning is the same in every matcher. */
const PLAIN_CHAR = /^[A-Za-z0-9_./@~ -]$/;
/** Brace alternatives use literals and at most one star. Slash and range checks follow below. */
const PLAIN_BRACE_ALT = /^[A-Za-z0-9_./@~ -]*(?:\*[A-Za-z0-9_./@~ -]*)?$/;
/** A character class of letters and digits, with ascending `x-y` ranges only. */
const PLAIN_CLASS = /^(?:[A-Za-z0-9](?:-[A-Za-z0-9])?)+$/;
const MAX_JUDGED_GLOB = 1024;

/**
 * The glob grammar this classifier can judge: literal characters
 * (`A-Z a-z 0-9 _ . / @ ~ -` and space), `*`, `?`, `**`, a character
 * class of letters and digits (`[abc]`, `[a-z0-9]`), and one level of
 * `{a,b}` alternatives of literals and at most one star, with no adjacent
 * dot and star, range or slash. Inside it, `glob-match.mjs` and
 * picomatch 4 (`dot: true`, the matcher before #2138) agree; a differential
 * run over generated globs and paths backs that (MR !443 review round 4).
 *
 * Everything else cannot be judged: POSIX and negated classes, ranges,
 * parentheses and extglobs, backslash escapes, nested braces, overlong
 * patterns. The classifier then fails CLOSED: an include glob of this kind
 * matches every file, an exclude glob of this kind excludes nothing, and the
 * caller gets a warning naming the glob. An allowlist, not a list of known
 * divergences: review round 4 found divergent forms that a denylist missed.
 *
 * BV-004 ceiling: a guard, not picomatch parity. Revisit with the first
 * shipped or consumer glob outside this grammar (#2143).
 *
 * @param {string} glob
 * @returns {string|null} why the glob cannot be judged, or null when it can.
 */
export function divergentGlobReason(glob) {
  if (glob.length > MAX_JUDGED_GLOB) return `a pattern longer than ${MAX_JUDGED_GLOB} characters`;
  if (glob.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return 'an empty, "." or ".." segment';
  // picomatch's fast path for exactly these two needs a character after the last dot (`a.` does not match).
  if (glob === '*.*' || glob === '**/*.*') return 'the picomatch fast path "*.*"';
  if (glob.split('/').some((segment) => segment.includes('**') && segment !== '**')) return 'a "**" that is not a whole segment';
  for (const [, body] of glob.matchAll(/\{([^{}]*)\}/g)) {
    // picomatch keeps `{Card*}` (no comma) as literal braces; glob-match groups it (MR !443 R5).
    if (!body.includes(',') && !body.includes('..')) return 'a brace with one alternative';
    const alternatives = body.split(',');
    if (alternatives.some((alt) => /^\**$/.test(alt))) return 'an empty or "*"-only brace alternative';
    // picomatch rejects "a.." against "{a.*.,b}"; glob-match accepts it (MR !443 R6).
    if (alternatives.some((alt) => /\.\*|\*\./.test(alt))) return 'a "." next to "*" in a brace alternative';
    if (alternatives.some((alt) => !PLAIN_BRACE_ALT.test(alt))) return 'a brace alternative outside the literal-or-single-star grammar';
  }
  // picomatch does not let `a*/**` match `ab` (no child segment); glob-match does.
  const trail = /(?:^|\/)([^/]*)(?:\/\*\*)+$/.exec(glob);
  if (trail && trail[1] !== '**' && trail[1].endsWith('*')) return 'a segment ending in "*" before a final "/**"';
  let inBraces = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' || c === '?' || PLAIN_CHAR.test(c)) {
      if (inBraces && c === '.' && glob[i + 1] === '.') return 'a brace range "{x..y}"';
      if (inBraces && c === '/') return 'a "/" inside braces';
      continue;
    }
    if (c === '[') {
      const close = glob.indexOf(']', i + 1);
      const body = close < 0 ? glob.slice(i + 1) : glob.slice(i + 1, close);
      if (body.startsWith('!') || body.startsWith('^')) return 'a negated class "[!…]"';
      if (body.includes('[:')) return 'a POSIX named class "[[:…:]]"';
      if (close < 0 || !PLAIN_CLASS.test(body) || /([A-Za-z0-9])-([A-Za-z0-9])/.test(body) && !ascendingRanges(body)) {
        return `the character class "${glob.slice(i, close < 0 ? glob.length : close + 1)}"`;
      }
      i = close;
      continue;
    }
    if (c === '{' && !inBraces) {
      inBraces = true;
      continue;
    }
    if (c === '{') return 'nested braces';
    if (c === ',' && inBraces) continue;
    if (c === '}' && inBraces) {
      inBraces = false;
      continue;
    }
    return `the character "${c === '\n' ? '\\n' : c}"`;
  }
  return inBraces ? 'an unclosed "{"' : null;
}

function ascendingRanges(body) {
  return [...body.matchAll(/([A-Za-z0-9])-([A-Za-z0-9])/g)].every(([, a, b]) => a <= b &&
    (/\d/.test(a) === /\d/.test(b)) && (a.toLowerCase() === a) === (b.toLowerCase() === b));
}

/**
 * A control character or line separator in a path. Such paths cannot get a
 * coverage key and need an explicit owner override to clear the close gate.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function hasControlChar(filePath) {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this detects
  return /[\u0000-\u001f\u007f\u2028\u2029]/.test(filePath);
}

/**
 * A path the matchers read differently: a control character in a file name, an
 * empty, `.` or `..` segment (git never lists one), and off Windows a
 * backslash. picomatch turned backslashes into separators on win32 only,
 * glob-match does it everywhere.
 *
 * @param {string} filePath
 * @param {string} [platform]
 * @returns {boolean}
 */
export function unjudgeablePath(filePath, platform = process.platform) {
  return hasControlChar(filePath) ||
    (platform !== 'win32' && filePath.includes('\\')) ||
    filePath.replace(/\\/g, '/').split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function divergenceWarnings(globs, kind) {
  return globs.flatMap((glob) => {
    const reason = divergentGlobReason(glob);
    if (!reason) return [];
    const effect = kind === 'include' ? 'counted as matching every file' : 'ignored, it excludes nothing';
    return [`WARN design-review ${kind} glob "${glob}" uses ${reason}, which the glob matcher cannot judge: ${effect} (fail-closed, #2138)`];
  });
}

const EMBEDDED_SCAN_ENTRIES = 4096;

function descendantMatcher(globs) {
  // Before the first globstar, the directory has to match one segment at a
  // time. The globstar can absorb remaining segments before a matching file.
  const prefixes = globs.map((glob) => {
    const segments = glob.split('/');
    const globstar = segments.indexOf('**');
    return { segments: globstar === -1 ? segments : segments.slice(0, globstar), recursive: globstar !== -1 };
  });
  return (directory) => {
    const parts = directory.split('/');
    return prefixes.some(({ segments, recursive }) =>
      (recursive || parts.length < segments.length) &&
      segments.slice(0, parts.length).every((segment, i) => matchGlob(parts[i], segment)));
  };
}

/** True on a UI match, false after a complete scan, null if the scan cannot decide. */
function embeddedUiMatch(repoRoot, rootPath, matchesUi, canScan) {
  const pending = [rootPath];
  let entries = 0;
  try {
    const root = realpathSync(repoRoot);
    while (pending.length > 0) {
      const relative = pending.pop();
      const path = join(root, relative);
      // Do not open a directory reached through a symlink.
      if (realpathSync(path) !== path) return null;
      if (++entries > EMBEDDED_SCAN_ENTRIES) return null;
      const dir = opendirSync(path);
      try {
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          if (entry.name === '.git' || entry.name === 'node_modules') continue;
          const child = `${relative}/${entry.name}`;
          if (unjudgeablePath(child)) return true;
          const isDirectory = entry.isDirectory();
          if (isDirectory && canScan.excluded(child)) continue;
          if (matchesUi(child)) return true;
          if (isDirectory && canScan.descendant(child)) pending.push(child);
        }
      } finally {
        dir.closeSync();
      }
    }
  } catch {
    return null;
  }
  return false;
}

/**
 * Which of `files` are UI files? Pure when `repoRoot` is omitted.
 *
 * `include` REPLACES the default UI globs when non-empty; `exclude` is ADDED to
 * the default exclusions, which always apply.
 *
 * A configured glob that `divergentGlobReason()` flags fails closed and adds
 * one entry to `warnings`. So does a path the matchers read differently
 * (`unjudgeablePath`): it counts as UI whatever the globs say, with one warning.
 * Directory entries are checked without their trailing slash. With `repoRoot`,
 * a bounded scan also checks their contents. An inconclusive scan counts as UI.
 *
 * @param {string[]} files — repo-relative paths, forward slashes (git output).
 * @param {{ include?: string[], exclude?: string[], repoRoot?: string }} [opts]
 * @returns {{ touched: boolean, paths: string[], warnings: string[] }} `paths` lists only the UI files, sorted.
 */
export function classifyUiPaths(files, opts = {}) {
  const include = nonEmptyStrings(opts.include);
  const exclude = nonEmptyStrings(opts.exclude);
  const warnings = [...divergenceWarnings(include, 'include'), ...divergenceWarnings(exclude, 'exclude')];
  const uiGlobs = include.length > 0 ? include : DEFAULT_UI_GLOBS;
  const extra = exclude.filter((glob) => !divergentGlobReason(glob));
  const isExcluded = defaultExcluder(extra);
  const includeAll = uiGlobs.some((glob) => divergentGlobReason(glob) !== null);
  const isUi = (f) => (includeAll || uiGlobs.some((glob) => matchGlob(f, glob))) && !isExcluded(f);
  // A trailing globstar can exclude a whole subtree. File-only excludes and
  // test/email excludes with exceptions cannot prove every descendant excluded.
  const subtreeExcludes = [...DEFAULT_UI_EXCLUDES, ...extra].filter((glob) => glob.endsWith('/**') || glob === '**');
  const canScan = {
    excluded: (dir) => subtreeExcludes.some((glob) => dir !== glob && matchGlob(dir, glob)),
    descendant: includeAll ? () => true : descendantMatcher(uiGlobs),
  };
  const candidates = [...new Set(Array.isArray(files) ? files : [])]
    .filter((f) => typeof f === 'string' && f.length > 0);
  const paths = [];
  for (const f of candidates) {
    // Porcelain marks untracked embedded repos with a trailing slash. Strip it
    // for matching so globs like apps/* still match the directory name.
    const directory = f.endsWith('/');
    const globPath = directory ? f.slice(0, -1) : f;
    if (unjudgeablePath(globPath)) {
      warnings.push(`WARN design-review path ${JSON.stringify(f)} has a control character, an empty, "." or ".." segment or (off Windows) a backslash, which the glob matcher cannot judge: counted as UI (fail-closed, #2138)`);
    } else if (!isUi(globPath)) {
      if (!directory || !opts.repoRoot || canScan.excluded(globPath) || !canScan.descendant(globPath)) continue;
      const match = embeddedUiMatch(opts.repoRoot, globPath, isUi, canScan);
      if (match === false) continue;
      if (match === null) {
        warnings.push(`WARN design-review could not finish scanning ${JSON.stringify(f)} within the ${EMBEDDED_SCAN_ENTRIES}-directory budget or read its contents: counted as unhashable UI (fail-closed, #2150)`);
        paths.push(f);
        continue;
      }
    }
    if (directory) {
      warnings.push(`WARN design-review path ${JSON.stringify(f)} is a directory or embedded repository inside the UI globs: it cannot be hashed and is refused (fail-closed, #2138)`);
    }
    paths.push(f);
  }
  return { touched: paths.length > 0, paths: paths.sort(), warnings };
}

/** `DEFAULT_UI_EXCLUDES` + extra globs, plus e-mail template and test directories outside UI trees. */
function defaultExcluder(extra = []) {
  const listed = [...DEFAULT_UI_EXCLUDES, ...extra];
  return (filePath) => {
    const matches = (globs) => globs.some((glob) => matchGlob(filePath, glob));
    return matches(listed) ||
      (matches(EMAIL_TEMPLATE_DIRS) && !matches(EMAIL_KEEP)) ||
      (matches(TEST_DIRS) && !matches(TEST_KEEP));
  };
}

/**
 * Classify an explicit file list (the wave's own `files_changed`). Never throws.
 *
 * @param {{ files?: string[], include?: string[], exclude?: string[] }} [opts]
 * @returns {{ touched: boolean, paths: string[] }}
 */
export function detectUiTouch(opts = {}) {
  try {
    return classifyUiPaths(opts.files ?? [], { include: opts.include, exclude: opts.exclude });
  } catch {
    return { touched: false, paths: [] };
  }
}

/** A value git may receive as a revision (no option, no whitespace). */
export const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/@{}^~-]*$/;

function git(repoRoot, args) {
  try {
    const r = spawnSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) return { ok: false, stdout: '', missing: r.error.code === 'ENOENT' };
    return { ok: r.status === 0, stdout: r.stdout ?? '' };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/** `name-status -z` output → paths that still exist (deletions dropped, renames → new path). */
function parseNameStatusZ(out) {
  const parts = out.split('\0').filter((s) => s.length > 0);
  const files = [];
  for (let i = 0; i < parts.length; i += 1) {
    const status = parts[i];
    if (/^[RC]/.test(status)) {
      files.push(parts[i + 2]);
      i += 2;
    } else {
      if (status[0] !== 'D') files.push(parts[i + 1]);
      i += 1;
    }
  }
  return files.filter(Boolean);
}

function commitFiles(repoRoot, commits) {
  const files = new Set();
  for (const c of commits) {
    const r = git(repoRoot, ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '-M', '--root', c]);
    if (!r.ok) return null;
    for (const f of parseNameStatusZ(r.stdout)) files.add(f);
  }
  return [...files];
}

/**
 * Working-tree changes (staged, unstaged, untracked), deletions dropped. With
 * `sinceMs`, a file whose mtime predates the session is left out and reported:
 * it was dirty before the session started (or nobody can tell it was not).
 */
function workingTreeFiles(repoRoot, sinceMs) {
  const r = git(repoRoot, ['status', '--porcelain', '-z', '-uall']);
  if (!r.ok) return null;
  const parts = r.stdout.split('\0').filter((s) => s.length > 0);
  const files = [];
  const preexisting = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i += 1; // the next field is the old path
    if (xy.includes('D')) continue;
    if (sinceMs !== null) {
      try {
        if (statSync(join(repoRoot, path)).mtimeMs < sinceMs) {
          preexisting.push(path);
          continue;
        }
      } catch {
        continue;
      }
    }
    files.push(path);
  }
  return { files, preexisting };
}

/**
 * `resolveBaselineRange()`, plus a local `main`/`master` when the repo has no
 * usable remote at all (that resolver gives up before its local tier then).
 */
function resolveBase(repoRoot) {
  const baseline = resolveBaselineRange({ repoRoot });
  if (baseline.ok || !['no-remotes', 'no-matching-remote'].includes(baseline.reason)) return baseline;
  for (const branch of ['main', 'master']) {
    if (git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok) {
      return { ok: true, base: branch, range: `${branch}...HEAD`, via: 'local-default-branch' };
    }
  }
  return baseline;
}

function isAncestor(repoRoot, a, b) {
  return git(repoRoot, ['merge-base', '--is-ancestor', a, b]).ok;
}

function listCommits(repoRoot, args) {
  const list = git(repoRoot, ['rev-list', '--no-merges', '--format=%H%x00%at%x00%ae%x00%ce', ...args]);
  if (!list.ok) return null;
  return list.stdout.split('\n')
    .map((l) => l.split('\0'))
    .filter((p) => p.length === 4 && /^[0-9a-f]{40}$/.test(p[0]) && /^\d+$/.test(p[1]))
    .map(([sha, at, authorEmail, committerEmail]) => ({ sha, authoredMs: Number(at) * 1000, emails: [authorEmail, committerEmail] }));
}

/** Short SHAs shown in the "not attributed" note before it is cut off. */
const NOTE_SHAS = 5;

/**
 * The visible note for candidate commits that carry this checkout's git
 * identity (`user.email` as author or committer) but are not counted (M-B):
 * made in another worktree, clone or host, re-dated by `rebase --reset-author-date`,
 * squashed into another commit, or replayed ambiguously; only the reasons that
 * can apply are named. Without `user.email` only ambiguous replays are named.
 * Never changes the verdict.
 */
function unattributedNote(repoRoot, dropped) {
  if (dropped.length === 0) return null;
  const email = git(repoRoot, ['config', 'user.email']).stdout.trim().toLowerCase();
  const mine = dropped.filter((c) => c.ambiguous || (email && c.emails.some((e) => e.toLowerCase() === email)));
  if (mine.length === 0) return null;
  const shown = mine.slice(0, NOTE_SHAS).map((c) => c.sha.slice(0, 7)).join(', ');
  const more = mine.length > NOTE_SHAS ? ` … +${mine.length - NOTE_SHAS} more` : '';
  const reasons = [
    ...(mine.some((c) => !c.ambiguous) ? ['created in another worktree, clone or host under the same identity', 'author date reset', 'squashed into another commit'] : []),
    ...(mine.some((c) => c.ambiguous) ? ['ambiguous author fingerprint'] : []),
  ];
  return `${mine.length} commit(s) with your git identity are not attributed to this checkout and are not counted ` +
    `(${reasons.join('; ')}): ${shown}${more}. Review their UI files by hand if they are this session's.`;
}

/** HEAD reflog subjects of a commit this checkout created itself. */
const CREATED_HERE = /^(commit( \((initial|amend)\))?|cherry-pick|revert|am): /;
/** Replays (`rebase`, `rebase -i`, `pull --rebase …`): own only when the replayed commit was own. */
const REPLAYED = / \((pick|continue|reword|edit|squash|fixup)\): /;

/**
 * Which commits did THIS checkout create during the session? Read from the
 * per-worktree HEAD reflog: `commit`, `commit (amend)`, `cherry-pick`, `revert`
 * and `am` entries are own; a rebase replay (`… (pick)` etc.) is own only when
 * the commit it replays was own, matched by author identity and author date,
 * which a replay keeps. Everything else (`pull: Fast-forward`, `merge …`,
 * `checkout`, `reset`) moves HEAD onto commits made elsewhere.
 *
 * The session window starts at `sinceMs` (second precision, like the reflog)
 * or, without it, after the oldest entry at `sinceRefSha`. The window must be
 * covered: a missing or emptied reflog, or one that starts after the session
 * and never saw the start ref, cannot tell own from foreign commits.
 *
 * `shas` maps each own commit to its identity-and-date fingerprint; `replayed`
 * names the ones that are own only through a replay; `originals` counts the
 * commits created here per fingerprint. More counted commits with one
 * fingerprint than were created with it means a foreign commit with the same
 * author and second was replayed as own (Codex 1); the caller drops them.
 *
 * @returns {{ ok: true, shas: Map<string, string>, replayed: Set<string>, originals: Map<string, number> }
 *   | { ok: false, reason: string }}
 */
function ownCommitShas(repoRoot, { sinceRefSha, sinceMs }) {
  const log = git(repoRoot, ['reflog', 'show', '--format=%H%x00%gd%x00%gs', '--date=unix', 'HEAD', '--']);
  if (!log.ok) return { ok: false, reason: 'no HEAD reflog' };
  const entries = log.stdout.split('\n')
    .map((line) => line.split('\0'))
    .filter((p) => p.length === 3 && /^[0-9a-f]{40}$/.test(p[0]))
    .map(([sha, selector, subject]) => ({ sha, sec: Number(/@\{(\d+)\}$/.exec(selector)?.[1] ?? NaN), subject }))
    .reverse(); // oldest first
  if (entries.length === 0) return { ok: false, reason: 'empty HEAD reflog' };
  if (entries.some((e) => !Number.isFinite(e.sec))) return { ok: false, reason: 'unreadable HEAD reflog' };

  let window;
  if (sinceMs !== null) {
    const startSec = Math.floor(sinceMs / 1000);
    const covered = entries[0].sec <= startSec || (sinceRefSha !== null && entries.some((e) => e.sha === sinceRefSha));
    if (!covered) return { ok: false, reason: 'HEAD reflog starts after the session start' };
    window = entries.filter((e) => e.sec >= startSec);
  } else {
    // The OLDEST entry at the start ref: HEAD returns to it whenever the
    // session switches back to an unchanged main, so the newest one would
    // drop the session's earlier commits.
    const anchor = entries.findIndex((e) => e.sha === sinceRefSha);
    if (anchor === -1) return { ok: false, reason: 'session start ref not in the HEAD reflog' };
    window = entries.slice(anchor + 1);
  }
  // An amend replaces the commit HEAD was on (the entry before it); that commit
  // is no longer an original, or it would lift its fingerprint's count. A no-op
  // amend (same tree, metadata and second) yields the same SHA again and
  // supersedes nothing (#2065 point 1).
  const superseded = new Set(entries.flatMap((entry, i) => (
    i > 0 && entry.subject.startsWith('commit (amend): ') && entries[i - 1].sha !== entry.sha
      ? [entries[i - 1].sha]
      : []
  )));
  window = window.filter((e) => CREATED_HERE.test(e.subject) || REPLAYED.test(e.subject));
  if (window.length === 0) return { ok: true, shas: new Map(), replayed: new Set(), originals: new Map() };

  const idents = git(repoRoot, ['show', '-s', '--format=%H%x00%an%x00%ae%x00%ad', '--date=raw', ...new Set(window.map((e) => e.sha))]);
  if (!idents.ok) return { ok: false, reason: 'reflog commits unreadable' };
  const author = new Map(idents.stdout.split('\n').map((l) => l.split('\0')).filter((p) => p.length === 4).map(([sha, ...rest]) => [sha, rest.join('\0')]));
  const shas = new Map();
  const created = new Set();
  const replayed = new Set();
  const ownAuthors = new Set();
  for (const e of window) {
    const who = author.get(e.sha);
    if (who === undefined) return { ok: false, reason: 'reflog commits unreadable' };
    if (CREATED_HERE.test(e.subject)) {
      created.add(e.sha);
      shas.set(e.sha, who);
      ownAuthors.add(who);
    } else if (ownAuthors.has(who)) {
      shas.set(e.sha, who);
      replayed.add(e.sha);
    }
  }
  for (const sha of created) replayed.delete(sha);
  for (const sha of superseded) created.delete(sha);
  const originals = new Map();
  for (const sha of created) originals.set(shas.get(sha), (originals.get(shas.get(sha)) ?? 0) + 1);
  return { ok: true, shas, replayed, originals };
}

/**
 * Which files did this session change? Its own commits plus the working tree;
 * deletions are dropped (a removed file cannot be reviewed).
 *
 * Own commits are the session's commits that are NOT on the default-branch
 * baseline — `git rev-list --no-merges <start>..HEAD ^<baseline>` — so a rebase
 * onto, or a merge of, an updated main never counts other sessions' files
 * (MR !413 review 2, H-A: the session-start ref is the main tip of a fresh
 * worktree and stays an ancestor after `git rebase origin/main`). Their files
 * are intersected with the net diff `<start>..HEAD`, which keeps a revert
 * inside the session cancelling out.
 *
 *   1. `sinceRef` (STATE.md `session-start-ref`), verified with `rev-parse`:
 *      - HEAD outside the baseline (a feature branch) → own commits as above
 *        (`own-commits`); a start ref that is no longer an ancestor (rewritten
 *        by a rebase) uses `HEAD ^<baseline>` authored at or after `sinceTime`;
 *      - HEAD inside the baseline (work on the default branch) or no baseline
 *        → net diff `sinceRef..HEAD` (`session-start-ref`); a non-ancestor ref
 *        there is unmeasured;
 *      - unresolvable → unmeasured (`since-ref-unresolvable`). Never HEAD~1.
 *   2. no ref but `sinceTime` → commits committed at or after it, minus the
 *      baseline when HEAD is outside it (`session-window-commits`).
 *   3. neither → the baseline three-dot range (`baseline:<via>`); when HEAD is
 *      inside the baseline, `partial: true`: only the working tree counts.
 *   4. nothing resolves → unmeasured.
 *
 * In 1. and 2. the candidate commits are further narrowed to the ones this
 * checkout created, read from its HEAD reflog (`ownCommitShas`): a pull that
 * brings a colleague's commits onto the default branch or onto the same
 * feature branch moves HEAD over them, but never as `commit`, so they never
 * count (MR !413 review 3, H2). When the reflog cannot answer (disabled,
 * expired, starting after the session) and there is a candidate commit, the
 * result is unmeasured (`own-commits-unmeasurable (…)`), never a change set.
 *
 * Ceilings: own commits that already reached the baseline mid-session (an MR
 * merged while the session goes on) are not counted on a feature branch; a
 * same-checkout peer that dirties a file during the session counts; commits
 * made in ANOTHER worktree or clone and merged or pulled in are not counted
 * (the reflog is per worktree), so the result errs towards under-counting; a
 * deliberate `cherry-pick` of a foreign commit counts as own. Candidate commits
 * with this checkout's git identity that are not counted (linked worktree,
 * `rebase --reset-author-date`, squash into a foreign commit, ambiguous replay)
 * are named in `notes` (M-B); the verdict does not change. Without `sinceTime`
 * the window starts at the OLDEST reflog entry at `sinceRef`, so an earlier
 * session's commit from that ref, brought back later, counts (known limit).
 *
 * @param {{ repoRoot: string, sinceRef?: string|null, sinceTime?: string|null }} opts
 * @returns {{ ok: true, files: string[], preexisting: string[], source: string, base: string|null,
 *   minus: string|null, partial: boolean, notes: string[] } | { ok: false, reason: string }}
 *   `minus` names the baseline whose commits were left out. An unparseable
 *   `sinceTime` is unmeasured (`since-time-invalid`), never a throw.
 */
export function resolveSessionChangeSet({ repoRoot, sinceRef = null, sinceTime = null }) {
  const probe = git(repoRoot, ['rev-parse', '--is-inside-work-tree']);
  if (!probe.ok) return { ok: false, reason: probe.missing ? 'git-unavailable' : 'not-a-git-repo' };
  const headOk = git(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).ok;
  // Only undefined/null mean "absent"; an explicit '' is as invalid as any other non-date.
  const sinceMs = sinceTime === undefined || sinceTime === null ? null : Date.parse(sinceTime);
  if (Number.isNaN(sinceMs)) return { ok: false, reason: 'since-time-invalid' };
  const baseline = headOk ? resolveBase(repoRoot) : { ok: false, reason: 'unborn-head' };
  const offBaseline = baseline.ok && !isAncestor(repoRoot, 'HEAD', baseline.base);

  let committed = [];
  let source;
  let base = null;
  let partial = false;
  // Candidate commits are narrowed to the ones this checkout created (H2); the
  // reflog is read only when there is a candidate to attribute.
  let own = null;
  const notes = [];
  const keepOwn = (commits, sinceRefSha) => {
    if (commits.length === 0) return { ok: true, commits };
    own ??= ownCommitShas(repoRoot, { sinceRefSha, sinceMs });
    if (!own.ok) return { ok: false, reason: `own-commits-unmeasurable (${own.reason})` };
    const kept = commits.filter((c) => own.shas.has(c.sha));
    // Codex 1: a replayed commit is own by fingerprint only; when more counted
    // commits carry a fingerprint than were created with it, one is foreign.
    const seen = new Map();
    for (const c of kept) seen.set(own.shas.get(c.sha), (seen.get(own.shas.get(c.sha)) ?? 0) + 1);
    const ambiguous = (c) => own.replayed.has(c.sha) && seen.get(own.shas.get(c.sha)) > (own.originals.get(own.shas.get(c.sha)) ?? 0);
    const counted = kept.filter((c) => !ambiguous(c));
    const note = unattributedNote(repoRoot, commits.filter((c) => !counted.includes(c)).map((c) => ({ ...c, ambiguous: ambiguous(c) })));
    if (note) notes.push(note);
    return { ok: true, commits: counted };
  };
  if (sinceRef) {
    const resolved = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${sinceRef}^{commit}`]);
    if (!resolved.ok || !headOk) return { ok: false, reason: 'since-ref-unresolvable' };
    base = resolved.stdout.trim();
    const ancestor = isAncestor(repoRoot, base, 'HEAD');
    let range;
    if (offBaseline) {
      range = ancestor ? [`${base}..HEAD`, `^${baseline.base}`] : ['HEAD', `^${baseline.base}`];
      source = 'own-commits';
    } else if (ancestor) {
      range = [`${base}..HEAD`];
      source = 'session-start-ref';
    } else {
      return { ok: false, reason: 'since-ref-not-ancestor-and-no-baseline' };
    }
    const commits = listCommits(repoRoot, range);
    if (commits === null) return { ok: false, reason: 'git-rev-list-failed' };
    // git stores author time in whole seconds: compare at second precision, or
    // a commit in the session's first second is dropped (Codex 4).
    const sinceSecMs = sinceMs === null ? null : Math.floor(sinceMs / 1000) * 1000;
    const windowed = offBaseline && !ancestor ? commits.filter((c) => sinceSecMs === null || c.authoredMs >= sinceSecMs) : commits;
    const kept = keepOwn(windowed, base);
    if (!kept.ok) return kept;
    const files = commitFiles(repoRoot, kept.commits.map((c) => c.sha));
    if (files === null) return { ok: false, reason: 'git-diff-failed' };
    const net = git(repoRoot, ['diff', '--name-status', '-z', '-M', base, 'HEAD']);
    if (!net.ok) return { ok: false, reason: 'git-diff-failed' };
    const netFiles = new Set(parseNameStatusZ(net.stdout));
    committed = files.filter((f) => netFiles.has(f));
  } else if (sinceMs !== null) {
    if (headOk) {
      const commits = listCommits(repoRoot, [`--since=${new Date(sinceMs).toISOString()}`, 'HEAD', ...(offBaseline ? [`^${baseline.base}`] : [])]);
      if (commits === null) return { ok: false, reason: 'git-rev-list-failed' };
      const kept = keepOwn(commits, null);
      if (!kept.ok) return kept;
      const files = commitFiles(repoRoot, kept.commits.map((c) => c.sha));
      if (files === null) return { ok: false, reason: 'git-diff-failed' };
      committed = files;
    }
    source = 'session-window-commits';
  } else {
    if (!baseline.ok) return { ok: false, reason: `no-session-base (${baseline.reason})` };
    const d = git(repoRoot, ['diff', '--name-status', '-z', '-M', baseline.range]);
    if (!d.ok) return { ok: false, reason: 'git-diff-failed' };
    committed = parseNameStatusZ(d.stdout);
    source = `baseline:${baseline.via}`;
    base = baseline.base;
    if (!offBaseline) partial = true;
  }
  const minus = offBaseline && !source.startsWith('baseline:') ? baseline.base : null;

  const wt = workingTreeFiles(repoRoot, sinceMs);
  if (wt === null) return { ok: false, reason: 'git-status-failed' };
  const files = [...new Set([...committed, ...wt.files])].sort();
  return { ok: true, files, preexisting: wt.preexisting.sort(), source, base, minus, partial, notes };
}

/**
 * Playwright configs in the repo (tracked or untracked, not ignored), so a
 * monorepo with `apps/web/playwright.config.ts` is reviewable. Configs inside
 * excluded directories (scaffolds under `templates/`, `node_modules/`,
 * fixtures …) do not count.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function findPlaywrightConfigs(repoRoot) {
  const r = git(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  if (!r.ok) return [];
  const isExcluded = defaultExcluder();
  return r.stdout.split('\0')
    .filter((p) => /(^|\/)playwright\.config\.(ts|js|mjs|cjs|mts)$/.test(p) && !p.includes('node_modules/') && !isExcluded(p))
    .sort();
}

/**
 * Pure: the UI paths a Playwright config can render — those inside the
 * directory of some config (a root config covers every path). A config in
 * `apps/admin` does not make a `packages/mobile` change renderable.
 *
 * @param {string[]} paths
 * @param {string[]} configs
 * @returns {string[]}
 */
export function renderablePaths(paths, configs) {
  const dirs = configs.map((c) => (c.includes('/') ? `${c.slice(0, c.lastIndexOf('/'))}/` : ''));
  return paths.filter((p) => dirs.some((d) => d === '' || p.startsWith(d)));
}
