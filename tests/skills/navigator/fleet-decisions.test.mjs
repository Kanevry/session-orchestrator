import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  slotDecision,
  busyDecision,
  chooseAccount,
} from '../../../skills/navigator/references/fleet-decisions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MODULE = join(here, '../../../skills/navigator/references/fleet-decisions.mjs');
const ACCOUNT_SH = join(here, '../../../skills/navigator/references/account-check.sh');

const NOW = Date.parse('2026-01-10T12:00:00Z');
const inDays = (d) => new Date(NOW + d * 86400000).toISOString();

describe('slotDecision', () => {
  // Bug: an unreadable memory value (empty awk output → NaN/null) is treated as free and opens a slot.
  it('unreadable memory value does not open a slot', () => {
    for (const freePct of [NaN, null, undefined, '60']) {
      expect(slotDecision({ freePct, load1: 5, runs: 0 })).toMatchObject({ allowed: false, cap: 0 });
    }
  });

  // Bug: the load ceiling is ignored when memory is plentiful — load 41 at 90 % free allows a start.
  it('load above 40 refuses even at 90% free', () => {
    expect(slotDecision({ freePct: 90, load1: 41, runs: 0 })).toMatchObject({ allowed: false, cap: 0 });
    expect(slotDecision({ freePct: 90, load1: 40, runs: 0 })).toMatchObject({ allowed: true, cap: 4 });
  });

  // Bug: unreadable load (NaN) is read as "no load" and opens a slot.
  it('unreadable load fails closed', () => {
    expect(slotDecision({ freePct: 90, load1: NaN, runs: 0 })).toMatchObject({ allowed: false, cap: 0 });
  });

  // Bug: off-by-one on the band edge — 49 % free gets cap 4 instead of 3; 35 falls into cap 0.
  it('band edges: 49 → cap 3, 50 → cap 4, 35 → cap 3, 34 → cap 0', () => {
    expect(slotDecision({ freePct: 49, load1: 1, runs: 0 }).cap).toBe(3);
    expect(slotDecision({ freePct: 50, load1: 1, runs: 0 }).cap).toBe(4);
    expect(slotDecision({ freePct: 35, load1: 1, runs: 0 }).cap).toBe(3);
    expect(slotDecision({ freePct: 34, load1: 1, runs: 0 }).cap).toBe(0);
  });

  // Bug: `runs <= cap` instead of `runs < cap` — a fourth run starts when cap is 3.
  it('runs equal to cap is refused', () => {
    expect(slotDecision({ freePct: 42, load1: 12, runs: 3 })).toMatchObject({ allowed: false, cap: 3 });
    expect(slotDecision({ freePct: 42, load1: 12, runs: 2 }).allowed).toBe(true);
  });

  // Bug: a missing run count (pgrep unavailable) is read as 0 runs.
  it('unmeasurable run count fails closed', () => {
    for (const runs of [null, NaN, -1, 1.5]) {
      expect(slotDecision({ freePct: 90, load1: 1, runs }).allowed).toBe(false);
    }
  });

  // Bug: the owner override still requires readable data and so cannot unblock a broken probe.
  it('override bypasses without data', () => {
    expect(slotDecision({ freePct: null, load1: null, runs: null, override: true })).toMatchObject({
      allowed: true,
      reason: 'override',
    });
    // a truthy non-boolean is not an override
    expect(slotDecision({ freePct: null, load1: 1, runs: 0, override: 'yes' }).allowed).toBe(false);
  });
});

describe('busyDecision', () => {
  // Bug: a rollout 29 min old is excluded (e.g. counts treated as boolean-false at 1) and the repo reads as free.
  it('one fresh codex rollout makes the repo busy', () => {
    expect(busyDecision({ codexRolloutsFresh: 1, lockFresh: 0 }).busy).toBe(true);
    expect(busyDecision({ codexRolloutsFresh: 0, lockFresh: 1 }).busy).toBe(true);
    expect(busyDecision({ codexRolloutsFresh: 0, lockFresh: 0 }).busy).toBe(false);
  });

  // Bug: a missing lock count (repo dir unreadable) is treated as free.
  it('missing counts are busy', () => {
    expect(busyDecision({ codexRolloutsFresh: 0, lockFresh: null }).busy).toBe(true);
    expect(busyDecision({ codexRolloutsFresh: NaN, lockFresh: 0 }).busy).toBe(true);
  });

  // Bug: the busy override is ignored, so the owner cannot start in an occupied repo.
  it('override makes the repo not busy', () => {
    expect(busyDecision({ codexRolloutsFresh: 3, lockFresh: null, override: true })).toEqual({
      busy: false,
      reason: 'override',
    });
  });
});

describe('chooseAccount', () => {
  const row = (o) => ({ slot: 1, active: false, p7: 10, p5: 10, resetAt: inDays(5), ...o });

  // Bug: a row without usage numbers is read as 0 % used and becomes the target.
  it('account without data is never chosen', () => {
    const rows = [
      row({ slot: 1, alias: 'a', p7: null, resetAt: inDays(1) }),
      row({ slot: 2, alias: 'b', p7: 50, resetAt: inDays(6) }),
      row({ slot: 3, alias: 'c', p5: 5, resetAt: 'not-a-date' }),
    ];
    const d = chooseAccount(rows, NOW);
    expect(d).toMatchObject({ action: 'switch', target: 2 });
    expect(d.reason).toContain('2 row(s) skipped');
  });

  // Bug: 97 % is treated as usable (`<=` instead of `<`) and the host switches onto an exhausted account.
  it('p5 or p7 at 97 is not usable', () => {
    expect(chooseAccount([row({ alias: 'a', p5: 97 })], NOW).action).toBe('none');
    expect(chooseAccount([row({ alias: 'a', p7: 97 })], NOW).action).toBe('none');
  });

  // Bug: fair-by-consumption runs across all rows, so a far account with low usage beats the near reset.
  it('a near reset is preferred over a far low-usage account', () => {
    const rows = [
      row({ slot: 1, alias: 'far', p7: 5, resetAt: inDays(6) }),
      row({ slot: 2, alias: 'near', p7: 80, resetAt: inDays(2) }),
      row({ slot: 3, alias: 'nearer', p7: 90, resetAt: inDays(1) }),
    ];
    expect(chooseAccount(rows, NOW)).toMatchObject({ action: 'switch', target: 3 });
  });

  // Bug: without a near reset the choice is not the lowest 7-day usage.
  it('without a near reset the lowest p7 wins', () => {
    const rows = [row({ slot: 1, alias: 'x', p7: 60, resetAt: inDays(4) }), row({ slot: 2, alias: 'y', p7: 20, resetAt: inDays(6) })];
    expect(chooseAccount(rows, NOW).target).toBe(2);
  });

  // Bug: no reset tolerance — a 0.2 s earlier reset elsewhere makes the host flap between accounts.
  it('stays on the active account when the target reset is only 0.2 s earlier', () => {
    const t = NOW + 86400000;
    const rows = [
      row({ slot: 1, alias: 'act', active: true, p7: 50, resetAt: new Date(t).toISOString() }),
      row({ slot: 2, alias: 'other', p7: 10, resetAt: new Date(t - 200).toISOString() }),
    ];
    expect(chooseAccount(rows, NOW)).toMatchObject({ action: 'stay', target: 1 });
    // beyond the 1800 s tolerance it switches
    rows[1].resetAt = new Date(t - 1801 * 1000).toISOString();
    expect(chooseAccount(rows, NOW)).toMatchObject({ action: 'switch', target: 2 });
  });

  // Bug: tolerance keeps an exhausted active account instead of switching away.
  it('an unusable active account is left even within tolerance', () => {
    const t = NOW + 86400000;
    const rows = [
      row({ slot: 1, alias: 'act', active: true, p7: 99, resetAt: new Date(t).toISOString() }),
      row({ slot: 2, alias: 'other', p7: 10, resetAt: new Date(t - 200).toISOString() }),
    ];
    expect(chooseAccount(rows, NOW)).toMatchObject({ action: 'switch', target: 2 });
  });

  // Bug: no usable row yields a target anyway (or throws) instead of 'none'.
  it('no usable account → none', () => {
    expect(chooseAccount([row({ p7: 99 }), null, 'junk'], NOW)).toMatchObject({ action: 'none', target: null });
    expect(chooseAccount(undefined, NOW).action).toBe('none');
  });

  // Bug: with no active row the function returns stay (or crashes dereferencing the active row).
  it('no active row → switch', () => {
    expect(chooseAccount([row({ alias: 'a' })], new Date(NOW))).toMatchObject({ action: 'switch', target: 1 });
  });

  // Bug (F2): the tie tolerance is one-sided, so an active account resetting a day EARLIER than the
  // low-consumption target is kept — "far accounts are fair by consumption" never switches.
  it('far branch: a much earlier active reset does not cancel the low-consumption switch', () => {
    const rows = [
      row({ slot: 1, alias: 'act', active: true, p7: 80, resetAt: inDays(5) }),
      row({ slot: 2, alias: 'low', p7: 5, resetAt: inDays(6) }),
    ];
    expect(chooseAccount(rows, NOW)).toMatchObject({ action: 'switch', target: 2 });
  });

  // Bug (F3): a reset date in the past is stale data, yet it counts as the nearest reset and wins.
  it('a row whose reset lies in the past is not chosen', () => {
    const rows = [
      row({ slot: 1, alias: 'stale', p7: 10, resetAt: inDays(-2) }),
      row({ slot: 2, alias: 'fresh', p7: 50, resetAt: inDays(6) }),
    ];
    const d = chooseAccount(rows, NOW);
    expect(d).toMatchObject({ action: 'switch', target: 2 });
    expect(d.reason).toContain('1 row(s) skipped');
  });

  // Bug (F4): a malformed row (non-callable toString on the alias, object slot) makes the reason
  // template throw, so the whole account watch crashes instead of skipping the row.
  it('malformed rows are skipped, never thrown on', () => {
    const rows = [
      { slot: {}, alias: { toString: 1 }, active: true, p7: 10, p5: 10, resetAt: inDays(1) },
      { slot: 4, alias: { toString: 1 }, active: false, p7: 20, p5: 10, resetAt: inDays(2) },
    ];
    let d;
    expect(() => {
      d = chooseAccount(rows, NOW);
    }).not.toThrow();
    expect(d).toMatchObject({ action: 'switch', target: 4 });
    expect(d.reason).toContain('1 row(s) skipped');
  });
});

describe('CLI wiring', () => {
  const run = (mode, input) => spawnSync(process.execPath, [MODULE, mode], { input, encoding: 'utf8' });

  // Bug: the CLI ignores stdin (or its exit code ignores the decision), so the shell gate always passes.
  it('slot: exit 0 when allowed, 1 when refused, 2 on bad JSON', () => {
    const ok = run('slot', JSON.stringify({ freePct: 60, load1: 3, runs: 0 }));
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ allowed: true, cap: 4 });
    const no = run('slot', JSON.stringify({ freePct: 60, load1: 3, runs: 4 }));
    expect(no.status).toBe(1);
    expect(JSON.parse(no.stdout).allowed).toBe(false);
    expect(run('slot', 'not json').status).toBe(2);
  });

  // Bug (F1, SEC-008): an account alias leaks through the decision line (target/reason) or the
  // wrapper's stderr — for both a stay and a switch decision.
  const inDaysLive = (d) => new Date(Date.now() + d * 86400000).toISOString();
  const aliases = ['rowsecret-a', 'rowsecret-b', 'ops-mailbox@example.org'];
  const fixtures = {
    stay: [
      { slot: 1, alias: aliases[0], active: true, p7: 40, p5: 10, resetAt: inDaysLive(1), rawField: 'raw-row-marker' },
      { slot: 2, alias: aliases[1], active: false, p7: 99, p5: 10, resetAt: inDaysLive(1) },
      { slot: 3, alias: aliases[2], active: false, p7: 50, p5: 10, resetAt: inDaysLive(6) },
    ],
    switch: [
      { slot: 1, alias: aliases[0], active: true, p7: 99, p5: 10, resetAt: inDaysLive(1), rawField: 'raw-row-marker' },
      { slot: 2, alias: aliases[1], active: false, p7: 20, p5: 10, resetAt: inDaysLive(2) },
      { slot: 3, alias: aliases[2], active: false, p7: 50, p5: 10, resetAt: inDaysLive(6) },
    ],
  };
  for (const [action, accounts] of Object.entries(fixtures)) {
    it(`account-check.sh prints only the decision line, no alias (${action})`, () => {
      const r = spawnSync('bash', [ACCOUNT_SH], {
        encoding: 'utf8',
        env: { ...process.env, FAKE_JSON: JSON.stringify({ accounts }), NAVIGATOR_ACCOUNT_CMD: 'printf %s "$FAKE_JSON"' },
      });
      expect(r.status).toBe(0);
      const lines = r.stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^account: \{/);
      expect(JSON.parse(lines[0].slice('account: '.length)).action).toBe(action);
      const out = r.stdout + r.stderr;
      expect(out).not.toContain('raw-row-marker');
      for (const a of aliases) expect(out).not.toContain(a);
    });
  }
});
