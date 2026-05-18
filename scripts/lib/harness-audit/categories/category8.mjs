/**
 * category8.mjs — Category 8: Large-Codebase Readiness (weight: 8)
 *
 * Checks (6, max_points sum = 10):
 *   c8.1 layered-claude-md       (max 2)
 *   c8.2 codebase-map-present    (max 2)
 *   c8.3 lsp-configured          (max 2)
 *   c8.4 scoped-test-lint        (max 1)
 *   c8.5 permissions-deny-present(max 1)
 *   c8.6 lean-root               (max 2)
 *
 * Anthropic large-codebase best-practice surface: layered instruction files,
 * a navigable codebase map, language-server tooling, scoped quality commands,
 * version-controlled destructive-command exclusions, and a delegated lean root.
 *
 * status field is only 'pass' / 'fail' — partial tiers emit a reduced-points
 * pass() (there is no 'partial' constructor in helpers.mjs).
 *
 * Stdlib only: node:fs, node:path.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { safeRead, safeJson, pass, fail } from './helpers.mjs';
import { resolveInstructionFile } from '../../common.mjs';

const NESTED_SCAN_MAX_DEPTH = 4;
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'tests', 'fixtures']);

/**
 * Recursively collect nested instruction files (CLAUDE.md / AGENTS.md) whose
 * dirname is NOT root. Excludes node_modules/.git/tests/fixtures by
 * path-relative-to-root segment. Depth-bounded (≤ 4).
 *
 * @returns {string[]} repo-relative paths of nested instruction files
 */
function collectNestedInstructionFiles(root) {
  const found = [];

  function walk(absDir, relParts, depth) {
    if (depth > NESTED_SCAN_MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (EXCLUDED_DIRS.has(ent.name)) continue;
        walk(join(absDir, ent.name), [...relParts, ent.name], depth + 1);
      } else if (ent.isFile() && (ent.name === 'CLAUDE.md' || ent.name === 'AGENTS.md')) {
        // dirname !== root  →  must be nested (relParts non-empty)
        if (relParts.length > 0) {
          found.push([...relParts, ent.name].join('/'));
        }
      }
    }
  }

  walk(root, [], 0);
  return found;
}

export function runCategory8(root) {
  const checks = [];

  // Compute the nested instruction-file list ONCE; shared by c8.1 and c8.4.
  const nestedFiles = collectNestedInstructionFiles(root);
  const nestedContents = nestedFiles.map((rel) => ({
    rel,
    text: safeRead(join(root, rel)),
  }));

  // c8.1 layered-claude-md (max 2)
  {
    const checkId = 'layered-claude-md';
    if (nestedFiles.length === 0) {
      checks.push(fail({
        checkId, maxPoints: 2, path: '.',
        evidence: { nestedFiles: [], withMarker: false },
        message: 'no nested CLAUDE.md/AGENTS.md found (excluding node_modules/.git/tests/fixtures)',
      }));
    } else {
      const markerRe = /(^|\n)## |convention|test|lint|command/i;
      const withMarker = nestedContents.some((f) => f.text && markerRe.test(f.text));
      if (withMarker) {
        checks.push(pass({
          checkId, points: 2, maxPoints: 2, path: nestedFiles[0],
          evidence: { nestedFiles, withMarker: true },
          message: `${nestedFiles.length} nested instruction file(s), ≥1 with a structural/convention marker`,
        }));
      } else {
        checks.push(pass({
          checkId, points: 1, maxPoints: 2, path: nestedFiles[0],
          evidence: { nestedFiles, withMarker: false },
          message: `${nestedFiles.length} nested instruction file(s) but none contains a structural/convention marker`,
        }));
      }
    }
  }

  // c8.2 codebase-map-present (max 2)
  {
    const checkId = 'codebase-map-present';
    const candidates = [
      '.orchestrator/steering/structure.md',
      'docs/architecture.md',
      'docs/ARCHITECTURE.md',
      'ARCHITECTURE.md',
      'docs/codebase-map.md',
    ];
    let matched = null;
    let matchedText = null;
    for (const rel of candidates) {
      const text = safeRead(join(root, rel));
      if (text !== null) {
        matched = rel;
        matchedText = text;
        break;
      }
    }
    if (matched === null) {
      checks.push(fail({
        checkId, maxPoints: 2, path: candidates[0],
        evidence: { matched: null, lineCount: 0 },
        message: `no codebase map found (looked for: ${candidates.join(', ')})`,
      }));
    } else {
      const lc = matchedText.split('\n').length;
      if (lc >= 10) {
        checks.push(pass({
          checkId, points: 2, maxPoints: 2, path: matched,
          evidence: { matched, lineCount: lc },
          message: `${matched} present (${lc} lines, ≥ 10)`,
        }));
      } else {
        checks.push(fail({
          checkId, maxPoints: 2, path: matched,
          evidence: { matched, lineCount: lc },
          message: `${matched} present but only ${lc} lines (< 10)`,
        }));
      }
    }
  }

  // c8.3 lsp-configured (max 2)
  {
    const checkId = 'lsp-configured';
    const mcpRel = '.mcp.json';
    const mcpJson = safeJson(safeRead(join(root, mcpRel)));
    const lspRe = /serena|language[- ]?server|lsp|pyright|typescript-language-server/i;
    let mcpMatch = false;
    if (mcpJson && mcpJson.mcpServers && typeof mcpJson.mcpServers === 'object') {
      for (const [key, srv] of Object.entries(mcpJson.mcpServers)) {
        const command = srv && typeof srv.command === 'string' ? srv.command : '';
        const args = srv && Array.isArray(srv.args) ? srv.args.join(' ') : '';
        if (lspRe.test(key) || lspRe.test(command) || lspRe.test(args)) {
          mcpMatch = true;
          break;
        }
      }
    }
    if (mcpMatch) {
      checks.push(pass({
        checkId, points: 2, maxPoints: 2, path: mcpRel,
        evidence: { mcpConfigured: true, docFallback: false },
        message: '.mcp.json declares a language-server / LSP MCP server',
      }));
    } else {
      // partial tier: a doc references a language server / LSP
      const docCandidates = ['docs/lsp.md', '.claude/rules/lsp.md'];
      const globDirs = [
        { dir: '.claude/rules', ext: '.md' },
        { dir: 'docs', ext: '.md' },
      ];
      for (const { dir, ext } of globDirs) {
        let entries;
        try {
          entries = readdirSync(join(root, dir));
        } catch {
          entries = [];
        }
        for (const e of entries) {
          if (e.endsWith(ext)) docCandidates.push(`${dir}/${e}`);
        }
      }
      const docBodyRe = /language server|\bLSP\b/i;
      let docHit = null;
      for (const rel of docCandidates) {
        const text = safeRead(join(root, rel));
        if (text && docBodyRe.test(text)) {
          docHit = rel;
          break;
        }
      }
      if (docHit) {
        checks.push(pass({
          checkId, points: 1, maxPoints: 2, path: docHit,
          evidence: { mcpConfigured: false, docFallback: true },
          message: `no LSP MCP server, but ${docHit} documents a language server / LSP`,
        }));
      } else {
        checks.push(fail({
          checkId, maxPoints: 2, path: mcpRel,
          evidence: { mcpConfigured: false, docFallback: false },
          message: 'no LSP MCP server in .mcp.json and no language-server documentation',
        }));
      }
    }
  }

  // c8.4 scoped-test-lint (max 1)
  {
    const checkId = 'scoped-test-lint';
    const cmdKeyRe = /(test|lint)[- ]?command\s*:/i;
    const tokenRe = /\b(npm|pnpm|vitest|eslint)\b/i;
    const headingRe = /(^|\n)## /;
    const testLintTokenRe = /\b(test|lint)\b/i;
    const scoped = nestedContents.some((f) => {
      if (!f.text) return false;
      if (cmdKeyRe.test(f.text)) return true;
      // an npm/pnpm/vitest/eslint test|lint token co-located with a '## ' heading
      return headingRe.test(f.text) && tokenRe.test(f.text) && testLintTokenRe.test(f.text);
    });
    if (scoped) {
      checks.push(pass({
        checkId, points: 1, maxPoints: 1, path: nestedFiles[0] ?? '.',
        evidence: { nestedFiles, scoped: true },
        message: 'a nested instruction file declares a scoped test/lint command',
      }));
    } else {
      checks.push(fail({
        checkId, maxPoints: 1, path: nestedFiles[0] ?? '.',
        evidence: { nestedFiles, scoped: false },
        message: 'no nested instruction file declares a scoped test/lint command',
      }));
    }
  }

  // c8.5 permissions-deny-present
  //
  // CROSS-REFERENCE — NOT a duplicate of repo-audit Category 1.
  // skills/repo-audit/SKILL.md:52 checks only that `.claude/settings.json`
  // EXISTS (`ls .claude/settings.json`, pass/fail). This check scores the
  // `permissions.deny` ARRAY specifically: present AND non-empty. The two are
  // orthogonal — repo-audit answers "is there a settings file?"; this answers
  // "does it version-control destructive-command exclusions?" (Anthropic
  // large-codebase best-practice: deny-list in VCS). Do NOT fold these; the
  // harness-audit rubric (deterministic, scored) and repo-audit (agent-driven,
  // baseline-compliance) are explicitly distinct surfaces per
  // skills/repo-audit/SKILL.md:14.
  {
    const checkId = 'permissions-deny-present';
    const relPath = '.claude/settings.json';
    const json = safeJson(safeRead(join(root, relPath)));
    const denyArr = json?.permissions?.deny;
    if (Array.isArray(denyArr) && denyArr.length > 0) {
      checks.push(pass({
        checkId, points: 1, maxPoints: 1, path: relPath,
        evidence: { denyCount: denyArr.length },
        message: `.claude/settings.json permissions.deny has ${denyArr.length} entr${denyArr.length === 1 ? 'y' : 'ies'}`,
      }));
    } else {
      checks.push(fail({
        checkId, maxPoints: 1, path: relPath,
        evidence: { denyCount: Array.isArray(denyArr) ? 0 : null },
        message: '.claude/settings.json missing a non-empty permissions.deny array',
      }));
    }
  }

  // c8.6 lean-root (max 2)
  //
  // ORTHOGONALITY TO category6 c6.1 (claude-md-line-count):
  //   c6.1 = single whole-file scalar (lineCount <= 250).
  //   c8.6 = (A) delegation-link presence  AND  (B) per-SECTION max line count <= 60.
  // These disagree on real inputs: a 240-line file with one 200-line monolithic
  // section passes c6.1 but fails c8.6/B; a 300-line file of tight delegated
  // sections fails c6.1 but passes c8.6. Neither predicate computes the metric
  // the other computes. lean-root is a STRUCTURE check, not a SIZE check.
  {
    const checkId = 'lean-root';
    const instr = resolveInstructionFile(root);
    const instrRel = instr ? (instr.kind === 'agents' ? 'AGENTS.md' : 'CLAUDE.md') : 'CLAUDE.md';
    const text = instr ? safeRead(instr.path) : null;
    if (!text) {
      checks.push(fail({
        checkId, maxPoints: 2, path: instrRel,
        evidence: { delegationLink: false, maxSectionLines: 0 },
        message: 'CLAUDE.md (or AGENTS.md alias) missing',
      }));
    } else {
      // Predicate A — at least one markdown link to a delegated doc
      const predicateA = /\]\(([^)]*\/)?(README\.md|AGENTS\.md|[^)]*CLAUDE\.md|\.orchestrator\/steering\/[^)]+\.md|skills\/_shared\/[^)]+\.md)/.test(text);
      // Predicate B — split on '## ' headings, max section line count ≤ 60
      const sections = text.split(/^## /m);
      let maxSectionLines = 0;
      for (const sec of sections) {
        const lines = sec.split('\n').length;
        if (lines > maxSectionLines) maxSectionLines = lines;
      }
      const predicateB = maxSectionLines <= 60;
      if (predicateA && predicateB) {
        checks.push(pass({
          checkId, points: 2, maxPoints: 2, path: instrRel,
          evidence: { delegationLink: true, maxSectionLines },
          message: `${instrRel} delegates via links and every section ≤ 60 lines (max ${maxSectionLines})`,
        }));
      } else if (predicateA) {
        checks.push(pass({
          checkId, points: 1, maxPoints: 2, path: instrRel,
          evidence: { delegationLink: true, maxSectionLines },
          message: `${instrRel} delegates via links but a section exceeds 60 lines (max ${maxSectionLines})`,
        }));
      } else {
        checks.push(fail({
          checkId, maxPoints: 2, path: instrRel,
          evidence: { delegationLink: false, maxSectionLines },
          message: `${instrRel} has no delegation links to README/AGENTS/CLAUDE/steering/_shared docs`,
        }));
      }
    }
  }

  return checks;
}
