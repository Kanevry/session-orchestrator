/**
 * apply-patch-parse.mjs — strict reader for the Codex `apply_patch` envelope
 * (GitLab #1913). Pure, Node-built-ins only, import-safe: it is loaded by the
 * PreToolUse hook `hooks/codex-apply-patch-guard.mjs`, and a module that throws
 * at import time there blocks every Codex file edit on the host.
 *
 * ## What is measured and what is not
 *
 * MEASURED (strings of the codex-cli 0.160.1 native binary, 2026-11-01):
 *   - `apply_patch` is a FREEFORM tool ("do not wrap the patch in JSON") with a
 *     Lark grammar: `*** Begin Patch`, an optional `*** Environment ID: <x>`
 *     line, hunks `*** Add File: `, `*** Delete File: `, `*** Update File: `
 *     (optionally followed by `*** Move to: `), `*** End of File`, and
 *     `*** End Patch`.
 *
 * MEASURED (logged PreToolUse/PostToolUse payloads, codex-cli 0.160.1, macOS,
 * `codex exec`, 2026-11-02, #1914): the `apply_patch` matcher fires with
 * `tool_name: "apply_patch"` and `tool_input` = exactly `{ command: "<patch>" }`,
 * the patch as one string; header paths may be relative (to the payload `cwd`)
 * or absolute. `extractPatchText` accepts that shape and nothing else. The
 * `input` / `patch` keys and the `['apply_patch', <patch>]` array asserted in
 * GitHub #83 were never observed (an array `command` is a router error before
 * any hook runs), so they are no longer read: a payload in such a shape denies.
 *
 * The same patch can also reach Codex through its shell tool as an
 * `apply_patch <<'EOF' … EOF` heredoc; that route arrives as `tool_name: "Bash"`
 * and is read by `extractShellApplyPatch` in `hooks/codex-apply-patch-guard.mjs`.
 *
 * ## Strictness
 *
 * Anything outside the grammar is `ok: false` — unknown `*** ` lines, a second
 * `*** Begin Patch`, a patch without `*** End Patch`, an Update hunk without
 * lines, and any path that is empty or carries a control character (`\r`,
 * `\0`, tab, …). A CR-terminated header line in particular would otherwise
 * slip past the ledger and STATE.md guards, whose suffix regexes end in `$`.
 * `..` segments and absolute paths are kept verbatim: the guards judge them.
 */

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ENV_PREFIX = '*** Environment ID: ';
const ADD_PREFIX = '*** Add File: ';
const DELETE_PREFIX = '*** Delete File: ';
const UPDATE_PREFIX = '*** Update File: ';
const MOVE_PREFIX = '*** Move to: ';
const EOF_MARKER = '*** End of File';

// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * @typedef {{ oldLines: string[], newLines: string[], restart?: boolean }} PatchHunk
 *   `restart` marks the first hunk of a later Update section folded in by
 *   `foldPatchFiles`: Codex searches each section from the top of the file.
 * @typedef {{ op: 'add', path: string, content: string }
 *   | { op: 'delete', path: string }
 *   | { op: 'update', path: string, hunks: PatchHunk[] }
 *   | { op: 'move', path: string, to: string, hunks: PatchHunk[] }} PatchFile
 */

/**
 * Validate one header path. Control characters are checked on the RAW value,
 * before the surrounding spaces are trimmed, so a trailing `\r` is never lost.
 *
 * @param {string} raw
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
function checkPath(raw) {
  if (CONTROL_CHARS.test(raw)) return { ok: false, reason: 'path contains a control character' };
  const value = raw.trim();
  if (value === '') return { ok: false, reason: 'empty path' };
  return { ok: true, path: value };
}

/**
 * Turn the body lines of one Update section into hunks. `@@` lines separate
 * chunks; ` `/empty = context, `-` = removed, `+` = added.
 *
 * @param {string[]} lines
 * @returns {{ ok: true, hunks: PatchHunk[] } | { ok: false, reason: string }}
 */
function parseUpdateBody(lines) {
  const hunks = [];
  let oldLines = [];
  let newLines = [];
  let open = false;
  const flush = () => {
    if (open && (oldLines.length > 0 || newLines.length > 0)) hunks.push({ oldLines, newLines });
    oldLines = [];
    newLines = [];
    open = false;
  };
  for (const raw of lines) {
    // Codex reads the body with `str::lines()`, which drops ONE trailing `\r`
    // (#1913 security review). Header lines are checked separately and keep
    // rejecting any `\r`.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('@@')) {
      flush();
      open = true;
      continue;
    }
    if (line === EOF_MARKER) continue;
    open = true;
    if (line === '') {
      oldLines.push('');
      newLines.push('');
    } else if (line[0] === ' ') {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    } else if (line[0] === '-') {
      oldLines.push(line.slice(1));
    } else if (line[0] === '+') {
      newLines.push(line.slice(1));
    } else {
      return { ok: false, reason: `unexpected line in update hunk: ${JSON.stringify(line.slice(0, 40))}` };
    }
  }
  flush();
  return { ok: true, hunks };
}

/**
 * Parse an `apply_patch` envelope.
 *
 * @param {unknown} text
 * @returns {{ ok: true, files: PatchFile[] } | { ok: false, reason: string }}
 */
export function parseApplyPatch(text) {
  if (typeof text !== 'string' || text === '') return { ok: false, reason: 'patch is not a non-empty string' };
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines[0] !== BEGIN) return { ok: false, reason: `first line is not '${BEGIN}'` };
  if (lines.length < 2 || lines[lines.length - 1] !== END) {
    return { ok: false, reason: `unterminated patch: last line is not '${END}'` };
  }
  const body = lines.slice(1, -1);
  let i = 0;
  if (body[0]?.startsWith(ENV_PREFIX)) i = 1;

  /** @type {PatchFile[]} */
  const files = [];
  while (i < body.length) {
    const header = body[i];
    if (header === BEGIN) return { ok: false, reason: `second '${BEGIN}'` };
    if (header === END) return { ok: false, reason: `'${END}' before the last line` };
    let kind;
    let rawPath;
    if (header.startsWith(ADD_PREFIX)) [kind, rawPath] = ['add', header.slice(ADD_PREFIX.length)];
    else if (header.startsWith(DELETE_PREFIX)) [kind, rawPath] = ['delete', header.slice(DELETE_PREFIX.length)];
    else if (header.startsWith(UPDATE_PREFIX)) [kind, rawPath] = ['update', header.slice(UPDATE_PREFIX.length)];
    else return { ok: false, reason: `expected a file header, got ${JSON.stringify(header.slice(0, 40))}` };
    const checked = checkPath(rawPath);
    if (!checked.ok) return checked;
    i += 1;

    let to;
    if (kind === 'update' && body[i]?.startsWith(MOVE_PREFIX)) {
      const dest = checkPath(body[i].slice(MOVE_PREFIX.length));
      if (!dest.ok) return dest;
      to = dest.path;
      i += 1;
    }

    // Section body: every line up to the next `*** ` line.
    const start = i;
    while (i < body.length && !body[i].startsWith('*** ')) i += 1;
    // `*** End of File` belongs to an Update body; any other `*** ` line is a header (judged next loop).
    while (kind === 'update' && body[i] === EOF_MARKER) {
      i += 1;
      while (i < body.length && !body[i].startsWith('*** ')) i += 1;
    }
    const section = body.slice(start, i);

    if (kind === 'delete') {
      if (section.length > 0) return { ok: false, reason: 'delete hunk carries lines' };
      files.push({ op: 'delete', path: checked.path });
    } else if (kind === 'add') {
      if (section.some((line) => !line.startsWith('+'))) {
        return { ok: false, reason: 'add hunk line does not start with +' };
      }
      // An empty Add (no `+` lines) creates an empty file; the guards still judge the path.
      files.push({ op: 'add', path: checked.path, content: section.map((line) => `${line.slice(1).replace(/\r$/, '')}\n`).join('') });
    } else {
      const parsed = parseUpdateBody(section);
      if (!parsed.ok) return parsed;
      // A pure rename (Move without a body) is legitimate; an Update without lines is not.
      if (parsed.hunks.length === 0 && to === undefined) return { ok: false, reason: 'update hunk without lines' };
      files.push(to === undefined
        ? { op: 'update', path: checked.path, hunks: parsed.hunks }
        : { op: 'move', path: checked.path, to, hunks: parsed.hunks });
    }
  }
  if (files.length === 0) return { ok: false, reason: 'patch touches no file' };
  return { ok: true, files };
}

/** Common Unicode punctuation Codex folds to ASCII in its last matching pass. */
const PUNCTUATION = [
  [/[\u2018\u2019\u201a\u201b\u2032]/g, "'"],
  [/[\u201c\u201d\u201e\u201f\u2033]/g, '"'],
  [/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-'],
  [/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, ' '],
];
const normalisePunctuation = (s) => PUNCTUATION.reduce((acc, [re, to]) => acc.replace(re, to), s);

/** The four comparison passes of Codex's hunk search, strictest first. */
const MATCH_PASSES = [
  (s) => s,
  (s) => s.trimEnd(),
  (s) => s.trim(),
  (s) => normalisePunctuation(s).trim(),
];

/**
 * Find where a hunk's context (its context + removed lines) sits in a file,
 * the way Codex does: the first occurrence at or after `start`, trying an
 * exact comparison, then trailing-whitespace-trimmed, then fully trimmed, then
 * Unicode-punctuation-normalised + trimmed. Returns the line index or -1.
 *
 * @param {string[]} lines  file lines (without line terminators)
 * @param {string[]} contextLines
 * @param {number} [start]
 * @returns {number}
 */
export function locateHunk(lines, contextLines, start = 0) {
  if (contextLines.length === 0) return lines.length;
  for (const norm of MATCH_PASSES) {
    const want = contextLines.map(norm);
    for (let i = start; i + want.length <= lines.length; i += 1) {
      let hit = true;
      for (let j = 0; j < want.length && hit; j += 1) hit = norm(lines[i + j]) === want[j];
      if (hit) return i;
    }
  }
  return -1;
}

/**
 * Compute the whole file Codex would write after applying `hunks` to
 * `original`. Hunks are located with `locateHunk`, each after the previous
 * one's end; a hunk without context or removed lines is appended. The file's
 * own line ending (`\r\n` when it has one) is kept, and the result ends with a
 * newline (Codex writes one).
 *
 * @param {string} original
 * @param {PatchHunk[]} hunks
 * @returns {{ ok: true, content: string } | { ok: false, reason: string }}
 */
export function applyHunksToText(original, hunks) {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let cursor = 0;
  for (const { oldLines, newLines, restart } of hunks) {
    if (restart) cursor = 0;
    const at = locateHunk(lines, oldLines, cursor);
    if (at === -1) return { ok: false, reason: 'hunk context not found' };
    lines.splice(at, oldLines.length, ...newLines);
    cursor = at + newLines.length;
  }
  return { ok: true, content: lines.length === 0 ? '' : `${lines.join(eol)}${eol}` };
}

/**
 * Fold every `*** Update File:` section of one path into a single Update entry
 * (#1914), so the guards judge each file once, on the content Codex ends up
 * writing. Codex applies the sections in order, each against the file the
 * previous one produced and each searched from the top; the folded entry keeps
 * that order and marks the first hunk of every later section with `restart`.
 * Without folding, a patch with 40 sections on one file started 160 guard
 * children, and a section whose context came from an earlier section was
 * judged against the unchanged file on disk.
 *
 * Only plain Updates fold. A path that is also added, deleted or moved
 * (as source or destination) in the same patch keeps its sections unchanged,
 * like Add, Delete and Move entries themselves.
 *
 * NAMED CEILING (BV-004): paths compare as spelled — `a.txt`, `./a.txt` and
 * the absolute spelling of the same file are not folded, and a later section
 * is judged against the file on disk. Revisit-Trigger: a Codex patch that
 * updates the same path in two spellings (then fold on `path.resolve(cwd, p)`).
 *
 * @param {PatchFile[]} files
 * @returns {PatchFile[]}
 */
export function foldPatchFiles(files) {
  const notPlainUpdate = new Set();
  for (const file of files) {
    if (file.op === 'update') continue;
    notPlainUpdate.add(file.path);
    if (file.op === 'move') notPlainUpdate.add(file.to);
  }
  /** @type {PatchFile[]} */
  const out = [];
  /** @type {Map<string, { op: 'update', path: string, hunks: PatchHunk[] }>} */
  const folded = new Map();
  for (const file of files) {
    if (file.op !== 'update' || notPlainUpdate.has(file.path)) {
      out.push(file);
      continue;
    }
    const first = folded.get(file.path);
    if (first === undefined) {
      const entry = { op: /** @type {const} */ ('update'), path: file.path, hunks: [...file.hunks] };
      folded.set(file.path, entry);
      out.push(entry);
      continue;
    }
    file.hunks.forEach((hunk, k) => first.hunks.push(k === 0 ? { ...hunk, restart: true } : hunk));
  }
  return out;
}

/**
 * Pull the patch text out of a Codex `apply_patch` `tool_input`. The only
 * accepted shape is the measured one (codex-cli 0.160.1, 2026-11-02):
 * `{ command: "<patch string>" }`. Any other key is rejected: an unknown key
 * such as `workdir` could change the base directory Codex applies the patch
 * against, which the guards would then not see (#1913 review F1).
 *
 * @param {unknown} toolInput
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function extractPatchText(toolInput) {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return { ok: false, reason: 'tool_input is not an object' };
  }
  const extra = Object.keys(toolInput).find((key) => key !== 'command');
  if (extra !== undefined) return { ok: false, reason: `tool_input carries an unrecognised key '${extra.slice(0, 40)}'` };
  const { command } = /** @type {Record<string, unknown>} */ (toolInput);
  if (command === undefined) return { ok: false, reason: 'tool_input carries no patch (expected command)' };
  if (typeof command !== 'string') return { ok: false, reason: 'tool_input.command is not a string' };
  return { ok: true, text: command };
}
