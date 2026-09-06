#!/usr/bin/env node
/**
 * generate-agents-skills.mjs — generate the CROSS-HARNESS PORTABLE SURFACE.
 *
 * 7 of 8 surveyed agent harnesses read `AGENTS.md` and/or a `<dir>/skills/
 * <name>/SKILL.md` layout; only Claude Code reads `CLAUDE.md` + a plugin skill
 * directory (Copilot CLI reads both). Measured 2026-09-06 in this repo:
 * `git ls-files | grep -i AGENTS.md` returned only `agents/AGENTS.md` (the
 * sub-agent authoring spec) — i.e. this repository opened in Codex CLI,
 * OpenCode, Kiro, Amp or Cursor could not find its own `## Session Config`.
 *
 * This generator writes two artefacts, both DERIVED and never hand-edited:
 *
 *   1. `AGENTS.md`               — a BYTE-IDENTICAL copy of `CLAUDE.md`.
 *   2. `.agents/skills/<name>/SKILL.md` — a portable mirror of each
 *      `skills/<name>/SKILL.md`, carrying ONLY agentskills.io-spec-legal
 *      frontmatter plus a pointer body (progressive disclosure — the mirror
 *      never duplicates the canonical instructions).
 *
 * ## Why a generated copy and NOT a symlink (measured, not preferred)
 *
 * A symlink `AGENTS.md -> CLAUDE.md` is the smaller diff, and it was rejected
 * on three measurements taken 2026-09-06:
 *
 *   - `package.json` `files[]` does NOT list `CLAUDE.md`, so the published npm
 *     tarball would carry a DANGLING symlink. The published artefact is the
 *     one a foreign harness consumes.
 *   - Git's `core.symlinks` defaults to FALSE on Windows without Developer
 *     Mode / admin (`git config core.symlinks` is unset here — exit 1 — i.e.
 *     the platform default applies). On such a checkout git materialises the
 *     link as a regular file whose entire content is the literal target path
 *     `CLAUDE.md` — a 10-byte file with zero Session Config, which is exactly
 *     the "pointer file that defeats the purpose" failure mode. The same
 *     applies to GitHub's Download-ZIP archives.
 *   - `git ls-files -s | awk '$1=="120000"'` returned ZERO rows: this repo has
 *     no symlink precedent, and it is itself a template other repos copy.
 *
 * A generated copy costs a drift gate, which `--check` provides and
 * `scripts/validate-plugin.mjs` runs. It carries NO "do not edit" banner on
 * purpose: byte-identity makes the drift-check's whole error class ("the two
 * instruction files disagree") impossible to express, and the `--check`
 * failure message carries the do-not-edit instruction at the moment it
 * matters. See `skills/_shared/instruction-file-resolution.md`.
 *
 * ## Usage
 *   node scripts/generate-agents-skills.mjs [--plugin-root <dir>] [--check] [--json]
 *
 * Exit codes: 0 — written / in sync · 1 — drift (with `--check`) or write error.
 */

import { readFileSync, writeFileSync, existsSync, statSync, lstatSync, mkdirSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';

/**
 * The complete set of SKILL.md frontmatter keys agentskills.io permits outside
 * Claude Code. Anything else is folded into `metadata` (as a string) or dropped.
 * @type {readonly string[]}
 */
export const PORTABLE_KEYS = Object.freeze([
  'name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools',
]);

/**
 * Source keys that map onto a spec key rather than into `metadata`.
 * `tools:` is our own (non-spec) spelling of `allowed-tools:` — 7 SKILL.md
 * files use it, measured 2026-09-06.
 * @type {Record<string, string>}
 */
const KEY_ALIASES = { tools: 'allowed-tools' };

/**
 * agentskills.io caps `description` at 1024 characters. Measured max across the
 * 43 source skills on 2026-09-06: 1012 (`sunset-review`) — i.e. nothing is
 * truncated today. Revisit trigger: if this generator starts reporting
 * `description-truncated` warnings, shorten the SOURCE description instead of
 * raising this constant; the cap is the spec's, not ours.
 */
export const DESCRIPTION_MAX = 1024;

/** Stringify a YAML scalar/array/object for the string-valued `metadata` map. */
function toMetadataString(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.every((v) => typeof v !== 'object' || v === null)
      ? value.map((v) => String(v)).join(', ')
      : JSON.stringify(value);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Project one source SKILL.md frontmatter object onto the spec-legal subset.
 *
 * @param {Record<string, unknown>} source - parsed source frontmatter
 * @param {string} skillName - directory name, used when `name:` is absent
 * @returns {{ fm: Record<string, unknown>, warnings: string[] }}
 */
export function toPortableFrontmatter(source, skillName) {
  const warnings = [];
  /** @type {Record<string, unknown>} */
  const out = {};
  /** @type {Record<string, string>} */
  const metadata = {};

  out.name = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : skillName;

  // Descriptions are authored as YAML block scalars (`description: >`), so they
  // arrive with embedded newlines. Collapse to one line: the spec's field is a
  // single-line summary and a folded scalar round-trips unpredictably.
  const desc = String(source.description ?? '').replace(/\s+/g, ' ').trim();
  if (!desc) warnings.push(`${skillName}: source has no description`);
  out.description = desc.length > DESCRIPTION_MAX
    ? (warnings.push(`${skillName}: description-truncated (${desc.length} > ${DESCRIPTION_MAX})`),
      `${desc.slice(0, DESCRIPTION_MAX - 1)}…`)
    : desc;

  for (const [rawKey, value] of Object.entries(source)) {
    if (rawKey === 'name' || rawKey === 'description') continue;
    const key = KEY_ALIASES[rawKey] ?? rawKey;
    if (key === 'allowed-tools') {
      const list = Array.isArray(value)
        ? value.map((v) => String(v).trim())
        : String(value).split(',').map((v) => v.trim());
      const tools = list.filter(Boolean);
      if (tools.length > 0) out['allowed-tools'] = tools;
      continue;
    }
    if (key === 'license' || key === 'compatibility') {
      out[key] = value;
      continue;
    }
    if (key === 'metadata' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [mk, mv] of Object.entries(value)) metadata[mk] = toMetadataString(mv);
      continue;
    }
    const asString = toMetadataString(value);
    if (asString !== '') metadata[rawKey] = asString;
  }

  if (Object.keys(metadata).length > 0) out.metadata = metadata;

  // Emit in the spec's own field order so the mirror reads the same everywhere.
  /** @type {Record<string, unknown>} */
  const ordered = {};
  for (const k of PORTABLE_KEYS) if (k in out) ordered[k] = out[k];
  return { fm: ordered, warnings };
}

/**
 * Render one mirror file: spec-legal frontmatter + a pointer body.
 *
 * The body deliberately does NOT restate the canonical instructions
 * (progressive disclosure): a foreign harness discovers the skill from the
 * frontmatter and reads the real body only when it invokes the skill.
 *
 * @param {string} skillName
 * @param {Record<string, unknown>} portableFm
 * @returns {string}
 */
export function renderMirror(skillName, portableFm) {
  const front = yaml.dump(portableFm, { lineWidth: -1, noRefs: true, quotingType: '"' });
  const canonical = `skills/${skillName}/SKILL.md`;
  return [
    '---',
    front.trimEnd(),
    '---',
    '',
    `# ${skillName}`,
    '',
    `> **Portable mirror — generated, do not edit.** The canonical skill body lives at`,
    `> [\`${canonical}\`](../../../${canonical}); read that file for the full instructions.`,
    `> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that`,
    `> discover skills under \`.agents/skills/\` can find and route to the skill.`,
    '>',
    '> Regenerate with `node scripts/generate-agents-skills.mjs`.',
    '',
  ].join('\n');
}

/** Parse a SKILL.md's YAML frontmatter block; returns `{}` when absent/unparseable. */
function readFrontmatter(absPath) {
  const content = readFileSync(absPath, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return null;
  try {
    const parsed = yaml.load(m[1]);
    return parsed && typeof parsed === 'object' ? /** @type {Record<string, unknown>} */ (parsed) : {};
  } catch {
    return null;
  }
}

/** List `skills/<name>` directories that carry a SKILL.md, sorted. */
export function listSourceSkills(pluginRoot) {
  const dir = path.join(pluginRoot, 'skills');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
    .map((e) => e.name)
    .filter((n) => existsSync(path.join(dir, n, 'SKILL.md')))
    .sort();
}

/**
 * Is `AGENTS.md` already an alias of `CLAUDE.md` by construction?
 *
 * Two shapes count as satisfied: a symlink (or hardlink) resolving to the same
 * inode, and a byte-identical regular file. The symlink branch exists because a
 * CONSUMER repo may legitimately choose it even though this repo does not (see
 * the header) — the invariant is "the two files cannot disagree", not "the two
 * files were produced by this generator".
 *
 * @param {string} claudePath
 * @param {string} agentsPath
 * @returns {{ satisfied: boolean, kind: 'absent'|'symlink'|'identical'|'divergent' }}
 */
export function agentsMdAliasState(claudePath, agentsPath) {
  if (!existsSync(claudePath)) return { satisfied: false, kind: 'absent' };
  if (!existsSync(agentsPath)) return { satisfied: false, kind: 'absent' };
  try {
    if (lstatSync(agentsPath).isSymbolicLink()) {
      if (realpathSync(agentsPath) === realpathSync(claudePath)) return { satisfied: true, kind: 'symlink' };
      return { satisfied: false, kind: 'divergent' };
    }
    const a = statSync(agentsPath);
    const c = statSync(claudePath);
    if (a.ino !== 0 && a.ino === c.ino && a.dev === c.dev) return { satisfied: true, kind: 'symlink' };
  } catch {
    // fall through to a byte comparison
  }
  const same = readFileSync(agentsPath).equals(readFileSync(claudePath));
  return { satisfied: same, kind: same ? 'identical' : 'divergent' };
}

/**
 * Generate (or, with `check`, verify) the whole portable surface.
 *
 * @param {{ pluginRoot: string, check?: boolean }} opts
 * @returns {{ ok: boolean, drift: string[], warnings: string[], written: string[], files: number, bytes: number, skills: string[] }}
 */
export function generateAgentsSurface({ pluginRoot, check = false }) {
  const drift = [];
  const warnings = [];
  const written = [];

  // --- Artefact 1: root AGENTS.md ------------------------------------------
  const claudePath = path.join(pluginRoot, 'CLAUDE.md');
  const agentsPath = path.join(pluginRoot, 'AGENTS.md');
  if (existsSync(claudePath)) {
    const state = agentsMdAliasState(claudePath, agentsPath);
    if (!state.satisfied) {
      if (check) {
        drift.push(state.kind === 'absent'
          ? 'AGENTS.md is missing (foreign harnesses — Codex CLI, OpenCode, Kiro, Amp — read AGENTS.md and never CLAUDE.md)'
          : 'AGENTS.md differs from CLAUDE.md — AGENTS.md is GENERATED; put the change in CLAUDE.md, never in AGENTS.md');
      } else {
        writeFileSync(agentsPath, readFileSync(claudePath));
        written.push('AGENTS.md');
      }
    }
  } else {
    warnings.push('CLAUDE.md not found — AGENTS.md not generated');
  }

  // --- Artefact 2: .agents/skills/<name>/SKILL.md ---------------------------
  const mirrorRoot = path.join(pluginRoot, '.agents', 'skills');
  const skills = listSourceSkills(pluginRoot);
  let files = 0;
  let bytes = 0;

  for (const name of skills) {
    const src = path.join(pluginRoot, 'skills', name, 'SKILL.md');
    const fm = readFrontmatter(src);
    if (fm === null) {
      warnings.push(`${name}: SKILL.md has no parseable frontmatter — skipped`);
      continue;
    }
    const { fm: portable, warnings: w } = toPortableFrontmatter(fm, name);
    warnings.push(...w);
    const rendered = renderMirror(name, portable);
    const dest = path.join(mirrorRoot, name, 'SKILL.md');
    files += 1;
    bytes += Buffer.byteLength(rendered, 'utf8');

    const current = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
    if (current === rendered) continue;
    if (check) {
      drift.push(current === null
        ? `.agents/skills/${name}/SKILL.md is missing`
        : `.agents/skills/${name}/SKILL.md is stale`);
    } else {
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, rendered, 'utf8');
      written.push(`.agents/skills/${name}/SKILL.md`);
    }
  }

  // Orphans: a mirror whose source skill was renamed or removed. Left behind,
  // it advertises a skill no harness can route to.
  if (existsSync(mirrorRoot)) {
    const known = new Set(skills);
    for (const entry of readdirSync(mirrorRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || known.has(entry.name)) continue;
      if (check) {
        drift.push(`.agents/skills/${entry.name}/ is an orphan (no skills/${entry.name}/SKILL.md)`);
      } else {
        rmSync(path.join(mirrorRoot, entry.name), { recursive: true, force: true });
        written.push(`removed .agents/skills/${entry.name}/`);
      }
    }
  }

  return { ok: drift.length === 0, drift, warnings, written, files, bytes, skills };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Resolve the repo root the same way validate-plugin.mjs does. */
function defaultRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function main(argv) {
  const args = { check: false, json: false, pluginRoot: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--plugin-root') args.pluginRoot = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      process.stdout.write('Usage: generate-agents-skills.mjs [--plugin-root <dir>] [--check] [--json]\n');
      return 0;
    }
  }
  const pluginRoot = path.resolve(args.pluginRoot ?? defaultRoot());
  const result = generateAgentsSurface({ pluginRoot, check: args.check });

  if (args.json) {
    process.stdout.write(JSON.stringify({ ...result, plugin_root: pluginRoot }) + '\n');
  } else if (args.check) {
    for (const w of result.warnings) process.stderr.write(`  WARN: agents-surface: ${w}\n`);
    if (result.ok) {
      process.stdout.write(`agents-surface: ${result.files + 1} artefact(s), in sync\n`);
    } else {
      for (const d of result.drift) process.stderr.write(`✗ agents-surface: ${d}\n`);
      process.stderr.write('  Remedy: node scripts/generate-agents-skills.mjs\n');
    }
  } else {
    for (const w of result.warnings) process.stderr.write(`  WARN: agents-surface: ${w}\n`);
    process.stdout.write(
      `agents-surface: ${result.written.length} file(s) written, ${result.files} skill mirror(s), ${result.bytes} bytes\n`,
    );
  }
  return result.ok ? 0 : 1;
}

// realpathSync on both sides: a spawn whose path traverses a symlink (macOS
// /tmp -> /private/tmp) otherwise makes this whole block a silent no-op that
// still exits 0 — the failure mode documented in validate-plugin.mjs.
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
