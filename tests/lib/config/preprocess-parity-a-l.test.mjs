import { describe, it, expect } from 'vitest';

import { _parseAutoDream } from '../../../scripts/lib/config/auto-dream.mjs';
import { _parseBrokenWindow } from '../../../scripts/lib/config/broken-window.mjs';
import { _parseColdStart } from '../../../scripts/lib/config/cold-start.mjs';
import { _parseConfigProtection } from '../../../scripts/lib/config/config-protection.mjs';
import { _parseContextCoverage } from '../../../scripts/lib/config/context-coverage.mjs';
import { _parseCrossRepo } from '../../../scripts/lib/config/cross-repo.mjs';
import { _parseCustomPhases } from '../../../scripts/lib/config/custom-phases.mjs';
import { _parseDialectic } from '../../../scripts/lib/config/dialectic.mjs';
import { _parseDiscoveryValidator } from '../../../scripts/lib/config/discovery-validator.mjs';
import { _parseDispatcherAutonomy } from '../../../scripts/lib/config/dispatcher-autonomy.mjs';
import { _parseDocsOrchestrator } from '../../../scripts/lib/config/docs-orchestrator.mjs';
import { _parseDocsStaleness } from '../../../scripts/lib/config/docs-staleness.mjs';
import { _parseDriftCheck } from '../../../scripts/lib/config/drift-check.mjs';
import { _parseEval } from '../../../scripts/lib/config/eval.mjs';
import { _parseEventsRotation } from '../../../scripts/lib/config/events-rotation.mjs';
import { _parseEvolve, _parseEvolveDecay } from '../../../scripts/lib/config/evolve.mjs';
import { _parseFrontendSlopHook } from '../../../scripts/lib/config/frontend-slop-hook.mjs';
import { _parseGitlabPortfolio } from '../../../scripts/lib/config/gitlab-portfolio.mjs';
import { _parseHandoverGate } from '../../../scripts/lib/config/handover-gate.mjs';
import { _parseHealthEndpoints } from '../../../scripts/lib/config/health-endpoints.mjs';
import { _parseIssueBudget } from '../../../scripts/lib/config/issue-budget.mjs';
import { _parseLoopGuard } from '../../../scripts/lib/config/loop-guard.mjs';

/**
 * preprocess-parity-a-l.test.mjs — ONE parametrized guard for the A–L half of the
 * block parsers migrated onto the `block-preprocess.mjs` contract (#1162).
 *
 * Two bugs, one table (the failure story is in the block-preprocess.mjs docblock):
 *   (a) a block commented out with a multi-line `<!-- … -->` was read as LIVE config;
 *   (b) the bold-bullet sub-key rendering (`- **key:** value`) matched no sub-key
 *       regex, so the key was silently absent and its DEFAULT applied.
 *
 * Per parser this file asserts exactly those two shapes rather than re-testing each
 * parser's semantics — those live in the per-parser sibling files. For a dash-RECORD
 * parser (`variant: 'no-dash'`) case (b) is inapplicable by contract (de-dashing
 * would merge two records into one), so it asserts instead that dash records still
 * parse as SEPARATE records — the regression the NoDash variant exists to prevent.
 */

/**
 * @type {Array<{
 *   id: string,
 *   variant: 'standard'|'no-dash',
 *   parse: (c: string) => any,
 *   commented: string,
 *   expectDefault: (r: any) => void,
 *   live: string,
 *   expectLive: (r: any) => void,
 * }>}
 */
const CASES = [
  {
    id: 'auto-dream',
    variant: 'standard',
    parse: _parseAutoDream,
    commented: '<!--\nauto-dream:\n  min-confidence: 0.9\n-->\n',
    expectDefault: (r) => expect(r['min-confidence']).toBe(0.5),
    live: 'auto-dream:\n  - **min-confidence:** 0.9\n',
    expectLive: (r) => expect(r['min-confidence']).toBe(0.9),
  },
  {
    id: 'broken-window-budget',
    variant: 'standard',
    parse: _parseBrokenWindow,
    commented: '<!--\nbroken-window-budget:\n  due-days: 14\n-->\n',
    expectDefault: (r) => expect(r['due-days']).toBe(7),
    live: 'broken-window-budget:\n  - **due-days:** 14\n',
    expectLive: (r) => expect(r['due-days']).toBe(14),
  },
  {
    id: 'cold-start',
    variant: 'standard',
    parse: _parseColdStart,
    commented: '<!--\ncold-start:\n  nudge-after-hours: 4\n-->\n',
    expectDefault: (r) => expect(r['nudge-after-hours']).toBe(1),
    live: 'cold-start:\n  - **nudge-after-hours:** 4\n',
    expectLive: (r) => expect(r['nudge-after-hours']).toBe(4),
  },
  {
    id: 'config-protection',
    variant: 'standard',
    parse: _parseConfigProtection,
    commented: '<!--\nconfig-protection:\n  mode: strict\n-->\n',
    expectDefault: (r) => expect(r.mode).toBe('warn'),
    live: 'config-protection:\n  - **mode:** strict\n',
    expectLive: (r) => expect(r.mode).toBe('strict'),
  },
  {
    id: 'context-coverage',
    variant: 'standard',
    parse: _parseContextCoverage,
    commented: '<!--\ncontext-coverage:\n  enabled: true\n-->\n',
    expectDefault: (r) => expect(r.enabled).toBe(false),
    live: 'context-coverage:\n  - **enabled:** true\n',
    expectLive: (r) => expect(r.enabled).toBe(true),
  },
  {
    id: 'cross-repo',
    variant: 'standard',
    parse: _parseCrossRepo,
    commented: '<!--\ncross-repo:\n  projects: [a/b]\n-->\n',
    expectDefault: (r) => expect(r).toEqual([]),
    live: 'cross-repo:\n  - **projects:** [a/b]\n',
    expectLive: (r) => expect(r).toEqual(['a/b']),
  },
  {
    id: 'custom-phases',
    variant: 'no-dash',
    parse: _parseCustomPhases,
    commented: '<!--\ncustom-phases:\n  - name: p\n    command: npm test\n-->\n',
    expectDefault: (r) => expect(r).toEqual([]),
    live:
      'custom-phases:\n  - name: p\n    command: npm test\n  - name: q\n    command: npm run lint\n',
    expectLive: (r) => expect(r.map((x) => x.name)).toEqual(['p', 'q']),
  },
  {
    id: 'dialectic',
    variant: 'standard',
    parse: _parseDialectic,
    commented: '<!--\ndialectic:\n  cadence: 9\n-->\n',
    expectDefault: (r) => expect(r.cadence).toBe(5),
    live: 'dialectic:\n  - **cadence:** 9\n',
    expectLive: (r) => expect(r.cadence).toBe(9),
  },
  {
    id: 'discovery-validator',
    variant: 'standard',
    parse: _parseDiscoveryValidator,
    commented: '<!--\ndiscovery-validator:\n  enabled: true\n-->\n',
    expectDefault: (r) => expect(r.enabled).toBe(false),
    live: 'discovery-validator:\n  - **enabled:** true\n',
    expectLive: (r) => expect(r.enabled).toBe(true),
  },
  {
    id: 'dispatcher-autonomy',
    variant: 'standard',
    parse: _parseDispatcherAutonomy,
    commented: '<!--\ndispatcher-autonomy:\n  autonomy: advisory\n-->\n',
    expectDefault: (r) => expect(r.autonomy).toBe('off'),
    live: 'dispatcher-autonomy:\n  - **autonomy:** advisory\n',
    expectLive: (r) => expect(r.autonomy).toBe('advisory'),
  },
  {
    id: 'docs-orchestrator',
    variant: 'standard',
    parse: _parseDocsOrchestrator,
    commented: '<!--\ndocs-orchestrator:\n  enabled: true\n-->\n',
    expectDefault: (r) => expect(r.enabled).toBe(false),
    live: 'docs-orchestrator:\n  - **enabled:** true\n',
    expectLive: (r) => expect(r.enabled).toBe(true),
  },
  {
    id: 'docs-staleness',
    variant: 'standard',
    parse: _parseDocsStaleness,
    commented: '<!--\ndocs-staleness:\n  enabled: true\n-->\n',
    expectDefault: (r) => expect(r.enabled).toBe(false),
    live: 'docs-staleness:\n  - **enabled:** true\n',
    expectLive: (r) => expect(r.enabled).toBe(true),
  },
  {
    id: 'drift-check',
    variant: 'standard',
    parse: _parseDriftCheck,
    commented: '<!--\ndrift-check:\n  enabled: true\n-->\n',
    expectDefault: (r) => expect(r.enabled).toBe(false),
    live: 'drift-check:\n  - **enabled:** true\n',
    expectLive: (r) => expect(r.enabled).toBe(true),
  },
  {
    id: 'eval',
    variant: 'standard',
    parse: _parseEval,
    commented: '<!--\neval:\n  enabled: true\n-->\n',
    expectDefault: (r) => expect(r.enabled).toBe(false),
    live: 'eval:\n  - **enabled:** true\n',
    expectLive: (r) => expect(r.enabled).toBe(true),
  },
  {
    id: 'events-rotation',
    variant: 'standard',
    parse: _parseEventsRotation,
    commented: '<!--\nevents-rotation:\n  max-size-mb: 20\n-->\n',
    expectDefault: (r) => expect(r['max-size-mb']).toBe(10),
    live: 'events-rotation:\n  - **max-size-mb:** 20\n',
    expectLive: (r) => expect(r['max-size-mb']).toBe(20),
  },
  {
    id: 'evolve (extra-sources records)',
    variant: 'no-dash',
    parse: _parseEvolve,
    commented: '<!--\nevolve:\n  extra-sources:\n    - path: a.json\n-->\n',
    expectDefault: (r) => expect(r).toEqual([]),
    live: 'evolve:\n  extra-sources:\n    - path: a.json\n    - path: b.json\n',
    expectLive: (r) => expect(r.map((x) => x.path)).toEqual(['a.json', 'b.json']),
  },
  {
    id: 'evolve (decay sub-keys)',
    variant: 'standard',
    parse: _parseEvolveDecay,
    commented: '<!--\nevolve:\n  decay-half-life-days: 30\n-->\n',
    expectDefault: (r) => expect(r['half-life-days']).toBe(90),
    live: 'evolve:\n  - **decay-half-life-days:** 30\n',
    expectLive: (r) => expect(r['half-life-days']).toBe(30),
  },
  {
    id: 'frontend-slop-hook',
    variant: 'standard',
    parse: _parseFrontendSlopHook,
    commented: '<!--\nfrontend-slop-hook:\n  enabled: true\n-->\n',
    expectDefault: (r) => expect(r.enabled).toBe(false),
    live: 'frontend-slop-hook:\n  - **enabled:** true\n',
    expectLive: (r) => expect(r.enabled).toBe(true),
  },
  {
    id: 'gitlab-portfolio',
    variant: 'standard',
    parse: _parseGitlabPortfolio,
    commented: '<!--\ngitlab-portfolio:\n  enabled: true\n-->\n',
    expectDefault: (r) => expect(r.enabled).toBe(false),
    live: 'gitlab-portfolio:\n  - **enabled:** true\n',
    expectLive: (r) => expect(r.enabled).toBe(true),
  },
  {
    id: 'handover-gate',
    variant: 'standard',
    parse: _parseHandoverGate,
    commented: '<!--\nhandover-gate:\n  max-open-questions: 7\n-->\n',
    expectDefault: (r) => expect(r['max-open-questions']).toBe(3),
    live: 'handover-gate:\n  - **max-open-questions:** 7\n',
    expectLive: (r) => expect(r['max-open-questions']).toBe(7),
  },
  {
    id: 'health-endpoints',
    variant: 'no-dash',
    parse: _parseHealthEndpoints,
    commented:
      '<!--\nhealth-endpoints:\n  - name: api\n    url: https://example.test/health\n-->\n',
    expectDefault: (r) => expect(r).toBeNull(),
    live:
      'health-endpoints:\n  - name: api\n    url: https://example.test/health\n  - name: web\n    url: https://example.test/up\n',
    expectLive: (r) => expect(r.map((x) => x.name)).toEqual(['api', 'web']),
  },
  {
    id: 'issue-budget',
    variant: 'standard',
    parse: _parseIssueBudget,
    commented: '<!--\nissue-budget:\n  max-per-session: 30\n-->\n',
    expectDefault: (r) => expect(r['max-per-session']).toBe(12),
    live: 'issue-budget:\n  - **max-per-session:** 30\n',
    expectLive: (r) => expect(r['max-per-session']).toBe(30),
  },
  {
    id: 'loop-guard',
    variant: 'standard',
    parse: _parseLoopGuard,
    commented: '<!--\nloop-guard:\n  threshold: 8\n-->\n',
    expectDefault: (r) => expect(r.threshold).toBe(3),
    live: 'loop-guard:\n  - **threshold:** 8\n',
    expectLive: (r) => expect(r.threshold).toBe(8),
  },
];

describe('block-preprocess parity — A–L parsers (#1162)', () => {
  it.each(CASES)('$id: a commented-out block yields the default', ({ parse, commented, expectDefault }) => {
    expectDefault(parse(commented));
  });

  it.each(CASES.filter((c) => c.variant === 'standard'))(
    '$id: a bold-bullet sub-key is read, not silently defaulted',
    ({ parse, live, expectLive }) => {
      expectLive(parse(live));
    },
  );

  it.each(CASES.filter((c) => c.variant === 'no-dash'))(
    '$id: dash records still parse as separate records (NoDash variant)',
    ({ parse, live, expectLive }) => {
      expectLive(parse(live));
    },
  );
});
