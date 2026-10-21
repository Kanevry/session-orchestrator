import { describe, it, expect } from 'vitest';
import { $, quote } from 'zx';
import { $ as configuredDollar, configureZx } from '../../scripts/lib/zx.mjs';

const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const wsl = 'C:\\Windows\\System32\\bash.exe';
const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };

function configure(target, files = [gitBash], overrides = {}) {
  configureZx({ platform: 'win32', target, env, existsSync: file => files.includes(file), ...overrides });
}

describe('Windows zx process boundary (#1612)', () => {
  it('re-exports the singleton used by direct test imports', () => {
    expect(configuredDollar).toBe($);
  });

  it.each([wsl, 'c:\\WINDOWS\\system32\\BASH.EXE', ''])('replaces WSL/empty shell %j and protects Windows path escapes', shell => {
    const target = { shell, quote };
    configure(target);
    expect(target.shell).toBe(gitBash);
    expect(target.quote('C:\\Users\\bernh\\repo')).toBe(String.raw`$'C:\\\\Users\\\\bernh\\\\repo'`);
  });

  it.each([gitBash, 'D:\\GIT\\BIN\\BASH.EXE', 'D:/msys64/usr/bin/bash.exe'])('only adjusts quoting for existing Git/MSYS shell %j', shell => {
    const target = { shell, quote };
    configure(target, [], { existsSync: () => { throw new Error('must not search'); } });
    expect(target.shell).toBe(shell);
    expect(target.quote("a'b\n\t")).toBe(String.raw`$'a\\'b\\n\\t'`);
  });

  it.each([wsl, ''])('leaves shell %j and custom quoting intact without Git Bash', shell => {
    const customQuote = value => value;
    const target = { shell, quote: customQuote };
    configure(target, []);
    expect(target).toEqual({ shell, quote: customQuote });
  });

  it.each(['darwin', 'linux'])('does nothing on %s, including filesystem lookup', platform => {
    const target = { shell: wsl, quote };
    configure(target, [], { platform, existsSync: () => { throw new Error('must not search'); } });
    expect(target).toEqual({ shell: wsl, quote });
  });

  it('preserves an explicitly selected unrelated shell', () => {
    const target = { shell: 'C:\\tools\\bash.exe', quote };
    configure(target);
    expect(target).toEqual({ shell: 'C:\\tools\\bash.exe', quote });
  });

  it('is idempotent rather than wrapping the already wrapped quote', () => {
    const target = { shell: wsl, quote };
    configure(target);
    const configuredQuote = target.quote;
    configure(target);
    expect(target.quote).toBe(configuredQuote);
    expect(target.quote('C:\\bernh\\repo\\')).toBe(String.raw`$'C:\\\\bernh\\\\repo\\\\'`);
  });

  it.each([
    ['ProgramFiles before x86 and PATH', [gitBash, 'D:\\x86\\Git\\bin\\bash.exe', 'E:\\Git\\cmd\\git.exe', 'E:\\Git\\bin\\bash.exe'], gitBash],
    ['x86 fallback', ['D:\\x86\\Git\\bin\\bash.exe', 'E:\\Git\\cmd\\git.exe', 'E:\\Git\\bin\\bash.exe'], 'D:\\x86\\Git\\bin\\bash.exe'],
    ['git.exe PATH fallback', ['E:\\Git\\cmd\\git.exe', 'E:\\Git\\bin\\bash.exe'], 'E:\\Git\\bin\\bash.exe'],
  ])('uses %s', (_label, files, expected) => {
    const target = { shell: wsl, quote };
    configure(target, files, { env: { ...env, 'ProgramFiles(x86)': 'D:\\x86', PATH: 'C:\\other;"E:\\Git\\cmd"' } });
    expect(target.shell).toBe(expected);
    expect(target.quote('\\n')).toBe(String.raw`$'\\\\n'`);
  });
});
