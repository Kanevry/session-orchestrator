/**
 * session-config-heading-ssot.test.mjs — #968 item 1.
 *
 * The repo carried TWELVE independent comparisons against the `## Session
 * Config` heading. This file pins the two facts that de-duplication is FOR,
 * both of which were live defects rather than style drift:
 *
 *   1. No consumer's predicate accepts a heading the SSOT rejects. A looser
 *      comparator reports "the block is present" for a document whose every
 *      runtime config key silently falls back to its default.
 *   2. Every consumer sees the WHOLE block body. `category4.mjs` did not:
 *      its `(?=^## |\s*$)` lookahead truncated the capture to the first line.
 *
 * Deliberately table-driven: one `it.each` per fact rather than one `it()` per
 * site, so adding a thirteenth consumer costs a table row, not a test.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  isSessionConfigHeading,
  findSessionConfigBlock,
  SESSION_CONFIG_HEADING,
  _extractConfigSection,
} from '../../../scripts/lib/config/section-extractor.mjs';
import { hasVaultConfig } from '../../../scripts/lib/product-repo-detect.mjs';
import { _isConfigWeakeningAllowed } from '../../../scripts/lib/config/config-protection.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

// ── The heading forms that separate a loose comparator from the SSOT ────────
// `accepted` is the SSOT verdict — every consumer below must agree with it.
const HEADING_FORMS = [
  { form: '## Session Config', label: 'canonical', accepted: true },
  { form: '## Session Config\r', label: 'CRLF checkout', accepted: true },
  { form: '## Session Config  ', label: 'trailing spaces', accepted: false },
  { form: '## Session Config\t', label: 'trailing tab', accepted: false },
  { form: '##  Session Config', label: 'two spaces after ##', accepted: false },
  { form: '## Session Config Convention', label: 'longer heading', accepted: false },
  { form: '### Session Config', label: 'H3 not H2', accepted: false },
  { form: '## Session Config <!-- x -->', label: 'trailing HTML comment', accepted: false },
];

/** Build a document whose Session Config block declares `key`. */
function doc(heading, key = 'persistence: true') {
  return `# Title\n\nintro\n\n${heading}\n\n${key}\nwaves: 5\n\n## After\ntail\n`;
}

describe('#968 — one heading, one authority', () => {
  it.each(HEADING_FORMS)(
    'isSessionConfigHeading: $label -> $accepted',
    ({ form, accepted }) => {
      expect(isSessionConfigHeading(form)).toBe(accepted);
    },
  );

  // Each entry is a consumer that previously carried its own comparator. The
  // bug caught: a consumer answering "yes, configured" for a heading the
  // runtime parser cannot see (product-repo-detect skipped offering vault
  // setup; config-protection honoured a bypass in a dead block).
  const CONSUMERS = [
    {
      name: 'hasVaultConfig (product-repo-detect)',
      probe: (heading, dir) => {
        const p = join(dir, 'CLAUDE.md');
        writeFileSync(p, doc(heading, 'vault: ~/Projects/vault'));
        return hasVaultConfig(p);
      },
    },
    {
      name: '_isConfigWeakeningAllowed (config-protection)',
      probe: (heading) =>
        _isConfigWeakeningAllowed(doc(heading, 'allow-config-weakening: true')),
    },
    {
      name: '_extractConfigSection (the SSOT parser itself)',
      probe: (heading) => _extractConfigSection(doc(heading)).length > 0,
    },
    {
      name: 'findSessionConfigBlock',
      probe: (heading) => findSessionConfigBlock(doc(heading)) !== null,
    },
  ];

  for (const consumer of CONSUMERS) {
    it.each(HEADING_FORMS)(
      `${consumer.name} agrees with the SSOT: $label -> $accepted`,
      ({ form, accepted }) => {
        const dir = mkdtempSync(join(tmpdir(), 'so-heading-'));
        try {
          expect(consumer.probe(form, dir)).toBe(accepted);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  }

  it('the writer emits exactly what the comparator accepts', () => {
    // A producer and a comparator agreeing by coincidence is the same defect
    // one level down: config-writer.mjs appends SESSION_CONFIG_HEADING.
    expect(isSessionConfigHeading(SESSION_CONFIG_HEADING)).toBe(true);
  });
});

describe('#968 — findSessionConfigBlock captures the WHOLE body', () => {
  // The category4 bug: `/^## Session Config\s*\n([\s\S]*?)(?=^## |\s*$)/m`
  // stops the lazy quantifier at the first line end, because with /m the `$`
  // in `\s*$` matches at every line end.
  const TRUNCATING_RE = /^## Session Config\s*\n([\s\S]*?)(?=^## |\s*$)/m;

  it('captures a nested block three lines below the heading', () => {
    const md = doc('## Session Config', 'vault-integration:\n  enabled: true');
    const body = findSessionConfigBlock(md).body;

    expect(body).toContain('vault-integration:');
    expect(body).toContain('enabled: true');
    expect(body).toContain('waves: 5');
    // The old regex saw only the first body line — pin the contrast so a
    // regression back to it cannot pass.
    expect(TRUNCATING_RE.exec(md)[1]).not.toContain('enabled: true');
  });

  it("reads this repo's own CLAUDE.md vault-integration flag", () => {
    // The concrete escaped bug: harness-audit c4.4 scored 2/2 with
    // "vault-integration not enabled — skip" on a repo where it IS enabled,
    // because the truncated capture never reached the key.
    const claudeMd = execFileSync('cat', [join(REPO_ROOT, 'CLAUDE.md')], {
      encoding: 'utf8',
    });
    const body = findSessionConfigBlock(claudeMd).body;
    expect(/vault-integration:\s*\n\s+enabled:\s*true/im.test(body)).toBe(true);
    expect(/vault-integration:\s*\n\s+enabled:\s*true/im.test(TRUNCATING_RE.exec(claudeMd)[1])).toBe(false);
  });

  it('stops at the next H2 and reports a 1-based heading line', () => {
    const block = findSessionConfigBlock(doc('## Session Config'));
    expect(block.body).not.toContain('tail');
    expect(block.headingLine).toBe(5);
  });

  it('honours occurrence:last for docs carrying two example headings', () => {
    const md = `${doc('## Session Config', 'first: 1')}\n## Session Config\nsecond: 2\n`;
    expect(findSessionConfigBlock(md).body).toContain('first: 1');
    expect(findSessionConfigBlock(md, { occurrence: 'last' }).body).toContain('second: 2');
  });
});

describe('#968 — isVaultDir is a marker test, not a substring search', () => {
  const VALIDATOR = join(REPO_ROOT, 'skills/vault-sync/validator.mjs');

  /**
   * Run the validator against `dir`; return its stderr.
   * spawnSync, not execFileSync — execFileSync returns only stdout, so a
   * success-path stderr warning (exactly the signal under test here) would be
   * silently dropped and every assertion below would pass vacuously.
   */
  function runValidator(dir) {
    const res = spawnSync('node', [VALIDATOR, '--mode=warn'], {
      env: { ...process.env, VAULT_DIR: dir },
      encoding: 'utf8',
    });
    return { stderr: res.stderr || '', stdout: res.stdout || '' };
  }

  const LACKS_MARKERS = 'lacks vault markers';

  // Each row is a document that the old whole-file substring test
  // (`content.includes('## Session Config') && content.includes('vault-sync:')`)
  // accepted as a vault marker. Misclassification is not cosmetic: the
  // validator then crawls and enforces vault frontmatter over that tree.
  const NON_VAULT_DOCS = [
    {
      label: 'H3 heading (### includes ## from index 1)',
      body: '# Repo\n\n### Session Config\n\nvault-sync:\n  enabled: true\n',
    },
    // NOT a row: a heading inside a fenced code block. The whole-file
    // substring test matched it, but so does `_extractConfigSection` — the
    // SSOT is not fence-aware either. Teaching fence-awareness to this one
    // consumer would re-create the divergence #968 exists to remove, so the
    // limitation is shared, documented, and left to a follow-up.
    {
      label: 'real heading, but vault-sync only mentioned in prose below',
      body: '# Repo\n\n## Session Config\n\npersistence: true\n\n## Notes\n\nWe may add vault-sync: later.\n',
    },
    {
      label: 'trailing-whitespace heading the runtime cannot read',
      body: '# Repo\n\n## Session Config  \n\nvault-sync:\n  enabled: true\n',
    },
  ];

  it.each(NON_VAULT_DOCS)('rejects $label', ({ body }) => {
    const dir = mkdtempSync(join(tmpdir(), 'so-vaultdir-'));
    try {
      writeFileSync(join(dir, 'CLAUDE.md'), body);
      expect(runValidator(dir).stderr).toContain(LACKS_MARKERS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still accepts a genuine vault-sync key inside a real Session Config block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-vaultdir-'));
    try {
      writeFileSync(
        join(dir, 'CLAUDE.md'),
        '# Vault\n\n## Session Config\n\nvault-sync:\n  enabled: true\n  mode: warn\n',
      );
      expect(runValidator(dir).stderr).not.toContain(LACKS_MARKERS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still accepts the _meta/ and .obsidian/ structural markers', () => {
    for (const marker of ['_meta', '.obsidian']) {
      const dir = mkdtempSync(join(tmpdir(), 'so-vaultdir-'));
      try {
        mkdirSync(join(dir, marker));
        expect(runValidator(dir).stderr).not.toContain(LACKS_MARKERS);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
