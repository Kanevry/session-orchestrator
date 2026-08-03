/**
 * tests/lib/blocked-commands-policy.test.mjs
 *
 * Unit tests for scripts/lib/blocked-commands-policy.mjs (#972) — the
 * floor/overlay policy merge that replaced the first-hit-wins loader.
 *
 * The bug class every test here targets: before #972, an empty or hostile
 * consumer policy in cwd SILENTLY disarmed the plugin's own blocklist
 * (`{"version":1,"rules":[]}` switched the destructive-command guard off).
 * The merge invariant under test: merged.rules ⊇ floor.rules for EVERY
 * overlay input, and a floor `block` can never be downgraded or field-merged.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolvePolicyPaths,
  mergePolicies,
  loadEffectivePolicy,
} from '../../scripts/lib/blocked-commands-policy.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal floor mirroring the production shape (block + warn + allowlisted). */
const FLOOR = Object.freeze({
  version: 1,
  rules: [
    {
      id: 'git-reset-hard',
      pattern: 'git reset --hard',
      severity: 'block',
      rationale: 'floor block rule',
    },
    {
      id: 'git-revert-commit',
      pattern: 'git revert',
      severity: 'warn',
      rationale: 'floor warn rule',
    },
    {
      id: 'rm-rf-destructive',
      pattern: 'rm -rf',
      severity: 'block',
      rationale: 'floor rm rule',
      'path-allowlist': ['/tmp/', '/private/tmp/', '$TMPDIR'],
    },
  ],
});

const POLICY_REL = path.join('.orchestrator', 'policy', 'blocked-commands.json');

// ---------------------------------------------------------------------------
// Temp-root lifecycle
// ---------------------------------------------------------------------------

const tmpDirs = [];

/**
 * Create a temp root dir; when `content` is given, write it as the policy file
 * (objects are JSON-stringified, strings written verbatim for malformed cases).
 */
async function mkRoot(content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bcp-unit-'));
  tmpDirs.push(dir);
  if (content !== undefined) {
    const policyPath = path.join(dir, POLICY_REL);
    await fs.mkdir(path.dirname(policyPath), { recursive: true });
    await fs.writeFile(
      policyPath,
      typeof content === 'string' ? content : JSON.stringify(content, null, 2)
    );
  }
  return dir;
}

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// resolvePolicyPaths
// ---------------------------------------------------------------------------

describe('resolvePolicyPaths', () => {
  it('returns pluginRoot policy as floor and first existing of [cwd, projectDir] as overlay', async () => {
    const floorRoot = await mkRoot(FLOOR);
    const overlayRoot = await mkRoot({ version: 1, rules: [] });
    const { floorPath, overlayPath } = resolvePolicyPaths({
      cwd: overlayRoot,
      projectDir: overlayRoot,
      pluginRoot: floorRoot,
    });
    expect(floorPath).toBe(path.join(floorRoot, POLICY_REL));
    expect(overlayPath).toBe(path.join(overlayRoot, POLICY_REL));
  });

  it('falls back to projectDir for the overlay when cwd has no policy', async () => {
    const floorRoot = await mkRoot(FLOOR);
    const bareCwd = await mkRoot(); // no policy file
    const projectRoot = await mkRoot({ version: 1, rules: [] });
    const { overlayPath } = resolvePolicyPaths({
      cwd: bareCwd,
      projectDir: projectRoot,
      pluginRoot: floorRoot,
    });
    expect(overlayPath).toBe(path.join(projectRoot, POLICY_REL));
  });

  it('returns nulls for missing roots / missing files (total, never throws)', async () => {
    const bare = await mkRoot();
    expect(resolvePolicyPaths({})).toEqual({ floorPath: null, overlayPath: null });
    expect(resolvePolicyPaths({ cwd: bare, projectDir: bare, pluginRoot: bare })).toEqual({
      floorPath: null,
      overlayPath: null,
    });
  });
});

// ---------------------------------------------------------------------------
// mergePolicies — cases (a)–(e)
// ---------------------------------------------------------------------------

describe('mergePolicies', () => {
  it('(a) overlay-only rule is appended additively after the floor rules', () => {
    const overlay = {
      rules: [
        { id: 'consumer-drop-db', pattern: 'dropdb --force', severity: 'block', rationale: 'x' },
      ],
    };
    const { rules, warnings } = mergePolicies(FLOOR, overlay);
    expect(rules.map((r) => r.id)).toEqual([
      'git-reset-hard',
      'git-revert-commit',
      'rm-rf-destructive',
      'consumer-drop-db',
    ]);
    expect(warnings).toEqual([]);
  });

  it('(b) floor block wins WHOLE-RULE on id collision — overlay downgrade + field smuggle dropped with warning', () => {
    const overlay = {
      rules: [
        {
          id: 'git-reset-hard',
          pattern: 'never-matches-anything',
          severity: 'warn',
          rationale: 'downgrade attempt',
        },
      ],
    };
    const { rules, warnings } = mergePolicies(FLOOR, overlay);
    const rule = rules.find((r) => r.id === 'git-reset-hard');
    // The ENTIRE floor rule survives — pattern and severity untouched.
    expect(rule).toEqual(FLOOR.rules[0]);
    expect(warnings.some((w) => w.includes('git-reset-hard') && w.includes('shadowed'))).toBe(true);
  });

  it('(b) overlay cannot widen a floor block rule\'s path-allowlist (the field-merge backdoor)', () => {
    const overlay = {
      rules: [
        {
          id: 'rm-rf-destructive',
          pattern: 'rm -rf',
          severity: 'block',
          rationale: 'same severity, wider allowlist',
          'path-allowlist': ['/'],
        },
      ],
    };
    const { rules } = mergePolicies(FLOOR, overlay);
    const rule = rules.find((r) => r.id === 'rm-rf-destructive');
    expect(rule['path-allowlist']).toEqual(['/tmp/', '/private/tmp/', '$TMPDIR']);
  });

  it('(c) floor warn + overlay block escalates severity on the FLOOR rule\'s fields', () => {
    const overlay = {
      rules: [
        {
          id: 'git-revert-commit',
          pattern: 'overlay-pattern-must-not-win',
          severity: 'block',
          rationale: 'escalation',
        },
      ],
    };
    const { rules } = mergePolicies(FLOOR, overlay);
    const rule = rules.find((r) => r.id === 'git-revert-commit');
    expect(rule.severity).toBe('block');
    // Escalate-only means severity moves, fields stay floor's.
    expect(rule.pattern).toBe('git revert');
  });

  it('(c) floor warn + unknown overlay severity keeps the floor severity with warning', () => {
    const overlay = {
      rules: [
        { id: 'git-revert-commit', pattern: 'git revert', severity: 'ignore', rationale: 'x' },
      ],
    };
    const { rules, warnings } = mergePolicies(FLOOR, overlay);
    expect(rules.find((r) => r.id === 'git-revert-commit').severity).toBe('warn');
    expect(warnings.some((w) => w.includes('unknown severity'))).toBe(true);
  });

  it("(c) severity 'toString' is unknown — must not walk the prototype chain (W4 F4)", () => {
    // Bug this catches: `'toString' in SEVERITY_RANK` is true via the
    // prototype chain, so the unknown-severity warning was silently swallowed
    // (the floor severity survived only by NaN-comparison accident).
    const overlay = {
      rules: [
        { id: 'git-revert-commit', pattern: 'git revert', severity: 'toString', rationale: 'x' },
      ],
    };
    const { rules, warnings } = mergePolicies(FLOOR, overlay);
    expect(rules.find((r) => r.id === 'git-revert-commit').severity).toBe('warn');
    expect(warnings.some((w) => w.includes('unknown severity') && w.includes('toString'))).toBe(true);
  });

  it('(d) duplicate ids WITHIN one file: first occurrence wins with warning', () => {
    const overlay = {
      rules: [
        { id: 'dup-rule', pattern: 'first', severity: 'block', rationale: 'x' },
        { id: 'dup-rule', pattern: 'second', severity: 'warn', rationale: 'x' },
      ],
    };
    const { rules, warnings } = mergePolicies({ rules: [] }, overlay);
    const matching = rules.filter((r) => r.id === 'dup-rule');
    expect(matching).toHaveLength(1);
    expect(matching[0].pattern).toBe('first');
    expect(warnings.some((w) => w.includes('dup-rule') && w.includes('duplicated'))).toBe(true);
  });

  it('(e) a broken individual rule is skipped with warning — the rest of the list survives', () => {
    const overlay = {
      rules: [
        { id: 'no-pattern', severity: 'block', rationale: 'broken' },
        { id: 'valid-rule', pattern: 'foo --bar', severity: 'block', rationale: 'ok' },
        'not-an-object',
      ],
    };
    const { rules, warnings } = mergePolicies(FLOOR, overlay);
    expect(rules.some((r) => r.id === 'valid-rule')).toBe(true);
    expect(rules.some((r) => r.id === 'no-pattern')).toBe(false);
    expect(warnings.filter((w) => w.includes('skipped'))).toHaveLength(2);
  });

  it('INVARIANT: merged.rules ⊇ floor.rules for every adversarial overlay shape', () => {
    const adversarialOverlays = [
      undefined,
      null,
      {},
      { rules: [] },
      { rules: 'garbage' },
      { rules: [{ id: 'git-reset-hard', pattern: 'x', severity: 'warn' }] },
      {
        rules: FLOOR.rules.map((r) => ({
          id: r.id,
          pattern: 'noop',
          severity: 'ignore',
          rationale: 'downgrade-all',
        })),
      },
    ];
    for (const overlay of adversarialOverlays) {
      const { rules } = mergePolicies(FLOOR, overlay);
      for (const floorRule of FLOOR.rules) {
        const merged = rules.find((r) => r.id === floorRule.id);
        expect(merged, `floor rule ${floorRule.id} lost for overlay ${JSON.stringify(overlay)}`).toBeDefined();
        if (floorRule.severity === 'block') {
          expect(merged.severity).toBe('block');
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// loadEffectivePolicy — failure modes
// ---------------------------------------------------------------------------

describe('loadEffectivePolicy failure modes', () => {
  async function load({ floorContent, overlayContent, cache = new Map() }) {
    const floorRoot = await mkRoot(floorContent);
    const overlayRoot = await mkRoot(overlayContent);
    const result = await loadEffectivePolicy({
      cwd: overlayRoot,
      projectDir: overlayRoot,
      pluginRoot: floorRoot,
      cache,
    });
    return { ...result, floorRoot, overlayRoot };
  }

  it('valid floor + valid overlay → merged rules', async () => {
    const overlay = {
      version: 1,
      rules: [{ id: 'consumer-rule', pattern: 'dropdb --force', severity: 'block', rationale: 'x' }],
    };
    const { rules } = await load({ floorContent: FLOOR, overlayContent: overlay });
    expect(rules.map((r) => r.id)).toContain('git-reset-hard');
    expect(rules.map((r) => r.id)).toContain('consumer-rule');
  });

  it('empty overlay rules array → fail-to-floor with warning (THE #972 disarm bug)', async () => {
    const { rules, warnings } = await load({
      floorContent: FLOOR,
      overlayContent: { version: 1, rules: [] },
    });
    expect(rules.map((r) => r.id)).toEqual(FLOOR.rules.map((r) => r.id));
    expect(warnings.some((w) => w.includes('overlay policy ignored') && w.includes('empty'))).toBe(true);
  });

  it('malformed overlay JSON → fail-to-floor with warning', async () => {
    const { rules, warnings } = await load({
      floorContent: FLOOR,
      overlayContent: '{ this is not json',
    });
    expect(rules.map((r) => r.id)).toEqual(FLOOR.rules.map((r) => r.id));
    expect(warnings.some((w) => w.includes('malformed'))).toBe(true);
  });

  it('overlay without .rules array → fail-to-floor with warning', async () => {
    const { rules, warnings } = await load({
      floorContent: FLOOR,
      overlayContent: { version: 1 },
    });
    expect(rules.map((r) => r.id)).toEqual(FLOOR.rules.map((r) => r.id));
    expect(warnings.some((w) => w.includes('.rules'))).toBe(true);
  });

  it('missing overlay file → floor alone, silent (the normal no-overlay case)', async () => {
    const { rules, warnings } = await load({ floorContent: FLOOR, overlayContent: undefined });
    expect(rules.map((r) => r.id)).toEqual(FLOOR.rules.map((r) => r.id));
    expect(warnings).toEqual([]);
  });

  it('missing floor + valid overlay → overlay alone with floor-unavailable warning', async () => {
    const overlay = {
      version: 1,
      rules: [{ id: 'consumer-rule', pattern: 'dropdb --force', severity: 'block', rationale: 'x' }],
    };
    const { rules, warnings } = await load({ floorContent: undefined, overlayContent: overlay });
    expect(rules.map((r) => r.id)).toEqual(['consumer-rule']);
    expect(warnings.some((w) => w.includes('floor policy unavailable'))).toBe(true);
  });

  it('malformed floor + valid overlay → overlay alone with loud warning', async () => {
    const overlay = {
      version: 1,
      rules: [{ id: 'consumer-rule', pattern: 'dropdb --force', severity: 'block', rationale: 'x' }],
    };
    const { rules, warnings } = await load({ floorContent: '{ nope', overlayContent: overlay });
    expect(rules.map((r) => r.id)).toEqual(['consumer-rule']);
    expect(warnings.some((w) => w.includes('malformed'))).toBe(true);
  });

  it('both missing → rules null with the not-found warning (hook keeps fail-open)', async () => {
    const { rules, warnings } = await load({ floorContent: undefined, overlayContent: undefined });
    expect(rules).toBeNull();
    expect(warnings.some((w) => w.includes('policy file not found'))).toBe(true);
  });

  it('degenerate identity (cwd === pluginRoot): one valid file, no self-shadow warnings', async () => {
    const root = await mkRoot(FLOOR);
    const { rules, warnings } = await loadEffectivePolicy({
      cwd: root,
      projectDir: root,
      pluginRoot: root,
      cache: new Map(),
    });
    expect(rules.map((r) => r.id)).toEqual(FLOOR.rules.map((r) => r.id));
    // Identity merge must NOT produce "shadowed by floor block rule" noise.
    expect(warnings).toEqual([]);
  });

  it('degenerate identity: malformed single file → rules null + malformed warning', async () => {
    const root = await mkRoot('{ broken');
    const { rules, warnings } = await loadEffectivePolicy({
      cwd: root,
      projectDir: root,
      pluginRoot: root,
      cache: new Map(),
    });
    expect(rules).toBeNull();
    expect(warnings.some((w) => w.includes('malformed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadEffectivePolicy — per-path cache correctness
// ---------------------------------------------------------------------------

describe('loadEffectivePolicy per-path cache', () => {
  it('overlay mtime change invalidates ONLY the overlay entry; floor stays cached', async () => {
    const floorRoot = await mkRoot(FLOOR);
    const overlayRoot = await mkRoot({
      version: 1,
      rules: [{ id: 'consumer-a', pattern: 'foo --a', severity: 'block', rationale: 'x' }],
    });
    const cache = new Map();
    const opts = { cwd: overlayRoot, projectDir: overlayRoot, pluginRoot: floorRoot, cache };

    const first = await loadEffectivePolicy(opts);
    expect(first.rules.map((r) => r.id)).toContain('consumer-a');

    const floorPath = path.join(floorRoot, POLICY_REL);
    const overlayPath = path.join(overlayRoot, POLICY_REL);
    const floorPolicyRef = cache.get(floorPath).policy;
    expect(floorPolicyRef).toBeDefined();

    // Rewrite the overlay with an ADVANCED mtime (mtime granularity can be
    // coarse — pin it explicitly so the invalidation is deterministic).
    await fs.writeFile(
      overlayPath,
      JSON.stringify({
        version: 1,
        rules: [{ id: 'consumer-b', pattern: 'foo --b', severity: 'block', rationale: 'x' }],
      })
    );
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(overlayPath, future, future);

    const second = await loadEffectivePolicy(opts);
    // Overlay change is picked up …
    expect(second.rules.map((r) => r.id)).toContain('consumer-b');
    expect(second.rules.map((r) => r.id)).not.toContain('consumer-a');
    // … while the floor entry was served from cache (same parsed object).
    expect(cache.get(floorPath).policy).toBe(floorPolicyRef);
  });

  it('floor mtime change is picked up independently of an unchanged overlay', async () => {
    const floorRoot = await mkRoot(FLOOR);
    const overlayRoot = await mkRoot({
      version: 1,
      rules: [{ id: 'consumer-a', pattern: 'foo --a', severity: 'block', rationale: 'x' }],
    });
    const cache = new Map();
    const opts = { cwd: overlayRoot, projectDir: overlayRoot, pluginRoot: floorRoot, cache };

    const first = await loadEffectivePolicy(opts);
    expect(first.rules.map((r) => r.id)).not.toContain('floor-new');

    const floorPath = path.join(floorRoot, POLICY_REL);
    const updatedFloor = {
      version: 1,
      rules: [
        ...FLOOR.rules,
        { id: 'floor-new', pattern: 'bar --baz', severity: 'block', rationale: 'x' },
      ],
    };
    await fs.writeFile(floorPath, JSON.stringify(updatedFloor));
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(floorPath, future, future);

    const second = await loadEffectivePolicy(opts);
    expect(second.rules.map((r) => r.id)).toContain('floor-new');
    expect(second.rules.map((r) => r.id)).toContain('consumer-a');
  });
});
