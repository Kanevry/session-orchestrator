/**
 * tests/lib/validate/dead-bridge-detectors.test.mjs
 *
 * Unit tests for scripts/lib/validate/dead-bridge-detectors.mjs (#671).
 *
 * The detectors are PURE: all filesystem access is injected via a RepoContext
 * ({ pluginRoot, listMdFiles, listFiles, readText, exists }). These tests build
 * an IN-MEMORY fake ctx from a {absPath: content} map + a set of existing dir
 * paths — no disk fixtures needed. Each Finding is
 * { rule, severity:'fail', file, line, message }.
 *
 * Coverage:
 *   - detectDanglingReferences — all 3 sub-rules (positive + negative each):
 *       dangling-subagent-type, dangling-rule-reference, dangling-bootstrap-bridge
 *   - unified ignore marker (check-dead-bridge:ignore)
 *   - tool-error surfacing (missing required dir → *-tool-error finding)
 *   - detectBridgeBalance — set-never-read / read-never-set / balanced /
 *     both-zero / empty
 *   - DETECTORS registry shape
 */

import { describe, it, expect } from 'vitest';
import {
  detectDanglingReferences,
  detectBridgeBalance,
  DETECTORS,
} from '@lib/validate/dead-bridge-detectors.mjs';

// ---------------------------------------------------------------------------
// In-memory fake RepoContext.
//
// `files`  — { absPath: content } map. readText throws ENOENT for unknown
//            paths (so countMatches' file-vs-dir probe falls through correctly).
// `dirs`   — extra directory paths that exists() reports true for (files imply
//            existence too).
// listMdFiles / listFiles emulate the real recursive walk by prefix-matching
// absDir + '/'.
// ---------------------------------------------------------------------------

const ROOT = '/plugin';

function makeCtx({ files = {}, dirs = [] } = {}) {
  const fileSet = new Set(Object.keys(files));
  const dirSet = new Set(dirs);
  return {
    pluginRoot: ROOT,
    listMdFiles: (absDir) =>
      Object.keys(files).filter((f) => f.startsWith(`${absDir}/`) && f.endsWith('.md')),
    listFiles: (absDir, exts) =>
      Object.keys(files).filter(
        (f) => f.startsWith(`${absDir}/`) && exts.some((e) => f.endsWith(e)),
      ),
    readText: (absPath) => {
      if (!fileSet.has(absPath)) throw new Error(`ENOENT: ${absPath}`);
      return files[absPath];
    },
    exists: (absPath) => fileSet.has(absPath) || dirSet.has(absPath),
  };
}

// A bootstrap file with a VALID guard whose target exists — satisfies the
// dangling-bootstrap-bridge requireAtLeastOne invariant so that sub-rule
// contributes ZERO findings, letting the other sub-rules be tested in isolation.
function withValidBootstrap(files = {}, dirs = []) {
  return {
    files: {
      ...files,
      '/plugin/skills/bootstrap/SKILL.md': '[ -f "$PLUGIN_ROOT/scripts/lib/fetch-baseline.mjs" ]',
      '/plugin/scripts/lib/fetch-baseline.mjs': '// baseline fetcher',
    },
    dirs: ['/plugin/skills', '/plugin/.claude/rules', '/plugin/skills/bootstrap', ...dirs],
  };
}

const findingsFor = (out, rule) => out.filter((f) => f.rule === rule);

// ---------------------------------------------------------------------------
// Sub-rule 1 — dangling-subagent-type
// ---------------------------------------------------------------------------

describe('detectDanglingReferences — dangling-subagent-type', () => {
  it('flags exactly one finding when a subagent_type names a non-existent agent', () => {
    const ctx = makeCtx(
      withValidBootstrap({
        '/plugin/skills/wave/SKILL.md': 'subagent_type: "session-orchestrator:ghost-agent-xyz"',
      }),
    );

    const found = findingsFor(detectDanglingReferences(ctx), 'dangling-subagent-type');

    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('fail');
    expect(found[0].file).toBe('/plugin/skills/wave/SKILL.md');
    expect(found[0].line).toBe(1);
    expect(found[0].message).toContain('agents/ghost-agent-xyz.md');
    expect(found[0].message).toContain('NOT FOUND');
  });

  it('produces zero findings when the subagent_type resolves to an existing agent', () => {
    const ctx = makeCtx(
      withValidBootstrap({
        '/plugin/skills/wave/SKILL.md': 'subagent_type: "session-orchestrator:code-implementer"',
        '/plugin/agents/code-implementer.md': '# code-implementer',
      }),
    );

    const found = findingsFor(detectDanglingReferences(ctx), 'dangling-subagent-type');

    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sub-rule 2 — dangling-rule-reference
// ---------------------------------------------------------------------------

describe('detectDanglingReferences — dangling-rule-reference', () => {
  it('flags exactly one finding when a See-Also footer cites a missing sibling rule', () => {
    const ctx = makeCtx(
      withValidBootstrap({
        '/plugin/.claude/rules/a.md': '## See Also\nfoo · ghost-rule-xyz.md · bar',
      }),
    );

    const found = findingsFor(detectDanglingReferences(ctx), 'dangling-rule-reference');

    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('fail');
    expect(found[0].file).toBe('/plugin/.claude/rules/a.md');
    expect(found[0].message).toContain('ghost-rule-xyz.md');
    expect(found[0].message).toContain('NOT FOUND in .claude/rules/');
  });

  it('produces zero findings when the See-Also footer cites an existing sibling rule', () => {
    const ctx = makeCtx(
      withValidBootstrap({
        '/plugin/.claude/rules/a.md': '## See Also\nfoo · security.md · bar',
        '/plugin/.claude/rules/security.md': '# security',
      }),
    );

    const found = findingsFor(detectDanglingReferences(ctx), 'dangling-rule-reference');

    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sub-rule 3 — dangling-bootstrap-bridge
// ---------------------------------------------------------------------------

describe('detectDanglingReferences — dangling-bootstrap-bridge', () => {
  it('flags at least one finding when a guard points at a non-existent fetch-baseline file', () => {
    // The guard targets fetch-baseline.sh which does NOT exist (only .mjs ships
    // after the rename). This trips both the dangling-guard check AND the stale
    // .sh basename check — both are dangling-bootstrap-bridge findings.
    const ctx = makeCtx({
      files: {
        '/plugin/skills/bootstrap/SKILL.md': '[ -f "$PLUGIN_ROOT/scripts/lib/fetch-baseline.sh" ]',
      },
      dirs: ['/plugin/skills', '/plugin/.claude/rules', '/plugin/skills/bootstrap'],
    });

    const found = findingsFor(detectDanglingReferences(ctx), 'dangling-bootstrap-bridge');

    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0].severity).toBe('fail');
    expect(found[0].file).toBe('/plugin/skills/bootstrap/SKILL.md');
    expect(found.some((f) => f.message.includes('fetch-baseline.sh'))).toBe(true);
  });

  it('produces zero findings when the guard targets an existing fetch-baseline.mjs', () => {
    const ctx = makeCtx({
      files: {
        '/plugin/skills/bootstrap/SKILL.md': '[ -f "$PLUGIN_ROOT/scripts/lib/fetch-baseline.mjs" ]',
        '/plugin/scripts/lib/fetch-baseline.mjs': '// baseline fetcher',
      },
      dirs: ['/plugin/skills', '/plugin/.claude/rules', '/plugin/skills/bootstrap'],
    });

    const found = findingsFor(detectDanglingReferences(ctx), 'dangling-bootstrap-bridge');

    expect(found).toEqual([]);
  });

  it('flags a requireAtLeastOne finding when no fetch-baseline guard exists anywhere', () => {
    // A bootstrap file with NO guard reference at all → the on-demand
    // baseline-fetch bridge lost its guard entirely (dead bridge).
    const ctx = makeCtx({
      files: {
        '/plugin/skills/bootstrap/SKILL.md': '# bootstrap with no guard references',
      },
      dirs: ['/plugin/skills', '/plugin/.claude/rules', '/plugin/skills/bootstrap'],
    });

    const found = findingsFor(detectDanglingReferences(ctx), 'dangling-bootstrap-bridge');

    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('no fetch-baseline guard reference found');
  });
});

// ---------------------------------------------------------------------------
// Unified ignore marker — check-dead-bridge:ignore
// ---------------------------------------------------------------------------

describe('detectDanglingReferences — unified ignore marker', () => {
  it('suppresses an otherwise-dangling subagent ref on a line carrying check-dead-bridge:ignore', () => {
    const ctx = makeCtx(
      withValidBootstrap({
        '/plugin/skills/wave/SKILL.md':
          'subagent_type: "session-orchestrator:ghost-xyz" <!-- check-dead-bridge:ignore -->',
      }),
    );

    const out = detectDanglingReferences(ctx);

    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tool-error — missing required directory
// ---------------------------------------------------------------------------

describe('detectDanglingReferences — tool-error surfacing', () => {
  it('returns a *-tool-error finding when the required .claude/rules dir is missing', () => {
    // skills/ + bootstrap/ present with a valid guard, but NO .claude/rules dir.
    const ctx = makeCtx({
      files: {
        '/plugin/skills/wave/SKILL.md': '# no refs here',
        '/plugin/skills/bootstrap/SKILL.md': '[ -f "$PLUGIN_ROOT/scripts/lib/fetch-baseline.mjs" ]',
        '/plugin/scripts/lib/fetch-baseline.mjs': '// baseline fetcher',
      },
      dirs: ['/plugin/skills', '/plugin/skills/bootstrap'],
    });

    const out = detectDanglingReferences(ctx);
    const toolErrors = out.filter((f) => f.rule.endsWith('-tool-error'));

    expect(toolErrors).toHaveLength(1);
    expect(toolErrors[0].rule).toBe('dangling-rule-reference-tool-error');
    expect(toolErrors[0].message).toContain('rules directory not found');
  });
});

// ---------------------------------------------------------------------------
// detectBridgeBalance — the NEW dead-bridge class
// ---------------------------------------------------------------------------

describe('detectBridgeBalance', () => {
  // A ctx with one producer file and one consumer file, both containing TOKEN.
  const bridgeCtx = () =>
    makeCtx({
      files: {
        '/plugin/prod.md': 'TOKEN appears here',
        '/plugin/cons.mjs': 'const x = "TOKEN";',
      },
    });

  it('flags set-but-never-read when producer matches but consumer is zero', () => {
    const bridges = [
      {
        id: 'orphan-set',
        producer: { pattern: 'TOKEN', scope: ['prod.md'], exts: ['md'] },
        consumer: { pattern: 'TOKEN', scope: ['missing.mjs'], exts: ['mjs'] },
      },
    ];

    const found = detectBridgeBalance(bridgeCtx(), bridges);

    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe('bridge-balance');
    expect(found[0].severity).toBe('fail');
    expect(found[0].message).toContain('set but never read');
  });

  it('flags read-but-never-set when consumer matches but producer is zero', () => {
    const bridges = [
      {
        id: 'orphan-read',
        producer: { pattern: 'TOKEN', scope: ['missing.md'], exts: ['md'] },
        consumer: { pattern: 'TOKEN', scope: ['cons.mjs'], exts: ['mjs'] },
      },
    ];

    const found = detectBridgeBalance(bridgeCtx(), bridges);

    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe('bridge-balance');
    expect(found[0].message).toContain('read but never set');
  });

  it('produces zero findings when both sides have matches (balanced)', () => {
    const bridges = [
      {
        id: 'balanced',
        producer: { pattern: 'TOKEN', scope: ['prod.md'], exts: ['md'] },
        consumer: { pattern: 'TOKEN', scope: ['cons.mjs'], exts: ['mjs'] },
      },
    ];

    expect(detectBridgeBalance(bridgeCtx(), bridges)).toEqual([]);
  });

  it('produces zero findings when both sides have zero matches', () => {
    const bridges = [
      {
        id: 'both-zero',
        producer: { pattern: 'ABSENT', scope: ['prod.md'], exts: ['md'] },
        consumer: { pattern: 'ABSENT', scope: ['cons.mjs'], exts: ['mjs'] },
      },
    ];

    expect(detectBridgeBalance(bridgeCtx(), bridges)).toEqual([]);
  });

  it('produces zero findings for an empty bridges list', () => {
    expect(detectBridgeBalance(bridgeCtx(), [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DETECTORS registry
// ---------------------------------------------------------------------------

describe('DETECTORS registry', () => {
  it('exposes exactly two detectors with ids dangling-reference and bridge-balance', () => {
    expect(DETECTORS).toHaveLength(2);
    expect(DETECTORS.map((d) => d.id)).toEqual(['dangling-reference', 'bridge-balance']);
  });
});
