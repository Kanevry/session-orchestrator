#!/usr/bin/env node
/**
 * checker.mjs — CLAUDE.md narrative drift-check (claude-md-drift-check).
 *
 * Eight checks: path-resolver, project-count-sync, issue-reference-freshness,
 * session-file-existence, surface-count (command/skill/agent/hook-event/
 * hook-matcher/test families), session-config-parity, vault-dir-parity.
 * Scans CLAUDE.md + _meta/**\/*.md by default.
 * Emits JSON on stdout. Exit 0 (ok/warn/skip), 1 (hard + errors), 2 (infra).
 *
 * The surface-count family (issue #663) generalizes the original command-count
 * drift check into a parity guard over six artifact surfaces. Each surface
 * derives an ACTUAL on-disk count (glob / hooks.json wiring) and compares it
 * against a CLAIMED count extracted by regex from any scanned doc (README.md,
 * .orchestrator/steering/structure.md, CLAUDE.md). A surface that the doc never
 * claims numerically is skipped gracefully — no claim is ever invented.
 *
 * Reuses `_parseVaultIntegration` from scripts/lib/config/ for Check 7;
 * otherwise pure Node stdlib.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveInstructionFile } from '../../scripts/lib/common.mjs';
import { _parseVaultIntegration } from '../../scripts/lib/config/vault-integration.mjs';

const FORWARD_HEADING_RE =
  /(?:^|\b)(what'?s?\s+next|backlog|open\s+issues?|offene\s+(?:issues?|themen)|todo|next\s+steps?|roadmap)(?:$|\b)/i;
const BACKWARD_HEADING_RE =
  /(?:^|\b)(recently\s+closed|done|closed|archive|history|changelog|decisions?|status|references?)(?:$|\b)/i;

function parseArgs(argv) {
  const out = {
    mode: 'warn',
    includePaths: [],
    skipPathResolver: false,
    skipProjectCount: false,
    skipIssueRefs: false,
    skipSessionFiles: false,
    skipCommandCount: false,
    skipSurfaceCount: false,
    skipSessionConfigParity: false,
    skipVaultDirParity: false,
    repo: null,
    commandsDir: null,
    configTemplate: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') out.mode = argv[++i];
    else if (a === '--include-path') out.includePaths.push(argv[++i]);
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--commands-dir') out.commandsDir = argv[++i];
    else if (a === '--config-template') out.configTemplate = argv[++i];
    else if (a === '--skip-path-resolver') out.skipPathResolver = true;
    else if (a === '--skip-project-count') out.skipProjectCount = true;
    else if (a === '--skip-issue-refs') out.skipIssueRefs = true;
    else if (a === '--skip-session-files') out.skipSessionFiles = true;
    else if (a === '--skip-command-count') out.skipCommandCount = true;
    else if (a === '--skip-surface-count') out.skipSurfaceCount = true;
    else if (a === '--skip-session-config-parity') out.skipSessionConfigParity = true;
    else if (a === '--skip-vault-dir-parity') out.skipVaultDirParity = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write('Usage: checker.mjs [--mode hard|warn|off] [--include-path GLOB]... [--repo OWNER/NAME] [--commands-dir PATH] [--config-template PATH] [--skip-surface-count] [--skip-command-count] [--skip-*]\n');
      process.exit(0);
    } else {
      process.stderr.write(`{"status":"infra-error","reason":"unknown arg: ${a}"}\n`);
      process.exit(2);
    }
  }
  // Defaults for includePaths are seeded post-vaultDir resolution so the
  // instruction file (CLAUDE.md or AGENTS.md alias) can be alias-resolved.
  return out;
}

function resolveScopeFiles(vaultDir, patterns) {
  const files = new Set();
  for (const pattern of patterns) {
    if (pattern.includes('**/')) {
      const [prefix, suffix] = pattern.split('/**/');
      const extMatch = /^\*\.(\w+)$/.exec(suffix || '');
      const ext = extMatch ? `.${extMatch[1]}` : null;
      const dir = join(vaultDir, prefix);
      if (existsSync(dir) && statSync(dir).isDirectory()) {
        walkDir(dir, (f) => {
          if (!ext || f.endsWith(ext)) files.add(f);
        });
      }
    } else {
      const abs = join(vaultDir, pattern);
      if (existsSync(abs) && statSync(abs).isFile()) files.add(abs);
    }
  }
  return Array.from(files).sort();
}

function walkDir(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, visit);
    else if (entry.isFile()) visit(full);
  }
}

/**
 * Extract the YAML block under `## Session Config` from a Markdown document.
 * Tries fenced YAML first (```yaml ... ```), then falls back to raw body up
 * to the next `^## ` heading or EOF.
 *
 * Returns { body: string, headingLine: number } or null when no heading found.
 */
function extractSessionConfigBlock(content) {
  const lines = content.split('\n');
  let headingLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Session Config\b/.test(lines[i])) {
      headingLine = i + 1; // 1-based line number for error reporting
      break;
    }
  }
  if (headingLine === -1) return null;

  // Try fenced YAML first.
  const fenced = content.match(/^## Session Config\s*\n```ya?ml\n([\s\S]*?)\n```/m);
  if (fenced) return { body: fenced[1], headingLine };

  // Fallback: raw body up to next `## ` heading or EOF.
  const startIdx = headingLine; // index *after* heading line (0-based)
  let endIdx = lines.length;
  for (let i = startIdx; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { endIdx = i; break; }
  }
  const body = lines.slice(startIdx, endIdx).join('\n');
  return { body, headingLine };
}

/**
 * Extract top-level YAML keys from a YAML body. Only column-0 keys are
 * collected (indented keys are children and ignored).
 */
function extractTopLevelKeys(body) {
  const keys = [];
  const re = /^([A-Za-z][\w-]*):/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

/**
 * Read a file's `vault-integration` settings for the vault-dir-parity check.
 *
 * Returns `{ present, vaultDir }`:
 *   - `present` is true when the file contains a `vault-integration:` block or
 *     inline-object literal (block-form header `vault-integration:` on its own
 *     line, or `vault-integration: { ... }`), matching the source shapes
 *     `_parseVaultIntegration` recognises.
 *   - `vaultDir` is the parsed `vault-integration.vault-dir` value (null when
 *     unset/absent), produced by reusing `_parseVaultIntegration` rather than
 *     hand-rolling YAML.
 *
 * @param {string} filePath — absolute path to CLAUDE.md / AGENTS.md
 * @returns {{ present: boolean, vaultDir: string|null }}
 */
function readVaultIntegration(filePath) {
  const content = readFileSync(filePath, 'utf8');
  // Detect block-form header (`vault-integration:` alone on a line) or inline
  // object literal (`vault-integration: { ... }`), with or without a list dash.
  const present =
    /^(?:-\s+)?vault-integration:\s*$/m.test(content) ||
    /^(?:-\s+)?vault-integration:\s*\{[^}]*\}\s*(?:#.*)?$/m.test(content);
  const parsed = _parseVaultIntegration(content);
  return { present, vaultDir: parsed['vault-dir'] };
}

function classifySection(heading) {
  if (!heading) return null;
  if (BACKWARD_HEADING_RE.test(heading)) return 'backward';
  if (FORWARD_HEADING_RE.test(heading)) return 'forward';
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Surface-count family (issue #663) — generalizes the original command-count
// drift check. Each surface has:
//   - id:    the check id surfaced in errors[].check and checks_run.
//   - actual(vaultDir): pure function returning the ACTUAL on-disk count, or
//            null when the source artifact is absent (→ surface skipped).
//   - claimRe: a /g/i regex whose capture group 1 is the CLAIMED integer. Only
//            an explicit numeric claim triggers a comparison; surfaces with no
//            matching phrase in any doc are skipped gracefully (requirement #3).
//   - noun:  human label used in the drift message.
// These are EXACT-count drift checks by design — the whole point is catching
// drift, so NO floor/ceiling (see .claude/rules/testing.md "Dynamic Artifact
// Counts" carve-out — this is the explicit exception).
// ───────────────────────────────────────────────────────────────────────────

/** Count `skills/<name>/SKILL.md` directories (excludes `_shared/` which has no SKILL.md). */
function countSkills(vaultDir) {
  const dir = join(vaultDir, 'skills');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillFile = join(dir, entry.name, 'SKILL.md');
    if (existsSync(skillFile) && statSync(skillFile).isFile()) n++;
  }
  return n;
}

/** Count `agents/*.md` definitions, excluding the AGENTS.md authoring spec. */
function countAgents(vaultDir) {
  const dir = join(vaultDir, 'agents');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'AGENTS.md' && !f.startsWith('.'))
    .length;
}

/**
 * Parse `hooks/hooks.json` and return `{ events, matchers }`:
 *   - events:   distinct top-level event names (keys of `.hooks`).
 *   - matchers: total matcher entries across all events (the authoritative
 *               wiring count, not a raw file count).
 * Returns null when hooks.json is absent or unparseable.
 */
function readHookCounts(vaultDir) {
  const file = join(vaultDir, 'hooks', 'hooks.json');
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const hooks = json && json.hooks;
  if (!hooks || typeof hooks !== 'object') return null;
  const events = Object.keys(hooks);
  let matchers = 0;
  for (const ev of events) {
    if (Array.isArray(hooks[ev])) matchers += hooks[ev].length;
  }
  return { events: events.length, matchers };
}

/** Count test files (`*.test.mjs`) under `tests/`. */
function countTestFiles(vaultDir) {
  const dir = join(vaultDir, 'tests');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  let n = 0;
  walkDir(dir, (f) => { if (f.endsWith('.test.mjs')) n++; });
  return n;
}

/**
 * Build the surface-count descriptor table for the given vault. `hookCounts`
 * is computed once and shared by the two hook surfaces. Each descriptor's
 * `actual` is resolved eagerly so a single drift pass can skip null surfaces.
 *
 * `command-count` keeps its original id + message phrasing for back-compat with
 * the result.command_count field and existing tests; the four new surfaces
 * follow the same shape.
 */
function buildSurfaceDescriptors(vaultDir, commandsDir) {
  const hookCounts = readHookCounts(vaultDir);
  return [
    {
      id: 'command-count',
      noun: 'commands',
      actual: (() => {
        const dir = commandsDir || join(vaultDir, 'commands');
        if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
        return readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('.')).length;
      })(),
      // "8 commands", "8 /commands", "8 slash commands"
      claimRe: /\b(\d+)\s+(?:\/)?commands?\b/gi,
      skipMsg: 'command-count: no commands/ directory found (use --commands-dir to override)',
    },
    {
      id: 'skill-count',
      noun: 'skills',
      actual: countSkills(vaultDir),
      // "40 skills", "40 user-facing skills"
      claimRe: /\b(\d+)\s+(?:user-facing\s+)?skills?\b/gi,
      skipMsg: 'skill-count: no skills/ directory found',
    },
    {
      id: 'agent-count',
      noun: 'agents',
      actual: countAgents(vaultDir),
      // "14 sub-agent definitions" / "14 sub-agents" / "14 agent definitions"
      // Deliberately NOT matched: "3 agent role definitions" (Codex-specific).
      claimRe: /\b(\d+)\s+(?:sub-agents?|agent\s+definitions?)\b/gi,
      skipMsg: 'agent-count: no agents/ directory found',
    },
    {
      id: 'hook-event-count',
      noun: 'distinct hook events',
      actual: hookCounts ? hookCounts.events : null,
      // "10 distinct events"
      claimRe: /\b(\d+)\s+distinct\s+events?\b/gi,
      skipMsg: 'hook-event-count: no hooks/hooks.json found or unparseable',
    },
    {
      id: 'hook-matcher-count',
      noun: 'hook matcher entries',
      actual: hookCounts ? hookCounts.matchers : null,
      // "14 matcher entries"
      claimRe: /\b(\d+)\s+matcher\s+entries\b/gi,
      skipMsg: 'hook-matcher-count: no hooks/hooks.json found or unparseable',
    },
    {
      id: 'test-count',
      noun: 'test files',
      actual: countTestFiles(vaultDir),
      // "N test files" — the README badge claims a runtime PASS count
      // ("9303 tests"), which a static checker cannot derive, so we match only
      // the explicit file-count phrasing. No doc claims this today → skipped.
      claimRe: /\b(\d+)\s+test\s+files?\b/gi,
      skipMsg: 'test-count: no tests/ directory found',
    },
  ];
}

const REPO_SHAPE_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;

function detectRepo(vaultDir) {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: vaultDir, encoding: 'utf8' }).trim();
  const m = /[:/]([^:/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(url);
  const candidate = m ? m[1] : null;
  return candidate && REPO_SHAPE_RE.test(candidate) ? candidate : null;
}

function hasGlab() {
  try {
    execFileSync('sh', ['-c', 'command -v glab'], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function lookupIssueState(iid, repo, cache) {
  if (cache.has(iid)) return cache.get(iid);
  let state = 'unknown';
  try {
    const out = execFileSync('glab', ['issue', 'view', iid, '--repo', repo], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const m = /^state:\s*(open|closed)/im.exec(out);
    if (m) state = m[1];
  } catch { /* glab returned non-zero — leave as unknown */ }
  cache.set(iid, state);
  return state;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const vaultDir = resolve(process.env.VAULT_DIR || process.cwd());

  if (!['hard', 'warn', 'off'].includes(args.mode)) {
    process.stderr.write(`{"status":"infra-error","reason":"invalid --mode: ${args.mode}"}\n`);
    process.exit(2);
  }

  // Alias-aware instruction file resolution (issue #33).
  // CLAUDE.md (Claude Code / Cursor IDE) and AGENTS.md (Codex CLI) are
  // transparent aliases — see skills/_shared/instruction-file-resolution.md.
  const instr = resolveInstructionFile(vaultDir); // {path, kind} | null
  const resolvedPath = instr ? instr.path : null;
  const resolvedKind = instr ? instr.kind : null;

  if (args.mode === 'off') {
    process.stdout.write(JSON.stringify({
      status: 'skipped-mode-off', mode: 'off', vault_dir: vaultDir,
      resolved_path: resolvedPath, resolved_kind: resolvedKind,
    }) + '\n');
    process.exit(0);
  }

  if (!existsSync(vaultDir) || !statSync(vaultDir).isDirectory()) {
    process.stderr.write(`{"status":"infra-error","reason":"VAULT_DIR does not exist: ${vaultDir}"}\n`);
    process.exit(2);
  }

  // Seed default includePaths post-vaultDir resolution (alias-aware).
  if (args.includePaths.length === 0) {
    args.includePaths = [
      ...(instr ? [relative(vaultDir, instr.path)] : []),
      '_meta/**/*.md',
    ];
  }

  const scopeFiles = resolveScopeFiles(vaultDir, args.includePaths);
  const checksSkipped = [];

  let actualProjectCount = null;
  if (!args.skipProjectCount) {
    const projectsDir = join(vaultDir, '01-projects');
    if (existsSync(projectsDir) && statSync(projectsDir).isDirectory()) {
      actualProjectCount = readdirSync(projectsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
        .length;
    } else {
      checksSkipped.push('project-count-sync: no 01-projects/ directory at vault root');
    }
  }

  // Check 5: surface-count family (command/skill/agent/hook-event/hook-matcher/
  // test). Each surface derives an ACTUAL on-disk count and compares it to a
  // CLAIMED count regex-extracted from any scanned doc. Surfaces whose source
  // artifact is absent (actual === null) are skipped; surfaces the doc never
  // claims are skipped per-line in the scan loop (no claim invented).
  // `--skip-surface-count` disables the whole family; `--skip-command-count`
  // remains a back-compat alias that disables only the command-count surface.
  const commandsDir = args.commandsDir ? resolve(args.commandsDir) : null;
  let surfaces = [];
  if (!args.skipSurfaceCount) {
    surfaces = buildSurfaceDescriptors(vaultDir, commandsDir);
    if (args.skipCommandCount) {
      surfaces = surfaces.filter((s) => s.id !== 'command-count');
    }
    for (const s of surfaces) {
      if (s.actual === null) checksSkipped.push(s.skipMsg);
    }
  }
  // Active surfaces = family enabled AND source artifact present on disk.
  const activeSurfaces = surfaces.filter((s) => s.actual !== null);
  // Back-compat: the command-count surface's actual feeds result.command_count.
  const commandSurface = activeSurfaces.find((s) => s.id === 'command-count');
  const actualCommandCount = commandSurface ? commandSurface.actual : null;

  let repo = args.repo;
  const glabPresent = !args.skipIssueRefs && hasGlab();
  if (!args.skipIssueRefs && !glabPresent) {
    checksSkipped.push('issue-reference-freshness: glab not found in PATH');
  }
  if (!args.skipIssueRefs && glabPresent && !repo) {
    try { repo = detectRepo(vaultDir); } catch { /* ignore */ }
    if (!repo) checksSkipped.push('issue-reference-freshness: could not detect origin repo (use --repo)');
  }
  const runIssueCheck = !args.skipIssueRefs && glabPresent && !!repo;

  const checksRun = [];
  if (!args.skipPathResolver) checksRun.push('path-resolver');
  if (!args.skipProjectCount && actualProjectCount !== null) checksRun.push('project-count-sync');
  if (runIssueCheck) checksRun.push('issue-reference-freshness');
  if (!args.skipSessionFiles) checksRun.push('session-file-existence');
  for (const s of activeSurfaces) checksRun.push(s.id);

  const errors = [];
  const warnings = [];
  const issueCache = new Map();

  // Check 6: session-config-parity (issue #30) — diff top-level keys under
  // `## Session Config` between the canonical template and the local
  // instruction file. Surface missing keys as parity errors.
  let configParityRan = false;
  if (!args.skipSessionConfigParity) {
    const templatePath = args.configTemplate
      ? resolve(args.configTemplate)
      : join(vaultDir, 'docs', 'session-config-template.md');
    if (!instr) {
      checksSkipped.push('session-config-parity: no instruction file');
    } else if (!existsSync(templatePath) || !statSync(templatePath).isFile()) {
      checksSkipped.push('session-config-parity: no docs/session-config-template.md found');
    } else {
      const templateContent = readFileSync(templatePath, 'utf8');
      const localContent = readFileSync(instr.path, 'utf8');
      const tplBlock = extractSessionConfigBlock(templateContent);
      const localBlock = extractSessionConfigBlock(localContent);
      if (!tplBlock) {
        checksSkipped.push('session-config-parity: template has no ## Session Config block');
      } else if (!localBlock) {
        // Treat absent local block as "every template key missing".
        configParityRan = true;
        const tplKeys = extractTopLevelKeys(tplBlock.body);
        const rel = relative(vaultDir, instr.path);
        for (const key of tplKeys) {
          errors.push({
            check: 'session-config-parity', file: rel, line: 1,
            message: `Session Config missing top-level key '${key}' (present in docs/session-config-template.md)`,
            extracted: key,
          });
        }
      } else {
        configParityRan = true;
        const tplKeys = extractTopLevelKeys(tplBlock.body);
        const localKeys = new Set(extractTopLevelKeys(localBlock.body));
        const missing = tplKeys.filter((k) => !localKeys.has(k));
        const rel = relative(vaultDir, instr.path);
        for (const key of missing) {
          errors.push({
            check: 'session-config-parity', file: rel, line: localBlock.headingLine,
            message: `Session Config missing top-level key '${key}' (present in docs/session-config-template.md)`,
            extracted: key,
          });
        }
      }
    }
  } else {
    checksSkipped.push('session-config-parity: explicitly skipped');
  }
  if (configParityRan) checksRun.push('session-config-parity');

  // Check 7: vault-dir-parity (issue #600) — when BOTH instruction files
  // (CLAUDE.md AND AGENTS.md) exist as transparent aliases, they must agree on
  // `vault-integration.vault-dir`. A sibling project carried a dead vault-dir in
  // AGENTS.md for weeks while CLAUDE.md was correct; resolveInstructionFile()
  // picks only one file, so the disagreement went undetected. This check reads
  // both files independently and flags any divergence.
  let vaultDirParityRan = false;
  if (!args.skipVaultDirParity) {
    const claudePath = join(vaultDir, 'CLAUDE.md');
    const agentsPath = join(vaultDir, 'AGENTS.md');
    const claudeExists = existsSync(claudePath) && statSync(claudePath).isFile();
    const agentsExists = existsSync(agentsPath) && statSync(agentsPath).isFile();

    if (!claudeExists || !agentsExists) {
      checksSkipped.push('vault-dir-parity: requires both CLAUDE.md and AGENTS.md (only one present)');
    } else {
      const claudeVi = readVaultIntegration(claudePath);
      const agentsVi = readVaultIntegration(agentsPath);
      if (!claudeVi.present && !agentsVi.present) {
        checksSkipped.push('vault-dir-parity: neither file has a vault-integration: block');
      } else {
        vaultDirParityRan = true;
        const claudeDir = claudeVi.vaultDir;
        const agentsDir = agentsVi.vaultDir;
        if (claudeDir !== agentsDir) {
          errors.push({
            check: 'vault-dir-parity', file: 'AGENTS.md', line: 1,
            message: `vault-integration.vault-dir disagrees between instruction files: CLAUDE.md='${claudeDir ?? '(unset)'}' vs AGENTS.md='${agentsDir ?? '(unset)'}'`,
            extracted: agentsDir ?? '(unset)',
          });
        }
      }
    }
  } else {
    checksSkipped.push('vault-dir-parity: explicitly skipped');
  }
  if (vaultDirParityRan) checksRun.push('vault-dir-parity');

  if (scopeFiles.length === 0) {
    process.stdout.write(JSON.stringify({
      status: 'skipped', mode: args.mode, vault_dir: vaultDir,
      resolved_path: resolvedPath, resolved_kind: resolvedKind,
      files_scanned: 0, checks_run: checksRun, checks_skipped: checksSkipped,
      errors, warnings, reason: 'no scope files matched',
    }) + '\n');
    process.exit(errors.length > 0 && args.mode === 'hard' ? 1 : 0);
  }

  for (const abs of scopeFiles) {
    const rel = relative(vaultDir, abs);
    const content = readFileSync(abs, 'utf8');
    const lines = content.split('\n');

    let inFence = false;
    let currentSection = null;
    let currentSectionType = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (/^\s*```/.test(line)) { inFence = !inFence; continue; }

      const hmatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (hmatch && !inFence) {
        currentSection = hmatch[2];
        currentSectionType = classifySection(currentSection);
        continue;
      }

      if (!args.skipPathResolver && !inFence) {
        const pathRegex = /\/Users\/[A-Za-z0-9._/-]+/g;
        let m;
        while ((m = pathRegex.exec(line)) !== null) {
          const p = m[0].replace(/[.,;:)\]`"']+$/, '');
          if (!existsSync(p)) {
            errors.push({
              check: 'path-resolver', file: rel, line: lineNum,
              message: `Absolute path does not exist: ${p}`,
              extracted: p,
            });
          }
        }
      }

      if (!args.skipProjectCount && actualProjectCount !== null) {
        const countRegex = /\((\d+)\s+(registered|projects?|subfolders?)\)/gi;
        let m;
        while ((m = countRegex.exec(line)) !== null) {
          const claimed = parseInt(m[1], 10);
          if (claimed !== actualProjectCount) {
            errors.push({
              check: 'project-count-sync', file: rel, line: lineNum,
              message: `Hardcoded count claims ${claimed} ${m[2]} but actual 01-projects/ count is ${actualProjectCount}`,
              extracted: m[0],
            });
          }
        }
      }

      if (runIssueCheck && currentSectionType === 'forward' && !inFence) {
        const issueRegex = /#(\d+)\b/g;
        let m;
        while ((m = issueRegex.exec(line)) !== null) {
          const iid = m[1];
          const state = lookupIssueState(iid, repo, issueCache);
          if (state === 'closed') {
            errors.push({
              check: 'issue-reference-freshness', file: rel, line: lineNum,
              message: `Issue #${iid} is closed but referenced in forward-looking section "${currentSection}"`,
              extracted: `#${iid}`,
            });
          } else if (state === 'unknown') {
            warnings.push({
              check: 'issue-reference-freshness', file: rel, line: lineNum,
              message: `Could not resolve state of issue #${iid} via glab (may not exist or auth issue)`,
              extracted: `#${iid}`,
            });
          }
        }
      }

      if (!args.skipSessionFiles) {
        const sessionRegex = /50-sessions\/(\d{4}-\d{2}-\d{2}-[a-z0-9-]+)\.md/g;
        let m;
        while ((m = sessionRegex.exec(line)) !== null) {
          const sessPath = join(vaultDir, '50-sessions', `${m[1]}.md`);
          if (!existsSync(sessPath)) {
            errors.push({
              check: 'session-file-existence', file: rel, line: lineNum,
              message: `Referenced session file does not exist: 50-sessions/${m[1]}.md`,
              extracted: m[0],
            });
          }
        }
      }

      // Surface-count family: one EXACT-count drift check per active surface.
      // A surface only fires when the doc makes an explicit numeric claim that
      // its regex matches; an unclaimed surface produces no errors (skip).
      for (const surface of activeSurfaces) {
        const re = surface.claimRe;
        re.lastIndex = 0; // reset shared /g/ regex before each line
        let m;
        while ((m = re.exec(line)) !== null) {
          const claimed = parseInt(m[1], 10);
          if (claimed !== surface.actual) {
            const err = {
              check: surface.id, file: rel, line: lineNum,
              message: `Narrative claims ${claimed} ${surface.noun} but actual on-disk count is ${surface.actual}`,
              extracted: m[0],
              count: { surface: surface.id, actual: surface.actual, claimed },
            };
            // Back-compat: the original command-count error also carried a
            // top-level `command_count` field; preserve it.
            if (surface.id === 'command-count') {
              err.command_count = { actual: surface.actual, claimed };
            }
            errors.push(err);
          }
        }
      }
    }
  }

  const status = errors.length === 0 ? 'ok' : 'invalid';
  const result = {
    status, mode: args.mode, vault_dir: vaultDir,
    resolved_path: resolvedPath, resolved_kind: resolvedKind,
    files_scanned: scopeFiles.length,
    checks_run: checksRun,
    checks_skipped: checksSkipped,
    errors, warnings,
  };
  if (actualCommandCount !== null) {
    result.command_count = { actual: actualCommandCount };
  }
  process.stdout.write(JSON.stringify(result) + '\n');

  process.exit(errors.length > 0 && args.mode === 'hard' ? 1 : 0);
}

main();
