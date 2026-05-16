import { describe, it, expect } from 'vitest';
import { load as parseYaml } from 'js-yaml';

import { yamlQuoteIfNeeded } from '@lib/vault-mirror/utils.mjs';

describe('yamlQuoteIfNeeded', () => {
  it('returns value unquoted when no special chars are present', () => {
    expect(yamlQuoteIfNeeded('plain title')).toBe('plain title');
  });

  it('wraps in double quotes when value contains a colon', () => {
    expect(yamlQuoteIfNeeded('foo: bar')).toBe('"foo: bar"');
  });

  it('quotes when value starts with a dash', () => {
    expect(yamlQuoteIfNeeded('-leading-dash')).toBe('"-leading-dash"');
  });

  it('escapes embedded double quotes', () => {
    expect(yamlQuoteIfNeeded('she said "hi": done')).toBe('"she said \\"hi\\": done"');
  });

  it('escapes backslashes when quoting (regression: \\y in PostgreSQL POSIX regex titles)', () => {
    // Real-world failing input: learning title containing literal `\y` and `\b`.
    // Pre-fix this produced `"... \y ..."` which YAML rejects as invalid escape sequence.
    const input = String.raw`PostgreSQL POSIX regex (~,~*) uses \y for word boundary, not \b`;
    const quoted = yamlQuoteIfNeeded(input);

    // Backslashes must be doubled for double-quoted YAML
    expect(quoted).toBe(
      '"PostgreSQL POSIX regex (~,~*) uses \\\\y for word boundary, not \\\\b"',
    );

    // Round-trip via real YAML parser to prove the output is valid YAML and
    // that the parsed string equals the original input byte-for-byte.
    const doc = parseYaml(`title: ${quoted}\n`);
    expect(doc.title).toBe(input);
  });

  it('round-trips a value containing both backslashes and double quotes', () => {
    const input = String.raw`mixed: \n and "quoted"`;
    const quoted = yamlQuoteIfNeeded(input);
    const doc = parseYaml(`title: ${quoted}\n`);
    expect(doc.title).toBe(input);
  });

  it('triggers quoting on bare backslash even without other special chars', () => {
    // A lone backslash would parse as part of the value if left bare; ensure we quote it.
    const input = String.raw`a\b`;
    const quoted = yamlQuoteIfNeeded(input);
    expect(quoted.startsWith('"')).toBe(true);
    const doc = parseYaml(`title: ${quoted}\n`);
    expect(doc.title).toBe(input);
  });
});
