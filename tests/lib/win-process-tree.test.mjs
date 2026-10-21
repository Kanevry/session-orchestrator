import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { killProcessGroup } from '../../scripts/lib/process-group.mjs';

const root = { ProcessId: 999999, ParentProcessId: 1, CreationDate: '/Date(123)/' };
const child = { ProcessId: 999998, ParentProcessId: root.ProcessId, CreationDate: '/Date(456)/' };

describe('Windows native cleanup boundary', () => {
  it('uses absolute PowerShell 5.1 argv and reads back the tree even when taskkill fails', async () => {
    const spawnSyncFn = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify([child, root]) })
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(child) });
    const result = await killProcessGroup(root.ProcessId, { platform: 'win32', child: live, spawnedAtMs: 0, spawnSyncFn, killFn: vi.fn(), sleepFn: async () => {}, isAliveFn: () => false });
    expect(spawnSyncFn.mock.calls[0]).toEqual([
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'],
      expect.objectContaining({ shell: false, windowsHide: true, timeout: 5000 }),
    ]);
    expect(spawnSyncFn.mock.calls[2]).toEqual(spawnSyncFn.mock.calls[0]);
    expect(result).toMatchObject({ ok: false, survivors: [child.ProcessId], error: 'taskkill exit 1' });
  });

  it.each(['bad-json', JSON.stringify({ ProcessId: root.ProcessId })])(
    'does not treat broken post-kill CIM output as an empty tree (%s)', async (stdout) => {
      const spawnSyncFn = vi.fn()
        .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(root) })
        .mockReturnValueOnce({ status: 0 })
        .mockReturnValueOnce({ status: 0, stdout });
      const result = await killProcessGroup(root.ProcessId, { platform: 'win32', child: live, spawnedAtMs: 0, spawnSyncFn, killFn: vi.fn(), sleepFn: async () => {}, isAliveFn: () => false });
      expect(result).toMatchObject({ ok: false, survivors: null, error: expect.stringContaining('nicht messbar') });
    },
  );
});

const spawnedAtMs = 10000;
const row = (id, parent, date = 10000) => ({ ProcessId: id, ParentProcessId: parent, CreationDate: date === null ? null : `/Date(${date})/` });
const live = { exitCode: null, signalCode: null };

it.each([10001, null])('R1-01 detects new descendants, including missing identity (%s)', async date => {
  const snapshotFn = vi.fn().mockReturnValueOnce([row(100, 1), row(101, 100)])
    .mockReturnValueOnce([row(102, 101, date), row(103, 102, 10002), row(104, 100, 100)]);
  const result = await killProcessGroup(100, { platform: 'win32', child: live, spawnedAtMs,
    snapshotFn, spawnSyncFn: () => ({ status: 0 }) });
  expect(result.survivors).toEqual(date === null ? null : [102, 103]);
});

it.each([null, 0])('R1-02 kills only a held root or dated descendants (exitCode %s)', async exitCode => {
  const spawnSyncFn = vi.fn(() => ({ status: 0 }));
  const snapshotFn = vi.fn().mockReturnValueOnce([row(100, 999, 12000), row(101, 100), row(102, 101), row(103, 100, 1)])
    .mockReturnValueOnce([]);
  const result = await killProcessGroup(100, { platform: 'win32', child: { exitCode, signalCode: null },
    spawnedAtMs, snapshotFn, spawnSyncFn });
  expect(spawnSyncFn.mock.calls.map(c => c[1][1])).toEqual(exitCode === null ? ['100'] : ['101', '102']);
  expect(result.survivors).toEqual([]);
});

it.each(['missing date', 'snapshot failed'])('R1-02 refuses unsafe descendant selection: %s', async mode => {
  const spawnSyncFn = vi.fn(() => ({ status: 0 }));
  const result = await killProcessGroup(100, { platform: 'win32', child: { exitCode: 0, signalCode: null }, spawnedAtMs,
    snapshotFn: () => { if (mode === 'snapshot failed') throw Error('denied'); return [row(101, 100, null)]; },
    spawnSyncFn });
  expect(spawnSyncFn).not.toHaveBeenCalled();
  expect(result).toMatchObject({ survivors: null, ok: false, error: expect.any(String) });
});

it.each([null, 0])('R1-04 skips CIM entirely with verifyTree false (exitCode %s)', async exitCode => {
  const snapshotFn = vi.fn(() => { throw Error('CIM must not run'); });
  const spawnSyncFn = vi.fn(() => ({ status: 0 }));
  const result = await killProcessGroup(100, { platform: 'win32', child: { exitCode, signalCode: null },
    spawnedAtMs, verifyTree: false, snapshotFn, spawnSyncFn });
  expect(snapshotFn).not.toHaveBeenCalled();
  expect(spawnSyncFn).toHaveBeenCalledTimes(exitCode === null ? 1 : 0);
  expect(result).toMatchObject({ survivors: null, error: expect.stringContaining('verifyTree: false') });
});

it('M2: a process older than the live root is not ours, even if it names the root as parent (#1612)', async () => {
  // Root 4321 born at T, our child 5000 at T+50; foreign 777 names 4321 as its
  // parent but was born an hour earlier (PID reuse; Windows keeps stale PPIDs).
  const T = 1_000_000_000;
  const rootRow = row(4321, 1, T);
  const ours = row(5000, 4321, T + 50);
  const foreign = row(777, 4321, T - 3_600_000);
  const spawnSyncFn = vi.fn()
    .mockReturnValueOnce({ status: 0, stdout: JSON.stringify([rootRow, ours, foreign]) })
    .mockReturnValue({ status: 0, stdout: JSON.stringify([foreign]) });
  const result = await killProcessGroup(4321, { platform: 'win32', child: live, spawnedAtMs: T, spawnSyncFn, killFn: vi.fn(), sleepFn: async () => {}, isAliveFn: () => false });
  const taskkills = spawnSyncFn.mock.calls.filter(([cmd]) => cmd.endsWith('taskkill.exe')).map(([, args]) => args);
  expect(taskkills).toEqual([['/PID', '4321', '/F'], ['/PID', '5000', '/F']]);
  expect(result).toMatchObject({ ok: true, survivors: [], error: null });
});
