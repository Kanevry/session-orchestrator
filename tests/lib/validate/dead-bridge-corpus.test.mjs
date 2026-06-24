/**
 * tests/lib/validate/dead-bridge-corpus.test.mjs
 *
 * THE EQUIVALENCE PROOF for the unified dead-bridge validator (#671).
 *
 * This file is the gate that justifies retiring the three standalone guards
 * (#614 check-subagent-types, #445 check-rules-references, #618
 * check-baseline-fetch-bridge). For EVERY CorpusCase it proves the merged
 * detector both FLAGS the regression `positive` and CLEARS the `negative`,
 * and it explicitly asserts the corpus covers all three retired sub-rules.
 *
 * Strategy:
 *   - dangling-* cases  → materialize the case text at the rule's natural locus
 *     in an in-memory fake ctx (skills/**.md, .claude/rules/*.md, or
 *     skills/bootstrap/SKILL.md) with the dangling target absent. Assert the
 *     matching detector produces >= 1 Finding for the case's `rule`; the
 *     resolvable negative produces ZERO.
 *   - bridge-balance cases → the corpus rows carry illustrative prose, not live
 *     loci. We prove the two failure SHAPES (set-never-read / read-never-set)
 *     are caught via detectBridgeBalance with synthesized bridges, and that a
 *     balanced bridge is clean.
 *   - BRIDGES live-balance → against the REAL repo (node:fs ctx) the declared
 *     bridges produce zero findings AND each declared bridge is NON-trivial
 *     (producer > 0 AND consumer > 0) — guarding the 0/0 trivial-pass regression
 *     fixed in W3.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPUS, BRIDGES } from '@lib/validate/dead-bridge-corpus.mjs';
import {
  detectDanglingReferences,
  detectBridgeBalance,
} from '@lib/validate/dead-bridge-detectors.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// In-memory fake RepoContext (same shape as the orchestrator's real ctx).
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

// A valid bootstrap bridge so the dangling-bootstrap-bridge sub-rule never
// contributes spurious findings when a NON-bootstrap case is under test.
const VALID_BOOTSTRAP = {
  '/plugin/skills/bootstrap/SKILL.md': '[ -f "$PLUGIN_ROOT/scripts/lib/fetch-baseline.mjs" ]',
  '/plugin/scripts/lib/fetch-baseline.mjs': '// baseline fetcher',
};
const ALL_DIRS = ['/plugin/skills', '/plugin/.claude/rules', '/plugin/skills/bootstrap'];

// Resolvable targets the NEGATIVE corpus text refers to.
const NEGATIVE_RESOLUTION_TARGETS = {
  'dangling-subagent-type': { '/plugin/agents/code-implementer.md': '# code-implementer' },
  'dangling-rule-reference': { '/plugin/.claude/rules/security.md': '# security' },
  'dangling-bootstrap-bridge': { '/plugin/scripts/lib/fetch-baseline.mjs': '// baseline fetcher' },
};

/**
 * Build a fake ctx that materializes `text` at the natural locus for `rule`.
 * `extraFiles` adds resolution targets for the negative case.
 */
function ctxForRule(rule, text, extraFiles = {}) {
  if (rule === 'dangling-subagent-type') {
    return makeCtx({
      files: { '/plugin/skills/wave/SKILL.md': text, ...VALID_BOOTSTRAP, ...extraFiles },
      dirs: ALL_DIRS,
    });
  }
  if (rule === 'dangling-rule-reference') {
    return makeCtx({
      files: { '/plugin/.claude/rules/test.md': text, ...VALID_BOOTSTRAP, ...extraFiles },
      dirs: ALL_DIRS,
    });
  }
  if (rule === 'dangling-bootstrap-bridge') {
    // The case text IS the bootstrap guard; extraFiles supply the negative's
    // resolution target (the existing .mjs).
    return makeCtx({
      files: { '/plugin/skills/bootstrap/SKILL.md': text, ...extraFiles },
      dirs: ALL_DIRS,
    });
  }
  throw new Error(`no locus mapping for rule ${rule}`);
}

const DANGLING_RULES = [
  'dangling-subagent-type',
  'dangling-rule-reference',
  'dangling-bootstrap-bridge',
];

// ---------------------------------------------------------------------------
// Equivalence proof — every dangling-* CorpusCase: positive flags, negative clears.
// it.each over the corpus is parameterization (one behavior per row), not
// test-branching.
// ---------------------------------------------------------------------------

const danglingCases = CORPUS.filter((c) => DANGLING_RULES.includes(c.rule));

describe('CORPUS equivalence proof — dangling sub-rules', () => {
  it.each(danglingCases)(
    'positive for $id ($rule) produces >= 1 Finding tagged $rule',
    (c) => {
      const ctx = ctxForRule(c.rule, c.positive);
      const found = detectDanglingReferences(ctx).filter((f) => f.rule === c.rule);

      expect(found.length).toBeGreaterThanOrEqual(1);
      expect(found.every((f) => f.severity === 'fail')).toBe(true);
    },
  );

  it.each(danglingCases)(
    'negative for $id ($rule) produces ZERO Findings tagged $rule',
    (c) => {
      const ctx = ctxForRule(c.rule, c.negative, NEGATIVE_RESOLUTION_TARGETS[c.rule]);
      const found = detectDanglingReferences(ctx).filter((f) => f.rule === c.rule);

      expect(found).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Equivalence proof — the corpus subsumes the THREE retired guards.
// Hardcoded expected rule-id set (NO computation from production logic).
// ---------------------------------------------------------------------------

describe('CORPUS coverage — subsumes the 3 retired guards', () => {
  it('covers all three dangling sub-rule ids (#614, #445, #618)', () => {
    const danglingRuleIds = new Set(
      CORPUS.map((c) => c.rule).filter((r) => DANGLING_RULES.includes(r)),
    );

    expect(danglingRuleIds).toEqual(
      new Set(['dangling-subagent-type', 'dangling-rule-reference', 'dangling-bootstrap-bridge']),
    );
  });

  it('maps each retired-guard issue to a present CorpusCase id', () => {
    const byRule = new Map(CORPUS.map((c) => [c.rule, c.id]));

    expect(byRule.get('dangling-subagent-type')).toBe('614-dead-subagent-type'); // #614
    expect(byRule.get('dangling-rule-reference')).toBe('445-dangling-rule-ref'); // #445
    expect(byRule.get('dangling-bootstrap-bridge')).toBe('618-renamed-dep-guard'); // #618
  });
});

// ---------------------------------------------------------------------------
// Equivalence proof — the bridge-balance corpus rows document the two failure
// shapes; prove each shape is caught and the balanced shape is clean.
// ---------------------------------------------------------------------------

describe('CORPUS bridge-balance rows — failure shapes are caught', () => {
  // ctx with a real producer file (TOKEN) and a real consumer file (TOKEN).
  const shapeCtx = () =>
    makeCtx({
      files: {
        '/plugin/prod.md': 'TOKEN documented here',
        '/plugin/cons.mjs': 'read("TOKEN")',
      },
    });

  it('the corpus includes a set-never-read row and a read-never-set row', () => {
    const bridgeCaseIds = CORPUS.filter((c) => c.rule === 'bridge-balance').map((c) => c.id);

    expect(bridgeCaseIds).toEqual([
      'bridge-balance-set-never-read',
      'bridge-balance-read-never-set',
    ]);
  });

  it('set-never-read shape (producer matches, consumer zero) produces a finding', () => {
    const found = detectBridgeBalance(shapeCtx(), [
      {
        id: 'set-never-read-shape',
        producer: { pattern: 'TOKEN', scope: ['prod.md'], exts: ['md'] },
        consumer: { pattern: 'TOKEN', scope: ['missing.mjs'], exts: ['mjs'] },
      },
    ]);

    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe('bridge-balance');
    expect(found[0].message).toContain('set but never read');
  });

  it('read-never-set shape (consumer matches, producer zero) produces a finding', () => {
    const found = detectBridgeBalance(shapeCtx(), [
      {
        id: 'read-never-set-shape',
        producer: { pattern: 'TOKEN', scope: ['missing.md'], exts: ['md'] },
        consumer: { pattern: 'TOKEN', scope: ['cons.mjs'], exts: ['mjs'] },
      },
    ]);

    expect(found).toHaveLength(1);
    expect(found[0].rule).toBe('bridge-balance');
    expect(found[0].message).toContain('read but never set');
  });

  it('a balanced bridge (both sides match) produces zero findings', () => {
    const found = detectBridgeBalance(shapeCtx(), [
      {
        id: 'balanced-shape',
        producer: { pattern: 'TOKEN', scope: ['prod.md'], exts: ['md'] },
        consumer: { pattern: 'TOKEN', scope: ['cons.mjs'], exts: ['mjs'] },
      },
    ]);

    expect(found).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Live-balance proof — declared BRIDGES are balanced AND non-trivial on the
// real repo. This guards against the 0/0 trivial-pass regression (W3 fix).
// ---------------------------------------------------------------------------

// Real-fs ctx mirroring the orchestrator's buildRepoContext, scoped to the repo.
function realCtx() {
  const walk = (absDir, exts) => {
    const out = [];
    if (!existsSync(absDir) || !statSync(absDir).isDirectory()) return out;
    for (const ent of readdirSync(absDir, { withFileTypes: true })) {
      const full = path.join(absDir, ent.name);
      if (ent.isDirectory()) out.push(...walk(full, exts));
      else if (ent.isFile() && (!exts || exts.includes(path.extname(full)))) out.push(full);
    }
    return out;
  };
  return {
    pluginRoot: REPO_ROOT,
    listMdFiles: (absDir) => walk(absDir, ['.md']),
    listFiles: (absDir, exts = ['.mjs', '.md']) => walk(absDir, exts),
    readText: (absPath) => readFileSync(absPath, 'utf8'),
    exists: (absPath) => existsSync(absPath),
  };
}

// A small, independent count helper replicated in the test to assert each
// declared bridge endpoint is NON-trivial. Independent of production countMatches.
function countEndpoint(endpoint) {
  const walk = (absDir, exts) => {
    const out = [];
    if (!existsSync(absDir) || !statSync(absDir).isDirectory()) return out;
    for (const ent of readdirSync(absDir, { withFileTypes: true })) {
      const full = path.join(absDir, ent.name);
      if (ent.isDirectory()) out.push(...walk(full, exts));
      else if (ent.isFile() && exts.includes(path.extname(full))) out.push(full);
    }
    return out;
  };
  const normExts = (exts) =>
    (exts && exts.length ? exts : ['.mjs', '.md']).map((e) =>
      String(e).startsWith('.') ? String(e) : `.${e}`,
    );
  const compile = (p) => {
    const s = String(p);
    const m = s.match(/^\/(.*)\/([a-z]*)$/s);
    if (m) return new RegExp(m[1], m[2].includes('g') ? m[2] : `${m[2]}g`);
    return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  };
  const exts = normExts(endpoint.exts);
  let total = 0;
  for (const rel of endpoint.scope) {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    let txt;
    try {
      txt = readFileSync(abs, 'utf8');
    } catch {
      txt = undefined;
    }
    if (typeof txt === 'string' && statSync(abs).isFile()) {
      const mm = txt.match(compile(endpoint.pattern));
      total += mm ? mm.length : 0;
      continue;
    }
    for (const f of walk(abs, exts)) {
      const mm = readFileSync(f, 'utf8').match(compile(endpoint.pattern));
      total += mm ? mm.length : 0;
    }
  }
  return total;
}

describe('declared BRIDGES — live balance and non-triviality', () => {
  it('detectBridgeBalance returns zero findings against the real repo', () => {
    const found = detectBridgeBalance(realCtx(), BRIDGES);

    expect(found).toEqual([]);
  });

  it.each(BRIDGES)(
    'declared bridge $id has a NON-trivial producer count (> 0) on the real repo',
    (bridge) => {
      expect(countEndpoint(bridge.producer)).toBeGreaterThan(0);
    },
  );

  it.each(BRIDGES)(
    'declared bridge $id has a NON-trivial consumer count (> 0) on the real repo',
    (bridge) => {
      expect(countEndpoint(bridge.consumer)).toBeGreaterThan(0);
    },
  );

  it('declares at least one bridge (the corpus carries a live bridge)', () => {
    expect(BRIDGES.length).toBeGreaterThanOrEqual(1);
  });
});
