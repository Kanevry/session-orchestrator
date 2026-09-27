/**
 * tests/lib/sh-quote.test.mjs
 *
 * `shellQuote` (#1438) round-trips through a real POSIX shell: whatever goes in
 * comes back byte-identical, including the characters a shell would otherwise
 * expand, split or terminate on.
 */

import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

import { shellQuote } from '../../scripts/lib/sh-quote.mjs';

describe('shellQuote', () => {
  it.each([
    ['empty', ''],
    ['space', 'a b'],
    ['apostrophe', "it's"],
    ['dollar', '$HOME'],
    ['newline', 'a\nb'],
    ['combined', "it's $HOME\n`id` \"q\" \\ *"],
  ])('%s survives sh -c byte-identical', (_name, input) => {
    const out = execFileSync('sh', ['-c', `printf %s ${shellQuote(input)}`]);
    expect(out.toString('utf8')).toBe(input);
  });
});
