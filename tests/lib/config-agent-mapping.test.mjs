/**
 * config-agent-mapping.test.mjs — channel-prefixed agent-mapping values (#1150).
 *
 * TV-004 note: role-KEY validation (#255) is already covered in
 * tests/unit/config.test.mjs and is NOT duplicated here. This file covers only
 * the value-side channel contract added for foreign-model dispatch, plus the
 * one interaction between the two gates that the new code makes reachable.
 *
 * Contract under test (scripts/lib/config.mjs, agent-mapping validation):
 *   impl: code-implementer      → plain agent name, unchanged
 *   impl: cursor:composer-2.5   → foreign dispatch over the Cursor channel
 *   impl: gpt:foo               → unknown channel, must throw
 */

import { describe, it, expect } from 'vitest';
import { parseSessionConfig } from '@lib/config.mjs';

const CONFIG_HEADER = '## Session Config\n\n';
const cfg = (line) => parseSessionConfig(CONFIG_HEADER + line + '\n');
const mapping = (inner) => cfg(`- **agent-mapping:** { ${inner} }`)['agent-mapping'];

describe('agent-mapping channel values (#1150)', () => {
  // Bug: a tightened value validator rejects `cursor:<model>`, which makes the
  // entire foreign-dispatch channel unconfigurable — the feature ships but
  // cannot be switched on, and the error names the config, not the cause.
  // The colon-free rows are the other direction: a plain value must not be
  // dragged into channel parsing at all.
  it.each([
    {
      why: 'a cursor: channel value keeps its colon',
      inner: 'impl: cursor:composer-2.5',
      expected: { impl: 'cursor:composer-2.5' },
    },
    {
      why: 'a cursor: value sits alongside plain values on other roles',
      inner: 'impl: cursor:composer-2.5, test: test-writer',
      expected: { impl: 'cursor:composer-2.5', test: 'test-writer' },
    },
    {
      why: 'the explicit session-orchestrator channel',
      inner: 'docs: session-orchestrator:docs-writer',
      expected: { docs: 'session-orchestrator:docs-writer' },
    },
    {
      why: 'a colon-free plain agent name is untouched',
      inner: 'impl: code-implementer',
      expected: { impl: 'code-implementer' },
    },
    {
      why: 'a colon-free hyphenated name is untouched',
      inner: 'perf: perf-engineer',
      expected: { perf: 'perf-engineer' },
    },
  ])('accepts $why', ({ inner, expected }) => {
    expect(mapping(inner)).toEqual(expected);
  });

  // Bug (bites against the pre-#1150 validator, which accepted ANY non-empty
  // string): a typo'd or unsupported channel prefix is accepted at parse time,
  // the wave then dispatches to an agent name that does not exist, and the
  // failure surfaces much later as an empty wave with no diff.
  //
  // The four facets below were four separate `it.each` rows re-parsing the
  // SAME `gpt:foo` input; they are one diagnosability contract on one thrown
  // message, so they are asserted together on one throw.
  it('names the channel, the config field, the role and the known channels in one message', () => {
    expect(() => mapping('impl: gpt:foo')).toThrow(/unknown channel 'gpt'/);
    expect(() => mapping('impl: gpt:foo')).toThrow(/agent-mapping/);
    expect(() => mapping('impl: gpt:foo')).toThrow(/'impl'/);
    expect(() => mapping('impl: gpt:foo')).toThrow(/cursor/);
  });

  it.each([
    { why: 'near-miss channel spelling', value: 'cursor-agent:x' },
    { why: 'empty channel prefix', value: ':composer-2.5' },
  ])('throws for $why', ({ value }) => {
    expect(() => mapping(`impl: ${value}`)).toThrow(/unknown channel/);
  });

  // Bug: `cursor:` with nothing after it is a half-written config. Accepting it
  // routes to the Cursor channel with an empty model argument, which fails
  // inside the child process instead of at parse time.
  it('throws for a known channel with no target', () => {
    expect(() => mapping('impl: cursor:')).toThrow(/no target/);
  });

  // Bug: the channel check threw on the FIRST bad value, so a config carrying
  // two bad entries reported only one. The operator fixes it, re-runs, and is
  // told about the next one — one round-trip per defect, with each round-trip
  // hiding the defects behind it. The role-key gate 20 lines above already
  // accumulated (`invalidKeys` batched into one message); the channel check has
  // to join that batch, not bypass it.
  //
  // Bites against the throw-first shape: there the message names `impl`/`gpt`
  // only, so the `test`/`claude` assertions go red.
  it('names BOTH bad channels when two entries are wrong', () => {
    const twoBad = () => mapping('impl: gpt:foo, test: claude:bar');
    expect(twoBad).toThrow(/'impl'/);
    expect(twoBad).toThrow(/unknown channel 'gpt'/);
    expect(twoBad).toThrow(/'test'/);
    expect(twoBad).toThrow(/unknown channel 'claude'/);
  });

  // Same accumulation contract across two DIFFERENT defect classes: an unknown
  // channel on one role and a known channel with no target on another.
  it('names an unknown channel and a missing target from one parse', () => {
    const mixed = () => mapping('impl: gpt:foo, docs: cursor:');
    expect(mixed).toThrow(/unknown channel 'gpt'/);
    expect(mixed).toThrow(/no target/);
  });

  // Bug: the new value check runs inside the same loop as the role-key gate.
  // If it were placed before the `continue`, an invalid role key carrying a
  // channel-shaped value would report the CHANNEL and hide the real defect —
  // the unknown key. The key gate must still win for unknown keys.
  it('still reports an invalid role key when its value names an unknown channel', () => {
    expect(() => mapping('foo: gpt:bar')).toThrow(/invalid role key/);
  });
});

// ---------------------------------------------------------------------------
// ssh channel (#1160)
// ---------------------------------------------------------------------------

const HOSTS_BLOCK = ['remote-hosts:', '  - alias: m5', '    roles-allowed: [test, ui, perf]', ''].join(
  '\n'
);

describe('agent-mapping ssh channel (#1160)', () => {
  // Bug: `ssh` missing from KNOWN_CHANNELS makes the whole offload channel
  // unconfigurable — the value throws "unknown channel 'ssh'" even though the
  // host is declared right above it.
  it('accepts ssh:<alias> when the alias is declared in remote-hosts', () => {
    const parsed = parseSessionConfig(HOSTS_BLOCK + CONFIG_HEADER + '- **agent-mapping:** { test: ssh:m5 }\n');
    expect(parsed['agent-mapping']).toEqual({ test: 'ssh:m5' });
    expect(parsed['remote-hosts'].map((h) => h.alias)).toEqual(['m5']);
  });

  // Bug: an undeclared alias is accepted at parse time and reaches argv as
  // `-H nope`, so the failure lands at ssh-connect time inside a dispatched
  // wave instead of at config-parse time. The message must name the host AND
  // what was declared, or the operator cannot tell a typo from a missing block.
  it('throws naming the undeclared host and the declared aliases', () => {
    const bad = () =>
      parseSessionConfig(HOSTS_BLOCK + CONFIG_HEADER + '- **agent-mapping:** { test: ssh:nope }\n');
    expect(bad).toThrow(/ssh host 'nope'/);
    expect(bad).toThrow(/not declared in remote-hosts/);
    expect(bad).toThrow(/declared: m5/);
  });

  it("reports 'none' when no remote-hosts block exists at all", () => {
    expect(() => mapping('test: ssh:m5')).toThrow(/declared: none/);
  });

  // Bug: the ssh row is added to the branch but not to KNOWN_CHANNELS' error
  // text, so an operator who typo'd the channel is never told ssh is an option.
  it('lists ssh among the known channels in the unknown-channel error', () => {
    expect(() => mapping('impl: sshh:m5')).toThrow(/known channels: [^)]*ssh/);
  });
});
