/**
 * openNoFollow fallback branch (#1744). Linux/macOS CI never takes the win32
 * path on its own, so these cases force it by passing constants without
 * O_NOFOLLOW: a fallback that reads through a symlink or skips the post-open
 * identity check would otherwise ship unnoticed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openNoFollow } from '../../scripts/lib/no-follow-open.mjs';
import { makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';

const WIN32_CONSTANTS = { O_RDONLY: 0 };

describe('openNoFollow fallback (no O_NOFOLLOW)', () => {
  let dir;
  let target;
  beforeEach(() => {
    dir = makeTmpDir('so-no-follow-open-');
    target = path.join(dir, 'target.json');
    writeFileSync(target, '{"repo":"a"}');
  });
  afterEach(() => removeTree(dir));

  it('opens and reads a regular file', async () => {
    const handle = await openNoFollow(target, { constants: WIN32_CONSTANTS });
    try {
      expect((await handle.readFile()).toString('utf8')).toBe('{"repo":"a"}');
    } finally {
      await handle.close();
    }
  });

  it('refuses a symlink with ELOOP', async () => {
    const link = path.join(dir, 'link.json');
    symlinkSync(target, link);
    await expect(openNoFollow(link, { constants: WIN32_CONSTANTS })).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it('refuses a file swapped between lstat and open with ERR_FILE_CHANGED', async () => {
    const replacement = path.join(dir, 'replacement.json');
    writeFileSync(replacement, '{"repo":"b"}');
    const swappingFs = {
      lstat: fs.lstat,
      open: async (p, flags) => {
        await fs.rename(replacement, p);
        return fs.open(p, flags);
      },
    };
    await expect(openNoFollow(target, { constants: WIN32_CONSTANTS, fsImpl: swappingFs }))
      .rejects.toMatchObject({ code: 'ERR_FILE_CHANGED' });
  });
});
