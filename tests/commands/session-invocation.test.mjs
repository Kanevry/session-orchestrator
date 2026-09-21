import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveSessionInvocation } from '@lib/session-invocation.mjs';

const cli = fileURLToPath(new URL('../../scripts/resolve-session-invocation.mjs', import.meta.url));

// Regression: the whole free-text argument used to be compared with the mode enum.
describe('session invocation resolution', () => {
  it.each(['', ' \n\t ', undefined])('uses deep only when no mode is supplied (%j)', (input) => {
    expect(resolveSessionInvocation(input)).toEqual({ sessionType: 'deep', context: '' });
  });

  it.each(['housekeeping', 'feature', 'deep'])(
    'keeps explicit %s with trailing task context',
    (mode) => {
      expect(resolveSessionInvocation(`${mode} mit parallelen Subagents und in Wellen`)).toEqual({
        sessionType: mode,
        context: 'mit parallelen Subagents und in Wellen',
      });
    },
  );

  it('resolves ultradeep with Unicode whitespace without dropping its profile or context', () => {
    expect(resolveSessionInvocation(' \tultradeep\u2003prüfe „Start“\nund Go/Close  ')).toEqual({
      sessionType: 'deep',
      profile: 'ultradeep',
      context: 'prüfe „Start“\nund Go/Close  ',
    });
  });

  it.each(['unknown', 'Deep', 'housekeeping-extra'])(
    'reports invalid first token %s and falls back',
    (mode) => {
      expect(resolveSessionInvocation(`${mode} deep text`)).toEqual({
        sessionType: 'deep',
        context: 'deep text',
        invalidMode: mode,
      });
    },
  );

  it('keeps quotes, shell syntax and mode-like text as inert task context over the real CLI', () => {
    const context =
      'prüfe "$HOME" $(printf injected) `printf injected`; ultradeep\n--profile ultradeep \t\n';
    const result = spawnSync(process.execPath, [cli, '--json'], {
      input: `housekeeping ${context}`,
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ sessionType: 'housekeeping', context });
  });

  it('returns the fallback as data and reports the invalid mode on stderr', () => {
    const result = spawnSync(process.execPath, [cli, '--json'], {
      input: 'invalid mit Kontext',
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      sessionType: 'deep',
      context: 'mit Kontext',
      invalidMode: 'invalid',
    });
    expect(result.stderr).toContain("Invalid session type 'invalid'");
  });

  it('rejects positional arguments so task text cannot become CLI options', () => {
    const result = spawnSync(process.execPath, [cli, 'housekeeping'], {
      input: '',
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });
});
