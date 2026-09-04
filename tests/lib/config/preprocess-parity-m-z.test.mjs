/**
 * preprocess-parity-m-z.test.mjs — the #1162 line-preprocessing contract, pinned
 * once for every block parser in the M–Z half of `scripts/lib/config/`.
 *
 * Two bugs, one shape (see `scripts/lib/config/block-preprocess.mjs`):
 *   (a) a block commented out with a multi-line `<!-- … -->` was read as LIVE
 *       config — disabling a key ARMED it;
 *   (b) the bold-bullet rendering of a sub-key (`- **enabled:** true`) matched
 *       no sub-key regex, so the key silently fell back to its default.
 *
 * Both are asserted here against the REAL parser (never a stub), and each case
 * is guarded against vacuity: `plain` must first be shown to differ from the
 * parser's absent-block result, otherwise "commented === default" would pass
 * for a fixture that never said anything.
 */
import { describe, it, expect } from 'vitest';

import { _parseMemory } from '../../../scripts/lib/config/memory.mjs';
import { _parseMocStaleness } from '../../../scripts/lib/config/moc-staleness.mjs';
import { _parsePersonaGateWave } from '../../../scripts/lib/config/persona-gate-wave.mjs';
import { _parseReconcile } from '../../../scripts/lib/config/reconcile.mjs';
import { _parseRemoteHosts } from '../../../scripts/lib/config/remote-hosts.mjs';
import { _parseSkillEvolution } from '../../../scripts/lib/config/skill-evolution.mjs';
import { _parseSlopcheck } from '../../../scripts/lib/config/slopcheck.mjs';
import { _parseStateMdLock } from '../../../scripts/lib/config/state-md-lock.mjs';
import { _parseTemplatesFirst } from '../../../scripts/lib/config/templates-first.mjs';
import { _parseTest } from '../../../scripts/lib/config/test.mjs';
import { _parseVaultMirrorQuality } from '../../../scripts/lib/config/vault-mirror-quality.mjs';
import { _parseVaultStaleness } from '../../../scripts/lib/config/vault-staleness.mjs';
import { _parseVaultSync } from '../../../scripts/lib/config/vault-sync.mjs';
import { _parseVerificationAutoFix } from '../../../scripts/lib/config/verification-auto-fix.mjs';
import { _parseWaveReviewers } from '../../../scripts/lib/config/wave-reviewers.mjs';
import { _parseWorktreeOrphans } from '../../../scripts/lib/config/worktree-orphans.mjs';

/** Wrap a block in a multi-line HTML comment, opener at line start (#1162a). */
const commented = (block) => `<!--\n${block}-->\n`;

/**
 * The 15 bold-normalising ("standard") parsers of the M–Z half. `remote-hosts`
 * is deliberately absent — it is the dash-RECORD parser, covered separately.
 *
 * @type {Array<{name: string, parse: (c: string) => unknown, plain: string, bold: string}>}
 */
const STANDARD = [
  {
    name: 'memory',
    parse: _parseMemory,
    plain: 'memory:\n  banner:\n    enabled: false\n',
    bold: 'memory:\n  banner:\n    - **enabled:** false\n',
  },
  {
    name: 'moc-staleness',
    parse: _parseMocStaleness,
    plain: 'moc-staleness:\n  enabled: true\n',
    bold: 'moc-staleness:\n  - **enabled:** true\n',
  },
  {
    name: 'persona-gate-wave',
    parse: _parsePersonaGateWave,
    plain: 'persona-gate-wave:\n  enabled: true\n',
    bold: 'persona-gate-wave:\n  - **enabled:** true\n',
  },
  {
    name: 'reconcile',
    parse: _parseReconcile,
    plain: 'reconcile:\n  enabled: true\n',
    bold: 'reconcile:\n  - **enabled:** true\n',
  },
  {
    name: 'skill-evolution',
    parse: _parseSkillEvolution,
    plain: 'skill-evolution:\n  autonomy: advisory\n',
    bold: 'skill-evolution:\n  - **autonomy:** advisory\n',
  },
  {
    name: 'slopcheck',
    parse: _parseSlopcheck,
    plain: 'slopcheck:\n  enabled: true\n',
    bold: 'slopcheck:\n  - **enabled:** true\n',
  },
  {
    name: 'state-md-lock',
    parse: _parseStateMdLock,
    plain: 'state-md-lock:\n  enabled: false\n',
    bold: 'state-md-lock:\n  - **enabled:** false\n',
  },
  {
    name: 'templates-first',
    parse: _parseTemplatesFirst,
    plain: 'templates-first:\n  enabled: false\n',
    bold: 'templates-first:\n  - **enabled:** false\n',
  },
  {
    name: 'test',
    parse: _parseTest,
    plain: 'test:\n  enabled: true\n',
    bold: 'test:\n  - **enabled:** true\n',
  },
  {
    name: 'vault-mirror (vault-mirror-quality.mjs)',
    parse: _parseVaultMirrorQuality,
    plain: 'vault-mirror:\n  quality:\n    min-confidence: 0.9\n',
    bold: 'vault-mirror:\n  quality:\n    - **min-confidence:** 0.9\n',
  },
  {
    name: 'vault-staleness',
    parse: _parseVaultStaleness,
    plain: 'vault-staleness:\n  enabled: true\n',
    bold: 'vault-staleness:\n  - **enabled:** true\n',
  },
  {
    name: 'vault-sync',
    parse: _parseVaultSync,
    plain: 'vault-sync:\n  enabled: true\n',
    bold: 'vault-sync:\n  - **enabled:** true\n',
  },
  {
    name: 'verification-auto-fix',
    parse: _parseVerificationAutoFix,
    plain: 'verification-auto-fix:\n  enabled: true\n',
    bold: 'verification-auto-fix:\n  - **enabled:** true\n',
  },
  {
    name: 'wave-reviewers',
    parse: _parseWaveReviewers,
    plain: 'wave-reviewers:\n  enabled: true\n',
    bold: 'wave-reviewers:\n  - **enabled:** true\n',
  },
  {
    name: 'worktree-orphans',
    parse: _parseWorktreeOrphans,
    plain: 'worktree-orphans:\n  enabled: true\n',
    bold: 'worktree-orphans:\n  - **enabled:** true\n',
  },
];

describe('#1162 preprocess parity — M–Z block parsers', () => {
  describe.each(STANDARD)('$name', ({ parse, plain, bold }) => {
    it('the fixture is non-default (guards the two asserts below against vacuity)', () => {
      expect(parse(plain)).not.toEqual(parse(''));
    });

    it('an HTML-commented block yields the DEFAULT, not the commented-out value', () => {
      expect(parse(commented(plain))).toEqual(parse(''));
    });

    it('a bold-bullet sub-key parses identically to the plain rendering', () => {
      expect(parse(bold)).toEqual(parse(plain));
    });
  });

  describe('remote-hosts (dash-RECORD parser — NoDash variant)', () => {
    const plain =
      'remote-hosts:\n  - alias: m5\n    roles-allowed: [test]\n  - alias: m6\n    roles-allowed: [ui]\n';

    it('the fixture is non-default', () => {
      expect(_parseRemoteHosts(plain)).not.toEqual(_parseRemoteHosts(''));
    });

    it('an HTML-commented block yields the DEFAULT (no hosts)', () => {
      expect(_parseRemoteHosts(commented(plain))).toEqual([]);
    });

    it('the leading `- ` stays a RECORD boundary — two records, not one', () => {
      const records = _parseRemoteHosts(plain);
      expect(records).toHaveLength(2);
      expect(records.map((r) => r.alias)).toEqual(['m5', 'm6']);
    });
  });
});
