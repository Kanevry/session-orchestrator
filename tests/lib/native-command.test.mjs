import { describe, expect, it } from 'vitest';
import { commandOnPath, resolveNativeCommand, spawnNativeSync } from '../../scripts/lib/native-command.mjs';

describe('native command launching', () => {
  it('uses npm beside nvm-windows Node while preserving argument boundaries', () => {
    expect(resolveNativeCommand('npm', ['pack', 'a & b', '"quoted"', '%PATH%', ''], {
      platform: 'win32', execPath: 'C:\\nvm4w\\nodejs\\node.exe', env: {},
      exists: (file) => file === 'C:\\nvm4w\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    })).toEqual({ cmd: 'C:\\nvm4w\\nodejs\\node.exe', args: [
      'C:\\nvm4w\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'pack', 'a & b', '"quoted"', '%PATH%', '',
    ] });
  });

  it('finds separately installed npm via case-insensitive Windows Path', () => {
    expect(resolveNativeCommand('npm.cmd', ['--version'], {
      platform: 'win32', execPath: 'C:\\node\\node.exe', env: { Path: ';relative;"C:\\npm tools"' },
      exists: (file) => file === 'C:\\npm tools\\node_modules\\npm\\bin\\npm-cli.js',
    })).toEqual({ cmd: 'C:\\node\\node.exe', args: ['C:\\npm tools\\node_modules\\npm\\bin\\npm-cli.js', '--version'] });
  });

  it('fails clearly when npm is missing instead of executing a batch shim', () => {
    expect(() => resolveNativeCommand('npm', ['ci'], {
      platform: 'win32', execPath: 'C:\\node\\node.exe', env: {}, exists: () => false,
    })).toThrow('Cannot locate npm-cli.js');
  });

  it('keeps Unix npm resolution unchanged', () => {
    expect(resolveNativeCommand('npm', ['ci'], { platform: 'linux' })).toEqual({ cmd: 'npm', args: ['ci'] });
  });

  it('delivers shell metacharacters, quotes, empty args and trailing slashes literally', () => {
    const result = spawnNativeSync(process.execPath, [
      '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--',
      'a & echo injected', '%PATH%', '"quoted"', '', 'C:\\space dir\\',
    ], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['a & echo injected', '%PATH%', '"quoted"', '', 'C:\\space dir\\']);
  });

  it('finds Node and rejects a missing executable on the current platform', () => {
    expect(commandOnPath('node')).toBe(true);
    expect(commandOnPath('so-definitely-missing-executable-90021')).toBe(false);
  });
});
