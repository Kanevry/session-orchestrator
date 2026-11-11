/**
 * git-effect.mjs — the only sanctioned way to EXECUTE guard-probe cases (#1943).
 *
 * ## The incident this exists for
 *
 * On 2026-11-03 a guard-review agent fed an executing probe (`bash -c` per case
 * in a throw-away repo, cwd as the only protection) a replay corpus of 22,905
 * real fleet transcript commands. 662 ran before the probe was killed: GitLab
 * notes, owner-queue entries, branch switches in 11 real checkouts
 * (`cd <real path> && git switch …`), a remote gate job, a database read. A
 * working directory protects nothing: absolute paths, `cd`, `~`, `git -C` and
 * network CLIs all reach the real environment.
 *
 * ## The contract
 *
 * 1. Cases are TEMPLATES. The only path a template may name is `{D}` (the
 *    scratch repo, substituted here) or a relative path below the cwd.
 * 2. `vetCase` is an allowlist, fail-closed: every segment's first word must be
 *    `git` (with a local-only subcommand) or a harmless shell builtin. Anything
 *    it cannot parse is rejected. False rejects are the intended direction.
 * 3. `runCase` re-vets (defence in depth), runs `/bin/bash` with a FULLY
 *    REPLACED environment (`buildEnv`): HOME is the scratch dir, PATH holds a
 *    private bin dir with only a `git` link plus `/usr/bin:/bin`, git system and
 *    global config are off, nothing is inherited (no SSH agent, no tokens).
 * 4. A replay corpus carries `REPLAY_CORPUS_MARKER`; `assertNotReplayCorpus`
 *    refuses any input containing it. Read-only replay readers may keep using
 *    the corpus; executing probes never do.
 *
 * 5. The vetting is textual, so the kernel is the backstop: `runCase` runs every
 *    case under macOS `sandbox-exec` (`sandboxProfile`) — writes only below the
 *    scratch root, no reads under /Users, /Volumes or sibling temp dirs, no
 *    network, only bash/git executables — with
 *    `GIT_DIR`/`GIT_WORK_TREE` pinned and git's symlinks, hooks, fsmonitor,
 *    signing and transports switched off on the command-line config level.
 *
 * Ceiling (BV-004): macOS only — without `sandbox-exec` `runCase` throws
 * NO_SANDBOX (Linux CI runs the vetting tests, not the executing ones). Revisit
 * when a Linux or Windows host must execute probes (bwrap, or a Windows-path
 * vetting pass plus a sandbox there).
 */

import { spawnSync } from '../native-command.mjs';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Head marker every replay corpus file carries; an executing probe refuses such input. */
export const REPLAY_CORPUS_MARKER = 'SO-REPLAY-CORPUS: real fleet commands - read-only, never execute (#1943)';

/** Command words a case segment may start with. Shell builtins with no outside reach, plus `git`. */
export const ALLOWED_COMMANDS = Object.freeze(['git', 'echo', 'printf', 'true', 'false', 'test', '[', ':']);

/**
 * git subcommands that act on the local repository only. Everything that can
 * talk to a remote (clone/fetch/pull/push/remote/submodule/ls-remote/archive),
 * run a configured program (difftool/mergetool/bisect/filter-branch) or write
 * config is absent on purpose. `config` is allowed read-only (see vetGitArgs).
 */
export const ALLOWED_GIT_SUBCOMMANDS = Object.freeze([
  // `init` is absent: makeScratch() already made the repo, and a re-init with
  // `--separate-git-dir=<x>` moves the live config to a path the `.git` check
  // never sees (delta review, measured).
  'add', 'commit', 'status', 'log', 'diff', 'show', 'branch', 'switch', 'checkout',
  'restore', 'reset', 'rm', 'mv', 'stash', 'tag', 'merge', 'cherry-pick', 'revert',
  'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'cat-file', 'hash-object', 'update-index',
  'update-ref', 'symbolic-ref', 'for-each-ref', 'show-ref', 'check-ignore', 'check-attr',
  'clean', 'apply', 'describe', 'blame', 'reflog', 'notes', 'worktree', 'config',
  // `rebase` and `grep` are absent: git bundles short options and accepts long-option
  // prefixes, so `rebase -qx<cmd>` / `grep -nO<cmd>` / `--exe=` run any program and
  // no spelling list catches every form (W3 review, measured `rebase -qx"touch …"`).
]);

/** `git config` may only read: every argument must come from this set (or be the key after `--get`). */
const GIT_CONFIG_READ_ARGS = new Set(['--list', '-l', '--global', '--local', '--show-origin', '--show-scope', '--name-only']);

/**
 * Long options that run a program or retarget the repository. git accepts any
 * unambiguous PREFIX of a long option (`--exe=`, `--open-files=`), so an argument
 * is refused when it is a prefix (≥ 3 chars after `--`) of any of these.
 */
const GIT_FORBIDDEN_LONG = [
  'exec', 'open-files-in-pager', 'git-dir', 'work-tree', 'upload-pack', 'receive-pack',
  'ext-diff', 'textconv', 'filters', 'namespace', 'super-prefix', 'exec-path', 'config-env',
  'unsafe-paths', 'separate-git-dir', 'template',
];

/** git arguments that run a program or retarget the repository. */
const GIT_FORBIDDEN_ARGS = [
  { re: /^-C$/, reason: 'git -C retargets the repository' },
  { re: /^(-x|-O)/, reason: 'git -x/-O runs a program' },
];

/** @param {string} arg @returns {string | null} */
function forbiddenLongOption(arg) {
  const m = /^--([A-Za-z-]+)(=|$)/.exec(arg);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const hit = GIT_FORBIDDEN_LONG.find((opt) => opt === name || (name.length >= 3 && opt.startsWith(name)));
  return hit ? `git --${hit} (or a prefix of it) runs a program or retargets the repository` : null;
}

const MAX_TEMPLATE_LENGTH = 2000;
const MAX_CASES = 500;
const SCRATCH_PREFIX = 'so-git-effect-';
const D_SENTINEL = '\uE000';
const GIT_CANDIDATES = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'];

/** Input the caller supplied is unusable (exit 1 at the CLI). */
export class GitEffectInputError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'GitEffectInputError';
    this.code = code;
  }
}

/** The host cannot run the probe (exit 2 at the CLI). */
export class GitEffectSystemError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'GitEffectSystemError';
    this.code = code;
  }
}

const reject = (reason) => ({ ok: false, reason });

/**
 * Quote-aware lexer. `$`, backtick and backslash are rejected before this runs,
 * so double-quoted text is literal. Returns segments of words, or a reason.
 * @param {string} src template with `{D}` already replaced by D_SENTINEL
 * @returns {{ segments: Array<{ words: string[], redirects: string[] }> } | { reason: string }}
 */
function lex(src) {
  const segments = [];
  let words = [];
  let redirects = [];
  let word = null;
  let pendingRedirect = false;
  const endWord = () => {
    if (word === null) return;
    if (pendingRedirect) { redirects.push(word); pendingRedirect = false; } else words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (pendingRedirect) return 'redirection without a target';
    if (words.length > 0 || redirects.length > 0) segments.push({ words, redirects });
    words = [];
    redirects = [];
    return null;
  };
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const close = src.indexOf(ch, i + 1);
      if (close === -1) return { reason: 'unbalanced quote' };
      word = (word ?? '') + src.slice(i + 1, close);
      i = close;
    } else if (ch === ' ' || ch === '\t') {
      endWord();
    } else if (ch === ';' || ch === '\n' || ch === '|') {
      if (ch === '|' && src[i + 1] === '|') i += 1;
      const err = endSegment();
      if (err) return { reason: err };
    } else if (ch === '&') {
      if (src[i + 1] === '&') {
        i += 1;
        const err = endSegment();
        if (err) return { reason: err };
      } else if (src[i - 1] === '>' || src[i + 1] === '>') {
        return { reason: 'unsupported redirection form' };
      } else {
        return { reason: 'background job (&) is not allowed' };
      }
    } else if (ch === '>' || ch === '<') {
      if (src[i + 1] === '<' || src[i + 1] === '(' || src[i + 1] === '&') return { reason: 'heredoc, process substitution or fd duplication is not allowed' };
      if (word !== null && /^\d+$/.test(word)) word = null; // fd prefix like 2>
      endWord();
      if (pendingRedirect) return { reason: 'redirection without a target' };
      if (src[i + 1] === '>') i += 1;
      pendingRedirect = true;
    } else if (ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      return { reason: 'subshell, group or brace expansion is not allowed' };
    } else {
      word = (word ?? '') + ch;
    }
  }
  const err = endSegment();
  if (err) return { reason: err };
  return { segments };
}

/**
 * Whether one path component, read as a bash glob, can match `.git` (any case:
 * the macOS temp volume is case-insensitive). Over-approximates on purpose —
 * `*` alone counts although bash skips dotfiles — because runCase also turns
 * pathname expansion off (`bash -f`); this check is the textual layer before it.
 * @param {string} component
 * @returns {boolean}
 */
function globMatchesGitDir(component) {
  if (!/[*?[]/.test(component)) return false;
  let re = '';
  for (let i = 0; i < component.length; i += 1) {
    const ch = component[i];
    const close = ch === '[' ? component.indexOf(']', i + 2) : -1;
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else if (close !== -1) {
      // Any bracket expression may hold a g/i/t/. — treat it as one wildcard.
      re += '.';
      i = close;
    } else re += ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'is').test('.git');
}

/**
 * Path checks applied to every word and redirect target.
 * @param {string} token with `{D}` as D_SENTINEL
 * @returns {string | null} reason, or null when the token is safe
 */
function vetToken(token) {
  if (/(^|[^A-Za-z0-9._\-\uE000])\//.test(token)) return 'absolute path that is not {D}-rooted';
  if (/(^|[^A-Za-z0-9])[A-Za-z]:(\/|$)/.test(token)) return 'Windows drive path';
  if (/(^|[/=:\uE000])\.\.(\/|$)/.test(token)) return 'parent-directory (..) path';
  // Case-insensitive: the macOS temp volume is, so `.GIT/config` is `.git/config`.
  if (/(^|[/=:\uE000])\.git(\/|$)/i.test(token)) return 'path into .git (config, hooks) is not allowed';
  if (token.split(/[/=:\uE000]/).some(globMatchesGitDir)) return 'glob that can match .git is not allowed';
  if (/:\/\/|^[A-Za-z0-9._-]+@[^\s]+:/.test(token)) return 'URL or scp-style remote';
  if (/^(GIT_DIR|GIT_WORK_TREE)=/.test(token)) return 'GIT_DIR/GIT_WORK_TREE assignment';
  return null;
}

/**
 * @param {string[]} args git arguments after the word `git`
 * @returns {string | null}
 */
function vetGitArgs(args) {
  for (const arg of args) {
    const hit = GIT_FORBIDDEN_ARGS.find((f) => f.re.test(arg));
    if (hit) return hit.reason;
    const long = forbiddenLongOption(arg);
    if (long) return long;
  }
  const sub = args[0];
  if (sub === undefined) return 'git without a subcommand';
  if (sub.startsWith('-')) return 'git global options (-c, --config-env, --exec-path, …) are not allowed';
  if (!ALLOWED_GIT_SUBCOMMANDS.includes(sub)) return `git ${sub} is not a local-only subcommand`;
  if (sub === 'config') {
    const rest = args.slice(1);
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--get' && /^[A-Za-z0-9.-]+$/.test(rest[i + 1] ?? '')) { i += 1; continue; }
      if (!GIT_CONFIG_READ_ARGS.has(rest[i])) return 'git config may only read (--list / --get <key>)';
    }
  }
  return null;
}

/**
 * Vet one case template, fail-closed.
 * @param {unknown} template case text; the only allowed path root is `{D}`
 * @param {{ scratch?: string }} [opts] when given, `command` is the template with `{D}` substituted
 * @returns {{ ok: true, command: string | null } | { ok: false, reason: string }}
 */
export function vetCase(template, { scratch } = {}) {
  if (typeof template !== 'string' || template.trim() === '') return reject('case is not a non-empty string');
  if (template.length > MAX_TEMPLATE_LENGTH) return reject('case is too long');
  if (/[\0\r\uE000]/u.test(template)) return reject('control or sentinel character in case');
  // Printable ASCII only: HFS+ ignores some Unicode code points in names, which
  // would let `.g\u200Cit` reach `.git` past the textual check.
  if (/[^\x20-\x7E\n\t]/.test(template)) return reject('non-ASCII or control character in case');
  if (/[$`]/.test(template)) return reject('$-expansion or command substitution is not allowed');
  if (template.includes('\\')) return reject('backslash (escape or Windows path) is not allowed');
  if (template.includes('~')) return reject('~ (home directory) is not allowed');
  if (template.includes('!')) return reject('! (git alias shell or history) is not allowed');
  const lexed = lex(template.split('{D}').join(D_SENTINEL));
  if ('reason' in lexed) return reject(lexed.reason);
  if (lexed.segments.length === 0) return reject('case has no command');
  for (const { words, redirects } of lexed.segments) {
    for (const token of [...words, ...redirects]) {
      const reason = vetToken(token);
      if (reason) return reject(reason);
    }
    const [cmd, ...args] = words;
    if (cmd === undefined) return reject('redirection without a command');
    if (cmd === 'cd' || cmd === 'pushd' || cmd === 'popd') return reject(`${cmd} leaves the scratch repo`);
    if (!ALLOWED_COMMANDS.includes(cmd)) return reject(`command "${cmd}" is not on the allowlist`);
    if (cmd === 'git') {
      const reason = vetGitArgs(args);
      if (reason) return reject(reason);
    }
  }
  if (scratch === undefined) return { ok: true, command: null };
  if (!isSafeScratchPath(scratch)) return reject('scratch is not a safe absolute path');
  return { ok: true, command: template.split('{D}').join(scratch) };
}

/** @param {unknown} p */
function isSafeScratchPath(p) {
  return typeof p === 'string' && path.isAbsolute(p) && /^[A-Za-z0-9_./-]+$/.test(p) && !p.split('/').includes('..');
}

/**
 * Parse a cases file and refuse a replay corpus.
 * @param {string | Buffer} input file content
 * @returns {string[]} the case templates (not yet vetted)
 * @throws {GitEffectInputError} code REPLAY_CORPUS | NOT_JSON | BAD_SHAPE | TOO_MANY
 */
export function assertNotReplayCorpus(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  // Stricter than a head-only check: the marker anywhere refuses the file.
  if (text.includes(REPLAY_CORPUS_MARKER)) {
    throw new GitEffectInputError('input is a replay corpus (real fleet commands); an executing probe never takes it', 'REPLAY_CORPUS');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new GitEffectInputError('cases file is not JSON', 'NOT_JSON');
  }
  const cases = Array.isArray(data) ? data : data?.cases;
  if (!Array.isArray(cases) || !cases.every((c) => typeof c === 'string')) {
    throw new GitEffectInputError('cases file must be a JSON array of strings or { "cases": [strings] }', 'BAD_SHAPE');
  }
  if (cases.length > MAX_CASES) throw new GitEffectInputError(`more than ${MAX_CASES} cases`, 'TOO_MANY');
  return cases;
}

let gitPathCache = null;

/**
 * Resolve git once from fixed absolute locations — never from the inherited PATH.
 * @returns {string}
 * @throws {GitEffectSystemError}
 */
export function resolveGit() {
  if (gitPathCache) return gitPathCache;
  const found = GIT_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new GitEffectSystemError('git not found at a fixed absolute location', 'NO_GIT');
  gitPathCache = found;
  return found;
}

/**
 * The complete environment of an executed case. Pure: nothing from process.env.
 * @param {string} scratch the scratch repo; its parent holds the private `bin/`
 * @returns {Record<string, string>}
 */
export function buildEnv(scratch) {
  const root = path.dirname(scratch);
  return {
    HOME: scratch,
    PATH: `${path.join(root, 'bin')}:/usr/bin:/bin`,
    GIT_CEILING_DIRECTORIES: root,
    // Pinned: no case can point git at another repository or work tree.
    GIT_DIR: path.join(scratch, '.git'),
    GIT_WORK_TREE: scratch,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true', // an editor-opening case aborts instead of hanging until the timeout
    LC_ALL: 'C',
    // Command-line-level config (highest precedence, never from the template).
    // core.symlinks=false: the token checks are textual, so a case that commits a
    // mode-120000 entry (hash-object + update-index --cacheinfo) and checks it out
    // would otherwise plant a link a later redirect writes through, out of scratch.
    // The other keys close hooks, fsmonitor and any transport git might reach.
    GIT_CONFIG_COUNT: '7',
    GIT_CONFIG_KEY_0: 'core.symlinks',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'core.hooksPath',
    GIT_CONFIG_VALUE_1: '/dev/null',
    GIT_CONFIG_KEY_2: 'core.fsmonitor',
    GIT_CONFIG_VALUE_2: 'false',
    GIT_CONFIG_KEY_3: 'protocol.allow',
    GIT_CONFIG_VALUE_3: 'never',
    // `commit -S` / `tag -s` / `log --show-signature` would start a signing program.
    GIT_CONFIG_KEY_4: 'gpg.program',
    GIT_CONFIG_VALUE_4: 'false',
    GIT_CONFIG_KEY_5: 'gpg.ssh.program',
    GIT_CONFIG_VALUE_5: 'false',
    GIT_CONFIG_KEY_6: 'gpg.x509.program',
    GIT_CONFIG_VALUE_6: 'false',
  };
}

function assertPosix() {
  if (process.platform === 'win32') throw new GitEffectSystemError('git-effect probe is POSIX-only', 'UNSUPPORTED_PLATFORM');
}

/**
 * @param {string} scratch
 * @returns {boolean} true when scratch is `<tmpdir>/so-git-effect-*\/repo` with a .git
 */
function isOwnScratch(scratch) {
  if (!isSafeScratchPath(scratch) || path.basename(scratch) !== 'repo') return false;
  try {
    const tmp = realpathSync(os.tmpdir());
    const real = realpathSync(scratch);
    return real === scratch && path.dirname(path.dirname(real)) === tmp
      && path.basename(path.dirname(real)).startsWith(SCRATCH_PREFIX) && existsSync(path.join(real, '.git'));
  } catch {
    return false;
  }
}

/**
 * Create `<tmpdir>/so-git-effect-XXXX/{repo,bin}`: repo is a fresh git repo with
 * one commit, bin holds only a `git` link.
 * @returns {{ scratch: string, cleanup: () => void }}
 */
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const APPLE_GIT_SHIM = '/usr/bin/git';
/** Fixed environment of the unsandboxed host-tool queries below: no inherited config or credentials. */
const DISCOVERY_ENV = Object.freeze({
  HOME: '/dev/null', PATH: '/usr/bin:/bin', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
});
const sandboxHostCache = new Map();
const gitRuntimeCache = new Map();

/**
 * The git binary that actually runs for a GIT_CANDIDATES entry (#1949 review).
 * Apple's /usr/bin/git is an xcrun shim whose cache lookup depends on HOME: run
 * inside the sandbox with the case's HOME it misses, starts xcodebuild under a
 * full Xcode.app and exits 71. So the shim is resolved here, outside the
 * sandbox, to the developer git `xcrun --find git` names, and that binary runs
 * the case. Every other candidate (and every non-macOS host) is itself.
 * @param {string} git a GIT_CANDIDATES entry
 * @returns {string}
 */
export function gitRuntime(git) {
  if (process.platform !== 'darwin' || git !== APPLE_GIT_SHIM) return git;
  if (!gitRuntimeCache.has(git)) gitRuntimeCache.set(git, discoverPath('/usr/bin/xcrun', ['--find', 'git']));
  return gitRuntimeCache.get(git);
}

/**
 * Ask a fixed-path host tool for one absolute path.
 * @param {string} file @param {string[]} args
 * @returns {string} the realpath of the tool's single-line answer
 */
function discoverPath(file, args) {
  const result = spawnSync(file, args, { cwd: '/', env: DISCOVERY_ENV, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = result.stdout?.trim() ?? '';
  if (result.status !== 0 || !path.isAbsolute(output)) {
    throw new GitEffectSystemError('cannot discover trusted git sandbox paths', 'SANDBOX_SETUP');
  }
  return realpathSync(output);
}

/**
 * The host facts sandboxProfile() needs, discovered OUTSIDE the sandbox before
 * any case runs: the programs the selected git may start and the user's temp and
 * cache dirs (confstr, also when TMPDIR points elsewhere).
 * @param {string} git a GIT_CANDIDATES entry
 * @returns {{ programs: string[], userDirs: string[] }}
 */
function sandboxHost(git) {
  if (sandboxHostCache.has(git)) return sandboxHostCache.get(git);
  if (!GIT_CANDIDATES.includes(git)) throw new GitEffectSystemError('git is not at a fixed absolute location', 'NO_GIT');
  try {
    const runtime = gitRuntime(git);
    const executable = realpathSync(runtime);
    const userDirs = [
      discoverPath('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR']),
      discoverPath('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR']),
    ];
    // git runs its own subcommands (gc → repack, stash → update-index) by exec'ing
    // `git` with the exec path first on PATH: `<exec-path>/git` is that program (a
    // hardlink in a plain `make install`, a symlink onto the main binary in Apple's
    // build). The rest of the exec path stays shut: it holds the real helpers —
    // git-credential-osxkeychain, git-remote-http, git-imap-send, git-daemon — and
    // shell/perl scripts, none of which an allowed subcommand starts.
    // For the Apple shim this is the one developer git, not the developer tree
    // (which also holds clang, python3 and make), and not the shim itself.
    const programs = [realpathSync('/bin/bash'), executable, path.join(discoverPath(runtime, ['--exec-path']), 'git')];
    const host = { programs, userDirs };
    sandboxHostCache.set(git, host);
    return host;
  } catch (error) {
    if (error instanceof GitEffectSystemError) throw error;
    throw new GitEffectSystemError('cannot resolve trusted git sandbox paths', 'SANDBOX_SETUP');
  }
}

/**
 * The OS backstop behind the textual vetting (W3 reviews found four routes past
 * it in two cycles: case-built symlinks, option bundles, `.GIT`, re-init with a
 * moved git dir). Whatever a vetted case makes git do, the kernel lets it write
 * only below the scratch root, read nothing elsewhere under /Users, /Volumes or
 * the user's temp directory (no keys or tokens into the probe's output, SEC-008),
 * open no network socket and execute only bash and the selected git runtime.
 * @param {string} root the makeScratch() root (realpath, safe characters only)
 * @param {string} [git] selected fixed-path git installation, defaults to resolveGit()
 * @returns {string} a sandbox-exec SBPL profile
 */
export function sandboxProfile(root, git = resolveGit()) {
  if (!isSafeScratchPath(root)) throw new GitEffectSystemError('scratch root is not a safe absolute path', 'FOREIGN_SCRATCH');
  const host = sandboxHost(git);
  const literals = (paths) => paths.map((p) => `(literal ${JSON.stringify(p)})`).join(' ');
  // The kernel matches resolved paths, so only realpaths can ever match here.
  const readRoots = new Set(['/Users', '/Volumes', realpathSync(os.tmpdir()), ...host.userDirs]);
  const ancestors = [];
  for (let dir = path.dirname(root); dir !== '/'; dir = path.dirname(dir)) ancestors.push(dir);
  return [
    '(version 1)',
    '(allow default)',
    '(deny process-exec*)',
    `(allow process-exec* ${literals(host.programs)})`,
    '(deny network*)',
    `(deny file-read* (require-all (require-any ${[...readRoots].map((dir) => `(subpath ${JSON.stringify(dir)})`).join(' ')}) (require-not (subpath "${root}"))))`,
    // git resolves its repo path component by component (lstat); without this every
    // git call exits 128 with "fatal: Invalid path '/Users': Operation not permitted".
    // Metadata only: listing or reading a sibling of the scratch root stays denied.
    `(allow file-read-metadata ${literals(ancestors)})`,
    `(deny file-write* (require-not (require-any (subpath "${root}") (literal "/dev/null"))))`,
  ].join('');
}

/**
 * The one spawn shape for everything that runs after a case was admitted.
 * @param {string} root makeScratch() root
 * @param {string[]} argv program and arguments
 * @returns {[string, string[]]} `[file, args]` for spawnSync
 */
function sandboxed(root, argv) {
  return [SANDBOX_EXEC, ['-p', sandboxProfile(root, resolveGit()), ...argv]];
}

export function makeScratch() {
  assertPosix();
  const git = gitRuntime(resolveGit());
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), SCRATCH_PREFIX)));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    // Resolve/cache runtime permissions before a case can modify its scratch repo.
    if (process.platform === 'darwin') sandboxHost(resolveGit());
    const scratch = path.join(root, 'repo');
    mkdirSync(scratch);
    mkdirSync(path.join(root, 'bin'));
    symlinkSync(git, path.join(root, 'bin', 'git'));
    writeFileSync(path.join(scratch, 'README'), 'scratch\n');
    const env = buildEnv(scratch);
    const steps = [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.name', 'probe'],
      ['config', 'user.email', 'probe@example.org'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', 'README'],
      ['commit', '-q', '-m', 'init'],
    ];
    for (const args of steps) {
      const r = spawnSync(git, args, { cwd: scratch, env, encoding: 'utf8' });
      if (r.status !== 0) throw new GitEffectSystemError(`scratch setup failed at git ${args[0]}`, 'SCRATCH_SETUP');
    }
    return { scratch, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Run one vetted command in its scratch repo.
 * @param {string} command the `{D}`-substituted command from `vetCase`
 * @param {{ scratch: string, timeoutMs?: number }} opts
 * @returns {{ exitCode: number | null, signal: string | null, stdout: string, stderr: string, gitStatusAfter: string }}
 * @throws {GitEffectInputError} code UNVETTED when the command does not re-vet
 * @throws {GitEffectSystemError} on a foreign scratch dir or unsupported platform
 */
export function runCase(command, { scratch, timeoutMs = 10_000 } = {}) {
  assertPosix();
  if (!isOwnScratch(scratch)) throw new GitEffectSystemError('scratch is not a makeScratch() directory', 'FOREIGN_SCRATCH');
  const template = typeof command === 'string' ? command.split(scratch).join('{D}') : command;
  const vetted = vetCase(template, { scratch });
  if (!vetted.ok || vetted.command !== command) {
    throw new GitEffectInputError(`refusing un-vetted command: ${vetted.ok ? 'substitution mismatch' : vetted.reason}`, 'UNVETTED');
  }
  if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) {
    throw new GitEffectSystemError('no OS sandbox (macOS sandbox-exec) on this host; an executing probe never runs unsandboxed', 'NO_SANDBOX');
  }
  const env = buildEnv(scratch);
  const root = path.dirname(scratch);
  // -f (noglob): the vetting reads words textually, so bash must not turn
  // `.[g]it/config` into `.git/config` after it (!343 review).
  const r = spawnSync(...sandboxed(root, ['/bin/bash', '--noprofile', '--norc', '-f', '-c', command]), {
    cwd: scratch, env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Sandboxed too: the case could write under root/.git, and a status reads
  // .gitattributes/config — whatever that makes git start stays inside.
  const st = spawnSync(...sandboxed(root, [gitRuntime(resolveGit()), 'status', '--porcelain=v1', '-b']), {
    cwd: scratch, env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
  });
  return {
    exitCode: r.status,
    signal: r.signal,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    gitStatusAfter: st.status === 0 ? st.stdout : '',
  };
}
