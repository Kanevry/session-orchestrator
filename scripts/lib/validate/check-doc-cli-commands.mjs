#!/usr/bin/env node
/**
 * Check: `gh`/`glab` commands cited in documentation actually exist (#1023).
 *
 * ## Why
 *
 * `skills/plan/mode-new.md` shipped two commands that never existed in any
 * released CLI — `glab repo edit --visibility` and `glab group list`. Prose is
 * not executed, so nothing caught them. This check executes the CLI's own help
 * and compares the documented invocation against it.
 *
 * ## Oracle — the help text, NEVER the exit code
 *
 * `glab repo bogusnonexistentxyz --help` exits **0**, exactly like a real
 * subcommand. An exit-code probe is therefore an assert-nothing oracle at the
 * subcommand level. The only trustworthy signal is the `COMMANDS` section that
 * `<bin> <group> --help` prints about itself.
 *
 * Consequences of parsing each group's OWN help, rather than a top-level
 * membership table:
 *
 * 1. **Undocumented aliases resolve for free.** `glab pipeline` is a working
 *    alias for `glab ci` but is absent from `glab --help`'s COMMANDS. A
 *    top-level membership check reports its 6 in-repo uses as dead; asking
 *    `glab pipeline --help` returns `glab ci`'s own COMMANDS and it passes.
 * 2. **Leaf commands exempt themselves structurally.** `gh api` / `glab api`
 *    take a positional endpoint, not a subcommand, and print no COMMANDS
 *    section at all. `commands === null` means "nothing to verify here" — so
 *    the two `glab api projects/...` lines in `skills/_shared/monitor-patterns.md`
 *    need no allowlist entry. The exemption is derived, not hardcoded.
 *
 * The exit code IS used one level up, to decide whether the GROUP exists:
 * `glab group --help` exits 1 with `Unknown command "group"`.
 *
 * ## Two extraction channels, both load-bearing
 *
 * Shell fences alone miss `glab group list`, which lives in an inline code span
 * in a prose sentence. Inline spans alone miss everything in a `bash` block.
 * The inline channel only accepts a span that BEGINS with `gh `/`glab ` — a CLI
 * name in the middle of a span is prose about a command, not a command.
 *
 * ## Negative examples in docs
 *
 * `skills/gitlab-ops/SKILL.md` documents commands NOT to run. The convention
 * that keeps them out of this check is structural, not an allowlist (an
 * allowlist would exempt the file richest in real commands): write a negative
 * example either as a shell comment inside a fence, or as prose that does not
 * open an inline span with `gh `/`glab `.
 *
 * ## Mode: WARN-only
 *
 * Findings print as WARN and still return 0. Two reasons: (a) the oracle is the
 * LOCALLY installed CLI, so a version skew would red an unrelated commit; and
 * (b) `scripts/validate-plugin.mjs` tallies `/^[ ]{2}FAIL:/gm` module-wide, so a
 * single `FAIL:` line from a warn-class check reds the entire validator. `FAIL:`
 * is reserved for the tool-error path. Promoting to FAIL is a one-line change
 * once the CLI versions are pinned.
 *
 * A missing binary is a silent SKIP returning 0 — a CI runner without `glab`
 * must not turn this check red.
 *
 * Verified against glab 1.91.0 / gh 2.86.0 (2026-08-15).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { listRepoFiles } from './repo-files.mjs';
import { SHELL_LANGS, forEachLine } from './markdown-fences.mjs';

/** Directories walked for documentation. Mirrors check-vcs-repo-flag.mjs. */
const SCAN_DIRS = Object.freeze([
  '.claude',
  'agents',
  'commands',
  'docs',
  'hooks',
  'scripts',
  'skills',
  'templates',
]);

/** Never descend into these. */

/** The CLIs this check knows how to interrogate. */
const BINS = Object.freeze(['gh', 'glab']);

/** Max chars of a cited command echoed back in a message. */
const SNIPPET_MAX = 120;

/**
 * A token is judgeable only when it is a literal word. Anything carrying shell
 * interpolation, a placeholder, or an API path is a template, not a subcommand.
 *
 * @param {string | undefined} token
 * @returns {boolean}
 */
function isPlainToken(token) {
  return typeof token === 'string' && /^[a-z][a-z0-9_-]*$/.test(token);
}

/**
 * An all-caps help section header (`USAGE`, `FLAGS`, `CORE COMMANDS`, …).
 * glab pads its headers (`  COMMANDS  `); gh puts them at column 0.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isSectionHeader(line) {
  const trimmed = line.trim();
  return trimmed.length >= 3 && /^[A-Z][A-Z0-9 /-]*$/.test(trimmed);
}

/**
 * A section header that introduces a command list. Matches glab's `COMMANDS`
 * and every gh variant (`CORE COMMANDS`, `TARGETED COMMANDS`, `ALIAS COMMANDS`).
 *
 * @param {string} line
 * @returns {boolean}
 */
function isCommandsHeader(line) {
  return isSectionHeader(line) && /(?:^|\s)COMMANDS$/.test(line.trim());
}

/**
 * Parse every COMMANDS section out of a help text.
 *
 * Entries are taken only at the section's MINIMUM indentation — that is the
 * command column. Deeper-indented lines are wrapped description text, whose
 * first word would otherwise be mistaken for a subcommand.
 *
 * @param {string} helpText raw `<bin> <group> --help` output
 * @returns {Set<string> | null} the subcommand names, or null when the command
 *   prints no COMMANDS section at all (a leaf command taking a positional).
 */
export function parseCommandsSection(helpText) {
  const lines = helpText.split('\n');
  /** @type {Set<string>} */
  const names = new Set();
  let sawSection = false;

  for (let index = 0; index < lines.length; index += 1) {
    if (!isCommandsHeader(lines[index])) continue;
    sawSection = true;

    /** @type {string[]} */
    const block = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (isSectionHeader(lines[cursor])) break;
      if (lines[cursor].trim() === '') continue;
      block.push(lines[cursor]);
    }
    if (block.length === 0) continue;

    const minIndent = Math.min(...block.map((line) => line.length - line.trimStart().length));
    for (const line of block) {
      if (line.length - line.trimStart().length !== minIndent) continue;
      const first = line.trim().split(/\s+/)[0].replace(/[:,]$/, '');
      if (isPlainToken(first)) names.add(first);
    }
  }

  return sawSection ? names : null;
}

/**
 * Join `\`-continuation lines into logical lines, keeping the START line number.
 *
 * @param {{line: number, text: string}[]} entries
 * @returns {{line: number, text: string}[]}
 */
function joinContinuations(entries) {
  /** @type {{line: number, text: string}[]} */
  const joined = [];
  for (let index = 0; index < entries.length; index += 1) {
    const { line } = entries[index];
    let { text } = entries[index];
    while (
      /\\\s*$/.test(text) &&
      index + 1 < entries.length &&
      entries[index + 1].line === entries[index].line + 1
    ) {
      index += 1;
      text = `${text.replace(/\\\s*$/, '')} ${entries[index].text.trim()}`;
    }
    joined.push({ line, text });
  }
  return joined;
}

/**
 * Pull candidate command texts out of a markdown body via both channels.
 *
 * Channel 1 — shell fences (CommonMark automaton, shell comments dropped).
 * Channel 2 — inline code spans OUTSIDE any fence that BEGIN with `gh `/`glab `.
 *
 * @param {string} body markdown content
 * @returns {{line: number, text: string, channel: 'shell-fence'|'inline-span'}[]}
 */
export function extractCandidates(body) {
  /** @type {{line: number, text: string, channel: 'shell-fence'|'inline-span'}[]} */
  const candidates = [];
  /** @type {{line: number, text: string}[]} */
  const shellLines = [];

  forEachLine(body, (raw, { lineNumber, inFence, lang }) => {
    if (inFence) {
      if (!SHELL_LANGS.has(lang)) return;
      const stripped = raw.replace(/^\s*[$❯>]\s+/, '');
      if (/^\s*#/.test(stripped)) return;
      shellLines.push({ line: lineNumber, text: stripped });
      return;
    }

    for (const span of raw.matchAll(/`([^`]+)`/g)) {
      const text = span[1].trim();
      if (/^(?:gh|glab)\s/.test(text)) {
        candidates.push({ line: lineNumber, text, channel: 'inline-span' });
      }
    }
  });

  for (const entry of joinContinuations(shellLines)) {
    candidates.push({ line: entry.line, text: entry.text, channel: 'shell-fence' });
  }
  return candidates;
}

/**
 * Split one candidate text into `(cli, group, sub)` triples.
 *
 * @param {string} text
 * @returns {{cli: string, group: string, sub: string | undefined}[]}
 */
export function parseInvocations(text) {
  /** @type {{cli: string, group: string, sub: string | undefined}[]} */
  const found = [];
  const re = /\b(gh|glab)\s+([^\s;|&()]+)((?:\s+[^\s;|&()]+)*)/g;
  /** @type {RegExpExecArray | null} */
  let matched;
  while ((matched = re.exec(text)) !== null) {
    const rest = matched[3].trim().split(/\s+/).filter(Boolean);
    // The first non-flag token after the group is the candidate subcommand.
    const sub = rest.find((token) => !token.startsWith('-'));
    found.push({ cli: matched[1], group: matched[2], sub });
  }
  return found;
}

/**
 * Interrogate `<bin> <group> --help`, memoised per pair.
 *
 * Never piped: `$?` after a pipe measures the pipe's last stage, not the CLI.
 *
 * @param {string} bin
 * @param {string} group
 * @param {Map<string, {ok: boolean, commands: Set<string> | null}>} cache
 * @returns {{ok: boolean, commands: Set<string> | null}}
 */
function probeHelp(bin, group, cache) {
  const key = `${bin} ${group}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const result = spawnSync(bin, [group, '--help'], { encoding: 'utf8', timeout: 20_000 });
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const entry = {
    ok: result.status === 0,
    commands: result.status === 0 ? parseCommandsSection(text) : null,
  };
  cache.set(key, entry);
  return entry;
}

/** @param {string} text @returns {string} */
function clampSnippet(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX - 1)}…` : flat;
}

/**
 * Census the documentation corpus for dead `gh`/`glab` commands.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {{ok: boolean, skipped: string[], summary: object, findings: object[], toolError: boolean}}
 */
export function inspectDocCliCommands(pluginRoot) {
  /** @type {{kind: string, file: string, line: number, channel: string, command: string, message: string}[]} */
  const findings = [];
  /** @type {string[]} */
  const skipped = [];

  const available = BINS.filter((bin) => spawnSync('command', ['-v', bin], { shell: true }).status === 0);
  for (const bin of BINS) {
    if (!available.includes(bin)) skipped.push(bin);
  }

  const summary = {
    filesScanned: 0,
    shellFenceCandidates: 0,
    inlineSpanCandidates: 0,
    judged: 0,
    leafExempt: 0,
    templateSkipped: 0,
    findings: 0,
  };

  if (available.length === 0) {
    return { ok: true, skipped, summary, findings, toolError: false };
  }

  /** @type {string[]} */
  let files;
  try {
    // The index, not the filesystem (#1143). A `readdirSync` walk cannot see
    // `.gitignore`, so every ignored artefact under a scan root entered this
    // census as if it were documentation: measured 2026-08-26 on a clean
    // checkout with NO worktree present, 4 such files —  `.claude/STATE.md`
    // (per-session mutable state) and three gitignored `docs/specs/*.md`. A
    // worktree under this repo's own `.claude/worktrees/` convention would
    // add a complete second copy of every scanned doc on top of that.
    // One enumeration covers both populations this check has always scanned:
    // the SCAN_DIRS subtrees, and the repo-root `.md` files at depth 0.
    const scanDirs = new Set(SCAN_DIRS);
    files = listRepoFiles(pluginRoot, { exts: ['.md'] }).filter((absolute) => {
      const segments = path.relative(pluginRoot, absolute).split(path.sep);
      return segments.length === 1 || scanDirs.has(segments[0]);
    });
  } catch (error) {
    findings.push({
      kind: 'tool-error',
      file: '-',
      line: 0,
      channel: '-',
      command: '-',
      message: `cannot enumerate the scan corpus: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { ok: false, skipped, summary, findings, toolError: true };
  }

  /** @type {Map<string, {ok: boolean, commands: Set<string> | null}>} */
  const helpCache = new Map();

  for (const absolute of files) {
    const relative = path.relative(pluginRoot, absolute);
    /** @type {string} */
    let body;
    try {
      body = readFileSync(absolute, 'utf8');
    } catch (error) {
      findings.push({
        kind: 'tool-error',
        file: relative,
        line: 0,
        channel: '-',
        command: '-',
        message: `cannot read: ${error instanceof Error ? error.message : String(error)}`,
      });
      return { ok: false, skipped, summary, findings, toolError: true };
    }
    summary.filesScanned += 1;
    if (!/\b(?:gh|glab)\s/.test(body)) continue;

    for (const candidate of extractCandidates(body)) {
      if (candidate.channel === 'shell-fence') summary.shellFenceCandidates += 1;
      else summary.inlineSpanCandidates += 1;

      for (const { cli, group, sub } of parseInvocations(candidate.text)) {
        if (!available.includes(cli)) continue;
        if (!isPlainToken(group)) {
          summary.templateSkipped += 1;
          continue;
        }

        const help = probeHelp(cli, group, helpCache);
        if (!help.ok) {
          summary.judged += 1;
          summary.findings += 1;
          findings.push({
            kind: 'dead-command-group',
            file: relative,
            line: candidate.line,
            channel: candidate.channel,
            command: `${cli} ${group}`,
            message:
              `\`${cli} ${group}\` does not exist — \`${cli} ${group} --help\` exits non-zero: ` +
              clampSnippet(candidate.text),
          });
          continue;
        }

        // A command with no COMMANDS section is a leaf taking a positional
        // argument (`gh api <endpoint>`); there is no subcommand to verify.
        if (help.commands === null) {
          summary.leafExempt += 1;
          continue;
        }
        if (!isPlainToken(sub)) {
          summary.templateSkipped += 1;
          continue;
        }

        summary.judged += 1;
        if (!help.commands.has(/** @type {string} */ (sub))) {
          summary.findings += 1;
          findings.push({
            kind: 'dead-subcommand',
            file: relative,
            line: candidate.line,
            channel: candidate.channel,
            command: `${cli} ${group} ${sub}`,
            message:
              `\`${cli} ${group} ${sub}\` is not in the COMMANDS list printed by ` +
              `\`${cli} ${group} --help\`: ${clampSnippet(candidate.text)}`,
          });
        }
      }
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { ok: findings.length === 0, skipped, summary, findings, toolError: false };
}

/**
 * Run the human-readable validator CLI.
 *
 * WARN-ONLY: findings print as WARN and still return 0 — see § Mode in the
 * header for why a stray `FAIL:` line would red the whole validate-plugin gate.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {number} 0 = census completed, 2 = tool error
 */
export function runCheckDocCliCommands(pluginRoot) {
  console.log('--- Check: gh/glab commands cited in docs exist (WARN-only) ---');
  const inspection = inspectDocCliCommands(pluginRoot);

  if (inspection.toolError) {
    for (const item of inspection.findings) console.log(`  FAIL: ${item.file} — ${item.message}`);
    console.log('');
    console.log(`Results: 0 passed, ${inspection.findings.length} failed`);
    return 2;
  }

  for (const bin of inspection.skipped) {
    console.log(`  SKIP: \`${bin}\` is not installed — its citations were not verified`);
  }

  for (const item of inspection.findings) {
    console.log(`  WARN: [${item.kind}] ${item.file}:${item.line} — ${item.message}`);
  }

  const s = inspection.summary;
  console.log(
    `  PASS: censused ${s.filesScanned} doc file(s) — ${s.shellFenceCandidates} shell-fence + ` +
      `${s.inlineSpanCandidates} inline-span candidate(s); ${s.judged} invocation(s) judged against ` +
      `live --help, ${s.leafExempt} leaf command(s) exempt (positional argument, no COMMANDS section), ` +
      `${s.templateSkipped} templated token(s) unjudged, ${s.findings} dead`,
  );
  console.log('');
  console.log('Results: 1 passed, 0 failed');
  return 0;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--json');
  const root = path.resolve(args[0] || process.cwd());
  if (process.argv.includes('--json')) {
    const inspection = inspectDocCliCommands(root);
    process.stdout.write(`${JSON.stringify(inspection, (_k, v) => (v instanceof Set ? [...v] : v), 2)}\n`);
    process.exit(inspection.toolError ? 2 : 0);
  }
  process.exit(runCheckDocCliCommands(root));
}
