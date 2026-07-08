/**
 * handover-gate.test.mjs — Unit tests for scripts/lib/config/handover-gate.mjs (#769)
 *
 * Covers:
 *   _parseHandoverGate — tolerant top-level `handover-gate:` block parser:
 *     - absent block ⇒ defaults, no WARN
 *     - full explicit block (enabled + max-open-questions)
 *     - max-open-questions: 0 is a VALID value (no WARN)
 *     - malformed max-open-questions ⇒ fallback 3 + stderr WARN
 *     - negative max-open-questions ⇒ fallback 3 + stderr WARN
 *     - partial blocks (one key present, the other defaulted)
 *     - enabled parsing is case-insensitive on the literal "false"
 *
 *   parseSessionConfig integration:
 *     - surfaces cfg['handover-gate'] end-to-end through the full Session Config
 *       parser, using a hermetic hostPaths ctx (#783 discipline) so the host's
 *       real owner.yaml cannot bleed into committed-value assertions.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { _parseHandoverGate } from '@lib/config/handover-gate.mjs';
import { parseSessionConfig } from '@lib/config.mjs';

// ---------------------------------------------------------------------------
// absent block
// ---------------------------------------------------------------------------

describe('_parseHandoverGate — absent block', () => {
  it('returns the documented defaults when the handover-gate: block is completely absent', () => {
    expect(_parseHandoverGate('')).toEqual({ enabled: true, 'max-open-questions': 3 });
  });

  it('returns the documented defaults when only other blocks are present', () => {
    const content = ['persistence: true', 'vcs: gitlab', ''].join('\n');
    expect(_parseHandoverGate(content)).toEqual({ enabled: true, 'max-open-questions': 3 });
  });

  it('emits no stderr WARN when the block is absent', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    _parseHandoverGate('persistence: true\n');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// full explicit block
// ---------------------------------------------------------------------------

describe('_parseHandoverGate — full explicit block', () => {
  it('parses enabled: false and max-open-questions: 5', () => {
    const content = ['handover-gate:', '  enabled: false', '  max-open-questions: 5', ''].join(
      '\n'
    );
    expect(_parseHandoverGate(content)).toEqual({ enabled: false, 'max-open-questions': 5 });
  });

  it('parses enabled: true explicitly', () => {
    const content = ['handover-gate:', '  enabled: true', '  max-open-questions: 2', ''].join(
      '\n'
    );
    expect(_parseHandoverGate(content)).toEqual({ enabled: true, 'max-open-questions': 2 });
  });
});

// ---------------------------------------------------------------------------
// max-open-questions: 0 is a valid value, not a malformed fallback
// ---------------------------------------------------------------------------

describe('_parseHandoverGate — max-open-questions: 0 is valid', () => {
  it('accepts 0 as the parsed value', () => {
    const content = ['handover-gate:', '  max-open-questions: 0', ''].join('\n');
    expect(_parseHandoverGate(content)).toEqual({ enabled: true, 'max-open-questions': 0 });
  });

  it('emits no stderr WARN for max-open-questions: 0', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const content = ['handover-gate:', '  max-open-questions: 0', ''].join('\n');
    _parseHandoverGate(content);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// malformed / negative max-open-questions ⇒ fallback + WARN
// ---------------------------------------------------------------------------

describe('_parseHandoverGate — malformed max-open-questions falls back with a WARN', () => {
  let stderrCapture = [];

  const captureStderr = () => {
    stderrCapture = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrCapture.push(String(msg));
      return true;
    });
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to 3 for a non-numeric value', () => {
    captureStderr();
    const content = ['handover-gate:', '  max-open-questions: abc', ''].join('\n');
    expect(_parseHandoverGate(content)).toEqual({ enabled: true, 'max-open-questions': 3 });
  });

  it('emits a stderr WARN naming max-open-questions for a non-numeric value', () => {
    captureStderr();
    const content = ['handover-gate:', '  max-open-questions: abc', ''].join('\n');
    _parseHandoverGate(content);
    const warns = stderrCapture.filter((m) => m.includes('max-open-questions'));
    expect(warns).toHaveLength(1);
  });

  it('falls back to 3 for a negative value', () => {
    captureStderr();
    const content = ['handover-gate:', '  max-open-questions: -1', ''].join('\n');
    expect(_parseHandoverGate(content)).toEqual({ enabled: true, 'max-open-questions': 3 });
  });

  it('emits a stderr WARN naming max-open-questions for a negative value', () => {
    captureStderr();
    const content = ['handover-gate:', '  max-open-questions: -1', ''].join('\n');
    _parseHandoverGate(content);
    const warns = stderrCapture.filter((m) => m.includes('max-open-questions'));
    expect(warns).toHaveLength(1);
  });

  it('falls back to 3 for an empty value', () => {
    captureStderr();
    const content = ['handover-gate:', '  max-open-questions: ', ''].join('\n');
    expect(_parseHandoverGate(content)).toEqual({ enabled: true, 'max-open-questions': 3 });
  });
});

// ---------------------------------------------------------------------------
// partial blocks — one key present, the other defaulted
// ---------------------------------------------------------------------------

describe('_parseHandoverGate — partial blocks', () => {
  it('applies only the enabled override when max-open-questions is absent', () => {
    const content = ['handover-gate:', '  enabled: false', ''].join('\n');
    expect(_parseHandoverGate(content)).toEqual({ enabled: false, 'max-open-questions': 3 });
  });

  it('applies only the max-open-questions override when enabled is absent', () => {
    const content = ['handover-gate:', '  max-open-questions: 7', ''].join('\n');
    expect(_parseHandoverGate(content)).toEqual({ enabled: true, 'max-open-questions': 7 });
  });
});

// ---------------------------------------------------------------------------
// enabled parsing — case-insensitive "false" literal
// ---------------------------------------------------------------------------

describe('_parseHandoverGate — enabled parsing', () => {
  it('treats an uppercase FALSE the same as lowercase false', () => {
    const content = ['handover-gate:', '  enabled: FALSE', ''].join('\n');
    expect(_parseHandoverGate(content).enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatting tolerance — stops at the next top-level key, strips inline comments
// ---------------------------------------------------------------------------

describe('_parseHandoverGate — formatting tolerance', () => {
  it('stops scanning at the next top-level key', () => {
    const content = [
      'handover-gate:',
      '  enabled: false',
      'persistence: true',
      '',
    ].join('\n');
    expect(_parseHandoverGate(content)).toEqual({ enabled: false, 'max-open-questions': 3 });
  });

  it('strips inline comments from values', () => {
    const content = [
      'handover-gate:',
      '  max-open-questions: 4        # in-gate question cap',
      '',
    ].join('\n');
    expect(_parseHandoverGate(content)).toEqual({ enabled: true, 'max-open-questions': 4 });
  });
});

// ---------------------------------------------------------------------------
// parseSessionConfig integration
// ---------------------------------------------------------------------------

describe('parseSessionConfig integration', () => {
  // Hermetic ctx (issue #783): the default hostPaths tier reads the REAL
  // owner.yaml on this host — injecting an empty ctx pins the COMMITTED
  // default/fixture values for these assertions.
  const hermetic = { hostPaths: { env: {}, ownerConfig: undefined } };

  it('surfaces cfg["handover-gate"] with explicit overrides from the full document', () => {
    const content = [
      '# Project',
      '',
      '## Session Config',
      '',
      'persistence: true',
      '',
      'handover-gate:',
      '  enabled: false',
      '  max-open-questions: 5',
      '',
    ].join('\n');
    const config = parseSessionConfig(content, hermetic);
    expect(config['handover-gate']).toEqual({ enabled: false, 'max-open-questions': 5 });
  });

  it('defaults cfg["handover-gate"] when the block is absent from the document', () => {
    const content = ['# Project', '', '## Session Config', '', 'persistence: true', ''].join(
      '\n'
    );
    const config = parseSessionConfig(content, hermetic);
    expect(config['handover-gate']).toEqual({ enabled: true, 'max-open-questions': 3 });
  });
});
