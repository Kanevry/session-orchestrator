/**
 * agent-setup.mjs — `/security agent-setup`: what steers an AI coding agent here (#2204).
 *
 * A read-only inventory of the repo and host surfaces that configure Claude Code
 * (instruction files, settings, hooks, MCP servers, plugins, skills) plus six
 * finding classes (Epic #2200):
 *   endpoint-override · fetch-and-execute · approval-off · wildcard-allow ·
 *   token-in-allowlist · hidden-unicode
 * plus `surface-unread`: a settings / MCP / Codex config file or an instruction
 * file that exists but was not read (symlink, size cap, parse or read error) —
 * never an `ok` result. An instruction-file symlink whose real target stays inside
 * the repo is followed once; one that leaves the repo is never followed.
 *
 * Privacy: a finding carries file, key name / key path / index and the class —
 * never a value of an env entry, an allowlist entry, a hook command, a header or
 * a URL (for a URL only the scheme and whether the host is loopback), and never
 * another project's path from `~/.claude.json`.
 * Reads the working tree and the home of `env.HOME` (else `env.USERPROFILE`)
 * only; every file behind `lstat`, a size cap and a guarded `JSON.parse`.
 * Contract: ./contract.mjs.
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { isDangerousInvisibleCodePoint, isOrphanVariationSelector } from '../validate/check-unicode-safety.mjs';
import { TOKEN_SHAPES } from '../validate/token-shapes.mjs';
import { makeResult } from './contract.mjs';

/**
 * The key lists of classes 1, 3 and 4 (PRD § 2). A key not in this table is not a finding.
 */
const KEY_TABLE = Object.freeze({
  /** class 1 — `env` keys that redirect the agent's traffic (plus any key ending in `suffix`). */
  'endpoint-override': { keys: ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY'], suffix: '_BASE_URL' },
  /** class 3 — settings values that switch an approval off (MCP `autoApprove` is checked per server). */
  'approval-off': [
    { path: ['enableAllProjectMcpServers'], value: true },
    { path: ['skipDangerousModePermissionPrompt'], value: true },
    { path: ['permissions', 'defaultMode'], value: 'bypassPermissions' },
  ],
  /** class 4 — permission allow entries that grant everything of a tool family. */
  'wildcard-allow': ['*', 'Bash', 'Bash(*)', 'Bash(:*)', 'mcp__*'],
});

/** NAMED CEILING (BV-004): 4 MiB per file, as security-pulse/cache.mjs. `~/.claude.json` measured ~0.6 MiB (2026-11-21); revisit if it reaches the cap. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

/** NAMED CEILING (BV-004): files read under `.cursor/rules`. Revisit if a real repo ships more rule files. */
const MAX_RULE_FILES = 500;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const errClass = (err) => err?.code ?? err?.name ?? 'unreadable';

/**
 * Read one file behind lstat + size cap. Never throws.
 * @returns {{state: 'absent'} | {state: 'ok', text: string} | {state: 'fail', reason: string}}
 */
function readGuarded(abs) {
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { state: 'absent' };
    return { state: 'fail', reason: `unreadable (${errClass(err)})` };
  }
  if (st.isSymbolicLink()) return { state: 'fail', reason: 'is a symlink; only skill directories are followed' };
  if (!st.isFile()) return { state: 'fail', reason: 'not a regular file' };
  if (st.size > MAX_READ_BYTES) return { state: 'fail', reason: `larger than ${MAX_READ_BYTES} bytes` };
  try {
    return { state: 'ok', text: readFileSync(abs, 'utf8') };
  } catch (err) {
    return { state: 'fail', reason: `unreadable (${errClass(err)})` };
  }
}

/** readGuarded + JSON.parse to an object; a parse error reports its class only (its message quotes content). */
function readJson(abs) {
  const r = readGuarded(abs);
  if (r.state !== 'ok') return r;
  try {
    const value = JSON.parse(r.text);
    if (!isObj(value)) return { state: 'fail', reason: 'top level is not a JSON object' };
    return { state: 'ok', value };
  } catch (err) {
    return { state: 'fail', reason: `JSON not parsable (${err?.name ?? 'Error'})` };
  }
}

const isDir = (abs) => {
  try {
    return lstatSync(abs).isDirectory();
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

const finding = (cls, file, key, detail, extra = {}) => ({ id: `${cls}:${file}:${key}`, class: cls, state: 'measured', detail, file, key, ...extra });

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
/** `[::ffff:127.a.b.c]` after WHATWG normalisation: `[::ffff:7fXX:XXXX]`. */
const LOOPBACK_V4_MAPPED = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/;

/** class 1 — scheme + loopback only; null when the value is not a URL. */
function urlShape(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  // A scheme-less proxy value (`host:port`) would parse with `host:` as its scheme.
  const candidate = text.includes('://') ? text : `http://${text}`;
  try {
    const url = new URL(candidate);
    if (url.hostname === '') return null;
    const host = url.hostname;
    const loopback = host === 'localhost' || host === 'localhost.' || host === '[::1]' || LOOPBACK_V4.test(host) || LOOPBACK_V4_MAPPED.test(host);
    return { scheme: url.protocol, loopback };
  } catch {
    return null; // the error message would carry the value
  }
}

function endpointOverrides(env, file) {
  if (!isObj(env)) return [];
  const { keys, suffix } = KEY_TABLE['endpoint-override'];
  const out = [];
  for (const [key, value] of Object.entries(env)) {
    if (!keys.includes(key) && !key.endsWith(suffix)) continue;
    if (typeof value === 'string' && value.trim() === '') continue; // empty value overrides nothing
    const shape = urlShape(value);
    const k = `env.${key}`;
    if (shape === null) out.push(finding('endpoint-override', file, k, `env ${key}: value is not a URL`));
    else if (!shape.loopback) out.push(finding('endpoint-override', file, k, `env ${key} sends agent traffic to a non-loopback host (${shape.scheme})`, { scheme: shape.scheme, loopback: false }));
  }
  return out;
}

// class 2 building blocks. A command word is not preceded or followed by `[\w./-]`
// (so `curl-check.mjs` and `my-curl` are not `curl`); a command may carry a path
// prefix (`/usr/bin/curl`, `./curl`, `/bin/sh`, `/usr/bin/env`).
const WORD_EDGE = '[\\w./-]';
const PATH_PREFIX = '(?:(?:/[\\w.-]+)*/)?';
const FETCH = `(?<!${WORD_EDGE})(?:[\\w.~-]*/)*(?:curl|wget)(?:\\.exe)?(?!${WORD_EDGE})`;
const FETCH_RE = new RegExp(FETCH);
const TEE_STAGE = new RegExp(`^\\s*${PATH_PREFIX}tee(?!${WORD_EDGE})`);
const SUDO = `(?:${PATH_PREFIX}sudo(?:\\s+-{1,2}[\\w-]+)*\\s+)?`;
const ENV = `(?:${PATH_PREFIX}env(?:\\s+-{1,2}[\\w-]+)*\\s+)?`;
const INTERPRETER_STAGE = new RegExp(`^\\s*${SUDO}${ENV}${PATH_PREFIX}(?:sh|bash|zsh|node|python3?)(?!${WORD_EDGE})`);
const BACKTICK = String.fromCharCode(96);
const EVAL_OF_DOWNLOAD = new RegExp(`\\beval\\s+["']?(?:\\$\\(|${BACKTICK})\\s*${FETCH}`);

/**
 * NAMED CEILING (BV-004): hook commands longer than this are not scanned; such a
 * command becomes a not-measurable class-2 finding. The scan itself is linear
 * (stage walk below); the cap is a backstop. Revisit if a real hook command reaches it.
 */
const MAX_HOOK_COMMAND_CHARS = 16 * 1024;

/**
 * Pipeline walk: split on `;`, `&`, newline and `||` into lists, then on `|` into
 * stages. A stage containing curl/wget arms the walk, `tee` stages keep it armed,
 * and an interpreter stage (optional sudo/env, optional path) right after is a hit.
 * Each stage is tested once, so the cost is linear in the command length.
 */
function pipesDownloadIntoInterpreter(cmd) {
  for (const list of cmd.split(/\|\||[;&\n]/)) {
    let armed = false;
    for (const stage of list.split('|')) {
      if (armed && INTERPRETER_STAGE.test(stage)) return true;
      if (!(armed && TEE_STAGE.test(stage))) armed = FETCH_RE.test(stage);
    }
  }
  return false;
}

/** class 2 — narrow pattern check on the command string, not a shell parser. */
const isFetchAndExecute = (cmd) => typeof cmd === 'string' && (pipesDownloadIntoInterpreter(cmd) || EVAL_OF_DOWNLOAD.test(cmd));

/** Hook inventory + class 2. Counts events (`jq '.hooks | length'`) and command entries. */
function hookScan(hooks, file) {
  const out = { events: 0, commands: 0, findings: [] };
  if (!isObj(hooks)) return out;
  for (const [event, groups] of Object.entries(hooks)) {
    out.events += 1;
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, gi) => {
      const list = isObj(group) && Array.isArray(group.hooks) ? group.hooks : [];
      list.forEach((hook, hi) => {
        out.commands += 1;
        const key = `hooks.${event}[${gi}].hooks[${hi}]`;
        if (isObj(hook) && typeof hook.command === 'string' && hook.command.length > MAX_HOOK_COMMAND_CHARS) {
          out.findings.push(finding('fetch-and-execute', file, key, `hook ${event}[${gi}][${hi}] was not scanned for fetch-and-execute`,
            { state: 'not-measurable', reason: `hook command longer than ${MAX_HOOK_COMMAND_CHARS} characters` }));
        } else if (isObj(hook) && isFetchAndExecute(hook.command)) {
          out.findings.push(finding('fetch-and-execute', file, key,
            `hook ${event}[${gi}][${hi}] pipes a curl/wget download into an interpreter or eval (narrow pattern check on the command string)`));
        }
      });
    });
  }
  return out;
}

/** MCP server inventory + class 3 (`autoApprove`). */
function mcpScan(servers, file, prefix) {
  if (!isObj(servers)) return { count: 0, findings: [] };
  const findings = [];
  for (const [name, server] of Object.entries(servers)) {
    if (isObj(server) && Array.isArray(server.autoApprove) && server.autoApprove.length > 0) {
      findings.push(finding('approval-off', file, `${prefix}.${name}.autoApprove`, `MCP server ${name} auto-approves ${server.autoApprove.length} tool(s)`));
    }
  }
  return { count: Object.keys(servers).length, findings };
}

/** classes 3, 4, 5 on a settings object. */
function settingsFindings(value, file) {
  const out = [];
  for (const { path: keyPath, value: bad } of KEY_TABLE['approval-off']) {
    let v = value;
    for (const k of keyPath) v = isObj(v) ? v[k] : undefined;
    if (v === bad) out.push(finding('approval-off', file, keyPath.join('.'), `${keyPath.join('.')} switches an approval prompt off`));
  }
  const allow = isObj(value.permissions) && Array.isArray(value.permissions.allow) ? value.permissions.allow : [];
  allow.forEach((entry, i) => {
    if (typeof entry !== 'string') return;
    const key = `permissions.allow[${i}]`;
    if (KEY_TABLE['wildcard-allow'].includes(entry.trim())) {
      out.push(finding('wildcard-allow', file, key, `allow entry ${i} grants a whole tool family without a scope`, { index: i }));
    }
    for (const shape of TOKEN_SHAPES) {
      if (shape.regex.test(entry)) {
        out.push(finding('token-in-allowlist', file, `${key}:${shape.id}`, `allow entry ${i} contains a token of shape ${shape.id}; reference an env variable instead (SEC-025)`, { index: i, pattern: shape.id }));
      }
    }
  });
  return out;
}

/** class 6 — dangerous invisible code points, per line, via check-unicode-safety's detector. */
function hiddenUnicode(text, file) {
  const byLine = new Map();
  let line = 1;
  let prevChar = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0x0a) line += 1;
    else if (isDangerousInvisibleCodePoint(cp) || isOrphanVariationSelector(cp, prevChar)) {
      const set = byLine.get(line) ?? new Set();
      set.add(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
      byLine.set(line, set);
    }
    prevChar = ch;
  }
  return [...byLine].map(([ln, set]) => finding('hidden-unicode', file, `line ${ln}`,
    `line ${ln} contains invisible code point(s) ${[...set].join(', ')}`, { line: ln, codePoints: [...set] }));
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

const notMeasurable = (id, check, detail, reason, file) => ({ id, check, state: 'not-measurable', detail, reason, ...(file ? { file } : {}) });
const judged = (base, findings, detail, extra) => ({ ...base, state: findings.length > 0 ? 'fail' : 'pass', detail, ...extra });

/**
 * A surface that EXISTS but was not read could carry any class (Claude Code itself
 * follows a symlinked settings file), so it is a finding, not only a check row.
 * `reason` is the reason class from readGuarded/readJson — never content.
 */
function unreadSurface(id, check, file, reason, acc) {
  acc.findings.push(finding('surface-unread', file, 'file', `${file} exists but was not read; its settings are not judged`,
    { state: 'not-measurable', reason }));
  return notMeasurable(id, check, `${file} not read`, reason, file);
}

function settingsSurface(id, check, abs, file, acc) {
  const r = readJson(abs);
  if (r.state === 'fail') return unreadSurface(id, check, file, r.reason, acc);
  if (r.state === 'absent') return { id, check, state: 'pass', detail: `${file} absent`, file, present: false, hookEvents: 0, hooks: 0, mcpServers: 0 };
  const v = r.value;
  const hooks = hookScan(v.hooks, file);
  const mcp = mcpScan(v.mcpServers, file, 'mcpServers');
  const findings = [...endpointOverrides(v.env, file), ...hooks.findings, ...settingsFindings(v, file), ...mcp.findings];
  const allow = isObj(v.permissions) && Array.isArray(v.permissions.allow) ? v.permissions.allow.length : 0;
  const marketplaces = isObj(v.extraKnownMarketplaces) ? Object.keys(v.extraKnownMarketplaces).length : 0;
  const envKeys = isObj(v.env) ? Object.keys(v.env).length : 0;
  acc.findings.push(...findings);
  acc.hooks += hooks.commands;
  acc.hookEvents += hooks.events;
  acc.mcp += mcp.count;
  return judged({ id, check, file }, findings,
    `${hooks.commands} hook command(s) on ${hooks.events} event(s), ${mcp.count} MCP server(s), ${allow} allow entr(ies), ${envKeys} env key(s), ${marketplaces} extra marketplace(s); ${findings.length} finding(s)`,
    { present: true, hookEvents: hooks.events, hooks: hooks.commands, mcpServers: mcp.count, allowEntries: allow, envKeys, extraMarketplaces: marketplaces });
}

function mcpJsonSurface(abs, file, acc) {
  const id = 'repo-mcp';
  const check = 'repo .mcp.json';
  const r = readJson(abs);
  if (r.state === 'fail') return unreadSurface(id, check, file, r.reason, acc);
  if (r.state === 'absent') return { id, check, state: 'pass', detail: `${file} absent`, file, present: false, mcpServers: 0 };
  const mcp = mcpScan(r.value.mcpServers, file, 'mcpServers');
  acc.findings.push(...mcp.findings);
  acc.mcp += mcp.count;
  return judged({ id, check, file }, mcp.findings, `${mcp.count} MCP server(s); ${mcp.findings.length} finding(s)`, { present: true, mcpServers: mcp.count });
}

/**
 * `~/.claude.json`: only the top-level `mcpServers` and `projects[<this repo>].mcpServers`
 * are read — other projects' entries are neither read nor named (their keys are paths).
 */
function claudeJsonSurface(abs, file, repoRoot, acc) {
  const id = 'host-claude-json';
  const check = 'host ~/.claude.json MCP servers';
  const r = readJson(abs);
  if (r.state === 'fail') return unreadSurface(id, check, file, r.reason, acc);
  if (r.state === 'absent') return { id, check, state: 'pass', detail: `${file} absent`, file, present: false, mcpServers: 0, thisProjectMcpServers: 0 };
  const top = mcpScan(r.value.mcpServers, file, 'mcpServers');
  const projects = isObj(r.value.projects) ? r.value.projects : {};
  let real = null;
  try {
    real = realpathSync(repoRoot);
  } catch {
    // an unresolvable repo root only loses the realpath key
  }
  const key = [path.resolve(repoRoot), real].find((k) => k !== null && Object.hasOwn(projects, k));
  const mine = key === undefined ? { count: 0, findings: [] } : mcpScan(isObj(projects[key]) ? projects[key].mcpServers : null, file, 'projects[<this repo>].mcpServers');
  const findings = [...top.findings, ...mine.findings];
  acc.findings.push(...findings);
  acc.mcp += top.count;
  acc.mcpThisProject += mine.count;
  return judged({ id, check, file }, findings, `${top.count} user MCP server(s), ${mine.count} MCP server(s) under projects[<this repo>]; ${findings.length} finding(s)`,
    { present: true, mcpServers: top.count, thisProjectMcpServers: mine.count });
}

/** `installed_plugins.json`: `{ version, plugins: { <name>: [install, …] } }` — plugins = keys of `plugins`. */
function pluginsSurface(abs, file, acc) {
  const id = 'host-plugins';
  const check = 'host installed plugins';
  const r = readJson(abs);
  if (r.state === 'fail') return notMeasurable(id, check, `${file} not read`, r.reason, file);
  if (r.state === 'absent') return { id, check, state: 'pass', detail: `${file} absent`, file, present: false, plugins: 0 };
  if (!isObj(r.value.plugins)) return notMeasurable(id, check, `${file} not read`, 'no "plugins" object in the file', file);
  const plugins = Object.keys(r.value.plugins).length;
  acc.plugins += plugins;
  return { id, check, state: 'pass', detail: `${plugins} plugin(s) installed`, file, present: true, plugins };
}

/** Skill directories; a symlink is followed exactly one level and its real path reported. */
function skillsSurface(id, check, absDir, file, display, acc) {
  let names;
  try {
    names = readdirSync(absDir).filter((n) => !n.startsWith('.')).sort();
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { id, check, state: 'pass', detail: `${file} absent`, file, present: false, skills: 0 };
    return notMeasurable(id, check, `${file} not listed`, `unreadable (${errClass(err)})`, file);
  }
  let skills = 0;
  const links = [];
  const unresolved = [];
  for (const name of names) {
    const abs = path.join(absDir, name);
    let st;
    try {
      st = lstatSync(abs);
    } catch (err) {
      unresolved.push({ name, reason: `unreadable (${errClass(err)})` });
      continue;
    }
    if (st.isDirectory()) {
      skills += 1;
    } else if (st.isSymbolicLink()) {
      let target;
      try {
        target = path.resolve(absDir, readlinkSync(abs));
      } catch (err) {
        unresolved.push({ name, reason: `link unreadable (${errClass(err)})` });
        continue;
      }
      let tst;
      try {
        tst = lstatSync(target);
      } catch {
        unresolved.push({ name, reason: 'dangling symlink' });
        continue;
      }
      if (tst.isSymbolicLink()) unresolved.push({ name, reason: 'symlink to a symlink; followed one level only' });
      else if (tst.isDirectory()) {
        skills += 1;
        links.push({ name, realPath: display(target) });
      }
    }
  }
  acc.skills += skills;
  acc.notMeasurable += unresolved.length;
  const tail = unresolved.length > 0 ? `; ${unresolved.length} entr(ies) not measurable (${[...new Set(unresolved.map((u) => u.reason))].join('; ')})` : '';
  return { id, check, state: 'pass', detail: `${skills} skill(s), ${links.length} via symlink${tail}`, file, present: true, skills, symlinked: links, unresolved };
}

/** `real` lies strictly below `realRoot`, compared by path segments, not by string prefix. */
function strictlyInside(realRoot, real) {
  const rel = path.relative(realRoot, real);
  return !(rel === '' || path.isAbsolute(rel) || rel.split(path.sep)[0] === '..');
}

/**
 * Why `.cursor` or `.cursor/rules` must not be listed: a link that leaves the
 * repo (or dangles). Listing it would print host file names from outside the
 * repo and walk an unbounded tree. `null` = absent or inside the repo.
 */
function cursorRulesEscape(repoRoot, realRoot) {
  for (const rel of ['.cursor', '.cursor/rules']) {
    const abs = path.join(repoRoot, rel);
    try {
      lstatSync(abs);
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
      return `${rel} not listed (${errClass(err)})`;
    }
    if (realRoot === null) return `${rel} not listed: repo root has no real path`;
    let real;
    try {
      real = realpathSync(abs);
    } catch (err) {
      return err?.code === 'ENOENT' ? `${rel} is a dangling link; not listed` : `${rel} path unresolvable (${errClass(err)})`;
    }
    if (!strictlyInside(realRoot, real)) return `${rel} is a directory link that leaves the repository; not listed`;
  }
  return null;
}

/** Depth limit of the `.cursor/rules` walk (`.cursor/rules` itself is level 0). */
const MAX_RULE_DEPTH = 8;

/**
 * Read an instruction file. Its real path must lie inside the real repo root
 * (path segments, not a string prefix) — whether the file itself or a parent
 * directory such as `.cursor/rules` is the link. A symlinked file is followed
 * once and its target goes through readGuarded itself (regular file, size cap).
 * Never throws.
 * @returns {{state: 'absent'} | {state: 'ok', text: string, real: string, via: string|null} | {state: 'fail', reason: string}}
 */
function readInstruction(abs, realRoot) {
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { state: 'absent' };
    return { state: 'fail', reason: `unreadable (${errClass(err)})` };
  }
  const link = st.isSymbolicLink();
  if (realRoot === null) return { state: 'fail', reason: 'not read: repo root has no real path' };
  let real;
  try {
    real = realpathSync(abs);
  } catch (err) {
    return { state: 'fail', reason: link && err?.code === 'ENOENT' ? 'dangling symlink' : `path unresolvable (${errClass(err)})` };
  }
  const rel = path.relative(realRoot, real);
  if (!strictlyInside(realRoot, real)) {
    return { state: 'fail', reason: link ? 'symlink leaves the repo; not followed' : 'a parent directory link leaves the repo; not followed' };
  }
  if (!link) {
    const r = readGuarded(abs);
    return r.state === 'ok' ? { ...r, real, via: null } : r;
  }
  const r = readGuarded(real);
  if (r.state === 'absent') return { state: 'fail', reason: 'dangling symlink' };
  if (r.state !== 'ok') return { state: 'fail', reason: `symlink target ${r.reason}` };
  return { ...r, real, via: rel.split(path.sep).join('/') };
}

/** Instruction files: CLAUDE.md, AGENTS.md, `.cursor/rules/**` (class 6). */
function instructionChecks(repoRoot, acc) {
  const checks = [];
  const rels = ['CLAUDE.md', 'AGENTS.md'];
  let ruleFiles = 0;
  let listProblem;
  let capHit = false;
  // A directory entry that is a link is never descended; it goes to readInstruction
  // like a file link (containment check). Cap and depth limit end the walk early.
  const walk = (rel, depth) => {
    let entries;
    try {
      entries = readdirSync(path.join(repoRoot, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') listProblem = `${rel} not listed (${errClass(err)})`;
      return;
    }
    for (const entry of entries) {
      if (capHit) return;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (ruleFiles >= MAX_RULE_FILES) {
          capHit = true;
          listProblem = `file cap of ${MAX_RULE_FILES} reached under .cursor/rules; further directories not listed`;
        } else if (depth >= MAX_RULE_DEPTH) listProblem = `deeper than ${MAX_RULE_DEPTH} levels under .cursor/rules; not listed`;
        else walk(child, depth + 1);
      } else if (ruleFiles < MAX_RULE_FILES) {
        ruleFiles += 1;
        rels.push(child);
      } else {
        capHit = true;
        listProblem = `more than ${MAX_RULE_FILES} files under .cursor/rules`;
      }
    }
  };
  let realRoot = null;
  try {
    realRoot = realpathSync(repoRoot);
  } catch {
    // no link is followed without a real repo root
  }
  listProblem = cursorRulesEscape(repoRoot, realRoot);
  if (listProblem === null) walk('.cursor/rules', 0);
  let read = 0;
  const scanned = new Set(); // real paths already scanned: AGENTS.md -> CLAUDE.md is scanned once
  const links = [];
  for (const rel of rels) {
    const r = readInstruction(path.join(repoRoot, rel), realRoot);
    if (r.state === 'absent') continue;
    if (r.state === 'fail') {
      checks.push(unreadSurface(`instruction-file:${rel}`, `instruction file ${rel}`, rel, r.reason, acc));
      continue;
    }
    read += 1;
    if (r.via !== null) links.push(`${rel}: symlink to ${r.via}`);
    if (scanned.has(r.real)) continue;
    scanned.add(r.real);
    const found = hiddenUnicode(r.text, rel);
    if (r.via !== null) for (const f of found) f.detail += ` (symlink to ${r.via})`;
    acc.findings.push(...found);
  }
  if (listProblem) checks.push(unreadSurface('instruction-cursor-rules', 'instruction files .cursor/rules', '.cursor/rules', listProblem, acc));
  const hits = acc.findings.filter((f) => f.class === 'hidden-unicode').length;
  const linkNote = links.length > 0 ? `; ${links.join('; ')}` : '';
  checks.unshift({ id: 'repo-instructions', check: 'repo instruction files', state: hits > 0 ? 'fail' : 'pass',
    detail: `${read} instruction file(s) scanned (${ruleFiles} under .cursor/rules); ${hits} line(s) with hidden Unicode${linkNote}`, instructionFiles: read, cursorRuleFiles: ruleFiles });
  return checks;
}

/**
 * @param {{repoRoot: string, ref: string|null, env: NodeJS.ProcessEnv}} args
 * @returns {Promise<import('./contract.mjs').Result>}
 */
export async function run({ repoRoot, ref, env }) {
  const findings = [];
  const tally = () => ({ findings, hooks: 0, hookEvents: 0, mcp: 0, mcpThisProject: 0, plugins: 0, skills: 0, notMeasurable: 0 });
  const repo = tally();
  const checks = [];

  const repoReadable = isDir(repoRoot);
  if (repoReadable) {
    const r = (rel) => path.join(repoRoot, rel);
    checks.push(...instructionChecks(repoRoot, repo));
    checks.push(settingsSurface('repo-settings', 'repo .claude/settings.json', r('.claude/settings.json'), '.claude/settings.json', repo));
    checks.push(settingsSurface('repo-settings-local', 'repo .claude/settings.local.json', r('.claude/settings.local.json'), '.claude/settings.local.json', repo));
    checks.push(mcpJsonSurface(r('.mcp.json'), '.mcp.json', repo));
    checks.push(skillsSurface('repo-skills', 'repo .claude/skills', r('.claude/skills'), '.claude/skills', (p) => path.relative(repoRoot, p) || '.', repo));
  } else {
    checks.push(notMeasurable('repo', 'repo surfaces', 'repo not read', 'repo root is not a readable directory'));
  }

  // HOME, else USERPROFILE (native Windows); never os.homedir() — an empty env means "no host".
  const home = [env?.HOME, env?.USERPROFILE].map((v) => (typeof v === 'string' ? v.trim() : '')).find((v) => v !== '') ?? '';
  const hostReadable = home !== '' && isDir(home);
  const host = tally();
  const hostIds = [
    ['host-settings', 'host ~/.claude/settings.json'],
    ['host-settings-local', 'host ~/.claude/settings.local.json'],
    ['host-claude-json', 'host ~/.claude.json MCP servers'],
    ['host-plugins', 'host installed plugins'],
    ['host-skills', 'host ~/.claude/skills'],
  ];
  if (hostReadable) {
    const h = (rel) => path.join(home, rel);
    const display = (p) => (p === home || p.startsWith(`${home}${path.sep}`) ? `~${p.slice(home.length)}` : p);
    checks.push(settingsSurface('host-settings', hostIds[0][1], h('.claude/settings.json'), '~/.claude/settings.json', host));
    checks.push(settingsSurface('host-settings-local', hostIds[1][1], h('.claude/settings.local.json'), '~/.claude/settings.local.json', host));
    checks.push(claudeJsonSurface(h('.claude.json'), '~/.claude.json', repoRoot, host));
    checks.push(pluginsSurface(h('.claude/plugins/installed_plugins.json'), '~/.claude/plugins/installed_plugins.json', host));
    checks.push(skillsSurface('host-skills', hostIds[4][1], h('.claude/skills'), '~/.claude/skills', display, host));
  } else {
    const reason = home === '' ? 'neither HOME nor USERPROFILE is set' : 'the home directory is not readable';
    for (const [id, check] of hostIds) checks.push(notMeasurable(id, check, 'host surface not read', reason));
  }
  // Codex config.toml is never parsed; one that exists (any file type) is an unread surface.
  const codexFiles = [];
  if (repoReadable) codexFiles.push([path.join(repoRoot, '.codex/config.toml'), '.codex/config.toml', repo]);
  if (hostReadable) codexFiles.push([path.join(home, '.codex/config.toml'), '~/.codex/config.toml', host]);
  for (const [abs, file, acc] of codexFiles) {
    let exists = true;
    try {
      lstatSync(abs);
    } catch (err) {
      exists = err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR';
    }
    if (exists) unreadSurface('codex-config', 'Codex config.toml', file, 'no TOML parser in this build', acc);
  }
  checks.push(notMeasurable('codex-config', 'Codex config.toml', 'Codex config.toml not read', 'no TOML parser in this build'));

  checks.push({
    id: 'inventory-totals',
    check: 'inventory totals',
    state: 'pass',
    detail: `repo: ${repo.hooks} hook command(s) on ${repo.hookEvents} event(s), ${repo.mcp} MCP server(s), ${repo.skills} skill(s); `
      + (hostReadable ? `host: ${host.hooks} hook command(s) on ${host.hookEvents} event(s), ${host.mcp} user MCP server(s), ${host.mcpThisProject} MCP server(s) under projects[<this repo>], ${host.plugins} plugin(s), ${host.skills} skill(s)` : 'host: not read'),
    repo: { hooks: repo.hooks, hookEvents: repo.hookEvents, mcpServers: repo.mcp, skills: repo.skills },
    host: hostReadable ? { hooks: host.hooks, hookEvents: host.hookEvents, mcpServers: host.mcp, thisProjectMcpServers: host.mcpThisProject, plugins: host.plugins, skills: host.skills } : null,
  });

  const notChecked = checks.filter((c) => c.state === 'not-measurable').length + repo.notMeasurable + host.notMeasurable;
  const basis = { tree: 'working-tree', ref: null, note: ref ? 'agent-setup always reads the working tree and host files; --ref is not applied' : null };
  if (!repoReadable && !hostReadable) {
    return makeResult({ mode: 'agent-setup', status: 'degraded', findings, checks, notChecked, basis, reason: 'neither the repo nor the host could be read' });
  }
  return makeResult({ mode: 'agent-setup', status: findings.length > 0 ? 'findings' : 'ok', findings, checks, notChecked, basis });
}
