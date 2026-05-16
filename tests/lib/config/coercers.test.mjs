/**
 * coercers.test.mjs — Unit tests for scripts/lib/config/coercers.mjs
 *
 * Covers all exported coercion helpers including happy paths, defaults,
 * and all documented throw paths.
 */

import { describe, it, expect } from 'vitest';
import {
  _getVal,
  _coerceString,
  _coerceInteger,
  _coerceFloat,
  _coerceBoolean,
  _coerceList,
  _coerceEnum,
  _coerceCollisionRisk,
  _coerceObject,
  _coerceBoolObject,
  _coerceMaxTurns,
} from '@lib/config/coercers.mjs';

// ---------------------------------------------------------------------------
// _getVal
// ---------------------------------------------------------------------------

describe('_getVal', () => {
  it('returns value when key exists in map', () => {
    const m = new Map([['foo', 'bar']]);
    expect(_getVal(m, 'foo', 'default')).toBe('bar');
  });

  it('returns default when key is absent', () => {
    const m = new Map();
    expect(_getVal(m, 'foo', 'default')).toBe('default');
  });

  it('returns undefined when key is absent and no default provided', () => {
    const m = new Map();
    expect(_getVal(m, 'foo', undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// _coerceString
// ---------------------------------------------------------------------------

describe('_coerceString', () => {
  it('returns value when key exists', () => {
    const m = new Map([['k', 'hello']]);
    expect(_coerceString(m, 'k', 'default')).toBe('hello');
  });

  it('returns null when value is empty string', () => {
    const m = new Map([['k', '']]);
    expect(_coerceString(m, 'k', 'default')).toBeNull();
  });

  it('returns null when value is "none"', () => {
    const m = new Map([['k', 'none']]);
    expect(_coerceString(m, 'k', 'default')).toBeNull();
  });

  it('returns null when value is "null"', () => {
    const m = new Map([['k', 'null']]);
    expect(_coerceString(m, 'k', 'default')).toBeNull();
  });

  it('returns null when key is absent and no default provided', () => {
    const m = new Map();
    expect(_coerceString(m, 'k', undefined)).toBeNull();
  });

  it('returns default string when key is absent', () => {
    const m = new Map();
    expect(_coerceString(m, 'k', 'fallback')).toBe('fallback');
  });
});

// ---------------------------------------------------------------------------
// _coerceInteger
// ---------------------------------------------------------------------------

describe('_coerceInteger', () => {
  it('parses a valid digit string', () => {
    const m = new Map([['n', '42']]);
    expect(_coerceInteger(m, 'n', 10)).toBe(42);
  });

  it('returns the default when key is absent', () => {
    const m = new Map();
    expect(_coerceInteger(m, 'n', 10)).toBe(10);
  });

  it('parses override syntax with single override', () => {
    const m = new Map([['n', '6 (deep: 18)']]);
    expect(_coerceInteger(m, 'n', 10)).toEqual({ default: 6, deep: 18 });
  });

  it('parses override syntax with multiple overrides', () => {
    const m = new Map([['n', '6 (deep: 18, fast: 4)']]);
    expect(_coerceInteger(m, 'n', 10)).toEqual({ default: 6, deep: 18, fast: 4 });
  });

  it('throws on non-digit raw value (line 76)', () => {
    const m = new Map([['n', 'abc']]);
    expect(() => _coerceInteger(m, 'n', 10)).toThrow(/invalid integer/);
  });

  it('throws on non-digit raw value containing letters after digits (line 76)', () => {
    const m = new Map([['n', '42abc']]);
    expect(() => _coerceInteger(m, 'n', 10)).toThrow(/invalid integer/);
  });

  it('throws on invalid override value that is NaN (line 67-68)', () => {
    const m = new Map([['n', '6 (deep: NaN)']]);
    expect(() => _coerceInteger(m, 'n', 10)).toThrow(/invalid integer override/);
  });

  it('throws on invalid override value that is a float (line 67-68)', () => {
    const m = new Map([['n', '6 (deep: 1.5)']]);
    expect(() => _coerceInteger(m, 'n', 10)).toThrow(/invalid integer override/);
  });

  it('throws on invalid override value that is a word (line 67-68)', () => {
    const m = new Map([['n', '6 (deep: auto)']]);
    expect(() => _coerceInteger(m, 'n', 10)).toThrow(/invalid integer override/);
  });

  it('error message includes key name and bad value', () => {
    const m = new Map([['mykey', 'bad']]);
    expect(() => _coerceInteger(m, 'mykey', 10)).toThrow(/mykey/);
  });

  it('error message for invalid override includes key and override name', () => {
    const m = new Map([['n', '6 (deep: bad)']]);
    expect(() => _coerceInteger(m, 'n', 10)).toThrow(/n\.deep/);
  });
});

// ---------------------------------------------------------------------------
// _coerceFloat
// ---------------------------------------------------------------------------

describe('_coerceFloat', () => {
  it('parses a valid integer string as float', () => {
    const m = new Map([['x', '5']]);
    expect(_coerceFloat(m, 'x', 1.0)).toBe(5);
  });

  it('parses a valid decimal string', () => {
    const m = new Map([['x', '0.75']]);
    expect(_coerceFloat(m, 'x', 0.5)).toBe(0.75);
  });

  it('returns the default when key is absent', () => {
    const m = new Map();
    expect(_coerceFloat(m, 'x', 0.5)).toBe(0.5);
  });

  it('throws on negative value (line 93-94)', () => {
    const m = new Map([['x', '-0.5']]);
    expect(() => _coerceFloat(m, 'x', 0.5)).toThrow(/invalid float/);
  });

  it('throws on non-numeric string (line 93-94)', () => {
    const m = new Map([['x', 'high']]);
    expect(() => _coerceFloat(m, 'x', 0.5)).toThrow(/invalid float/);
  });

  it('throws when value is below min (line 98-99)', () => {
    const m = new Map([['x', '0.1']]);
    expect(() => _coerceFloat(m, 'x', 0.5, 0.5, 1.0)).toThrow(/below minimum/);
  });

  it('throws when value equals max (exclusive upper bound, line 101-102)', () => {
    const m = new Map([['x', '1.0']]);
    expect(() => _coerceFloat(m, 'x', 0.5, 0.0, 1.0)).toThrow(/must be less than/);
  });

  it('accepts value at exactly min', () => {
    const m = new Map([['x', '0.5']]);
    expect(_coerceFloat(m, 'x', 0.0, 0.5, 1.0)).toBe(0.5);
  });

  it('accepts value just below max', () => {
    const m = new Map([['x', '0.99']]);
    expect(_coerceFloat(m, 'x', 0.0, 0.0, 1.0)).toBe(0.99);
  });
});

// ---------------------------------------------------------------------------
// _coerceBoolean
// ---------------------------------------------------------------------------

describe('_coerceBoolean', () => {
  it('returns true for "true"', () => {
    const m = new Map([['flag', 'true']]);
    expect(_coerceBoolean(m, 'flag', false)).toBe(true);
  });

  it('returns false for "false"', () => {
    const m = new Map([['flag', 'false']]);
    expect(_coerceBoolean(m, 'flag', true)).toBe(false);
  });

  it('is case-insensitive for "TRUE"', () => {
    const m = new Map([['flag', 'TRUE']]);
    expect(_coerceBoolean(m, 'flag', false)).toBe(true);
  });

  it('is case-insensitive for "False"', () => {
    const m = new Map([['flag', 'False']]);
    expect(_coerceBoolean(m, 'flag', true)).toBe(false);
  });

  it('returns default when key is absent', () => {
    const m = new Map();
    expect(_coerceBoolean(m, 'flag', true)).toBe(true);
  });

  it('throws on non-boolean string (line 119)', () => {
    const m = new Map([['flag', 'yes']]);
    expect(() => _coerceBoolean(m, 'flag', false)).toThrow(/invalid boolean/);
  });

  it('throws on numeric string (line 119)', () => {
    const m = new Map([['flag', '1']]);
    expect(() => _coerceBoolean(m, 'flag', false)).toThrow(/invalid boolean/);
  });

  it('error message includes key name and bad value', () => {
    const m = new Map([['myflag', 'badval']]);
    expect(() => _coerceBoolean(m, 'myflag', false)).toThrow(/myflag/);
  });
});

// ---------------------------------------------------------------------------
// _coerceList
// ---------------------------------------------------------------------------

describe('_coerceList', () => {
  it('parses bracket-wrapped list', () => {
    const m = new Map([['ls', '[a, b, c]']]);
    expect(_coerceList(m, 'ls', '[]')).toEqual(['a', 'b', 'c']);
  });

  it('parses comma-separated without brackets', () => {
    const m = new Map([['ls', 'a, b, c']]);
    expect(_coerceList(m, 'ls', undefined)).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array for "[]"', () => {
    const m = new Map([['ls', '[]']]);
    expect(_coerceList(m, 'ls', undefined)).toEqual([]);
  });

  it('returns null for "none"', () => {
    const m = new Map([['ls', 'none']]);
    expect(_coerceList(m, 'ls', undefined)).toBeNull();
  });

  it('returns null for "null"', () => {
    const m = new Map([['ls', 'null']]);
    expect(_coerceList(m, 'ls', undefined)).toBeNull();
  });

  it('returns null when key is absent and no default', () => {
    const m = new Map();
    expect(_coerceList(m, 'ls', undefined)).toBeNull();
  });

  it('returns null for complex object-style value (contains "{")', () => {
    const m = new Map([['ls', '[{a: 1}]']]);
    expect(_coerceList(m, 'ls', undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// _coerceEnum
// ---------------------------------------------------------------------------

describe('_coerceEnum', () => {
  it('returns lowercase value when in allowed list', () => {
    const m = new Map([['mode', 'warn']]);
    expect(_coerceEnum(m, 'mode', 'warn', ['warn', 'strict', 'off'])).toBe('warn');
  });

  it('normalises uppercase to lowercase', () => {
    const m = new Map([['mode', 'STRICT']]);
    expect(_coerceEnum(m, 'mode', 'warn', ['warn', 'strict', 'off'])).toBe('strict');
  });

  it('returns default when key is absent', () => {
    const m = new Map();
    expect(_coerceEnum(m, 'mode', 'warn', ['warn', 'strict', 'off'])).toBe('warn');
  });

  it('throws when value is not in allowed list (line 159)', () => {
    const m = new Map([['mode', 'hard']]);
    expect(() => _coerceEnum(m, 'mode', 'warn', ['warn', 'strict', 'off'])).toThrow(/warn\|strict\|off/);
  });

  it('error message includes key name and bad value', () => {
    const m = new Map([['mode', 'invalid']]);
    expect(() => _coerceEnum(m, 'mode', 'warn', ['warn', 'strict', 'off'])).toThrow(/mode/);
    expect(() => _coerceEnum(m, 'mode', 'warn', ['warn', 'strict', 'off'])).toThrow(/invalid/);
  });
});

// ---------------------------------------------------------------------------
// _coerceCollisionRisk
// ---------------------------------------------------------------------------

describe('_coerceCollisionRisk', () => {
  it('returns "low" for null (line 173)', () => {
    expect(_coerceCollisionRisk(null)).toBe('low');
  });

  it('returns "low" for undefined (line 173)', () => {
    expect(_coerceCollisionRisk(undefined)).toBe('low');
  });

  it('returns a custom default for null', () => {
    expect(_coerceCollisionRisk(null, 'medium')).toBe('medium');
  });

  it('returns "low" for value "low"', () => {
    expect(_coerceCollisionRisk('low')).toBe('low');
  });

  it('returns "medium" for value "medium"', () => {
    expect(_coerceCollisionRisk('medium')).toBe('medium');
  });

  it('returns "high" for value "high"', () => {
    expect(_coerceCollisionRisk('high')).toBe('high');
  });

  it('normalises uppercase "HIGH" to "high"', () => {
    expect(_coerceCollisionRisk('HIGH')).toBe('high');
  });

  it('throws TypeError on invalid value (line 175-177)', () => {
    expect(() => _coerceCollisionRisk('critical')).toThrow(TypeError);
  });

  it('error message includes low|medium|high and bad value', () => {
    expect(() => _coerceCollisionRisk('extreme')).toThrow(/low\|medium\|high/);
    expect(() => _coerceCollisionRisk('extreme')).toThrow(/extreme/);
  });
});

// ---------------------------------------------------------------------------
// _coerceObject
// ---------------------------------------------------------------------------

describe('_coerceObject', () => {
  it('parses "{ key1: val1, key2: val2 }"', () => {
    const m = new Map([['obj', '{ key1: val1, key2: val2 }']]);
    expect(_coerceObject(m, 'obj')).toEqual({ key1: 'val1', key2: 'val2' });
  });

  it('returns null when key is absent', () => {
    const m = new Map();
    expect(_coerceObject(m, 'obj')).toBeNull();
  });

  it('returns null when value is "none"', () => {
    const m = new Map([['obj', 'none']]);
    expect(_coerceObject(m, 'obj')).toBeNull();
  });

  it('returns null when value is "null"', () => {
    const m = new Map([['obj', 'null']]);
    expect(_coerceObject(m, 'obj')).toBeNull();
  });

  it('returns null when braces are empty', () => {
    const m = new Map([['obj', '{}']]);
    expect(_coerceObject(m, 'obj')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// _coerceBoolObject
// ---------------------------------------------------------------------------

describe('_coerceBoolObject', () => {
  it('parses "{ gate1: true, gate2: false }"', () => {
    const m = new Map([['gates', '{ gate1: true, gate2: false }']]);
    expect(_coerceBoolObject(m, 'gates')).toEqual({ gate1: true, gate2: false });
  });

  it('returns null when key is absent', () => {
    const m = new Map();
    expect(_coerceBoolObject(m, 'gates')).toBeNull();
  });

  it('returns null when value is "none"', () => {
    const m = new Map([['gates', 'none']]);
    expect(_coerceBoolObject(m, 'gates')).toBeNull();
  });

  it('throws on invalid boolean value for a key (line 228)', () => {
    const m = new Map([['gates', '{ gate1: yes }']]);
    expect(() => _coerceBoolObject(m, 'gates')).toThrow(/invalid enforcement-gates value/);
  });

  it('throws and includes the offending key name in the error', () => {
    const m = new Map([['gates', '{ gate1: 1 }']]);
    expect(() => _coerceBoolObject(m, 'gates')).toThrow(/gate1/);
  });

  it('returns null for empty braces', () => {
    const m = new Map([['gates', '{}']]);
    expect(_coerceBoolObject(m, 'gates')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// _coerceMaxTurns
// ---------------------------------------------------------------------------

describe('_coerceMaxTurns', () => {
  it('returns "auto" when value is "auto"', () => {
    const m = new Map([['max-turns', 'auto']]);
    expect(_coerceMaxTurns(m)).toBe('auto');
  });

  it('returns "auto" when key is absent (default)', () => {
    const m = new Map();
    expect(_coerceMaxTurns(m)).toBe('auto');
  });

  it('is case-insensitive for "AUTO"', () => {
    const m = new Map([['max-turns', 'AUTO']]);
    expect(_coerceMaxTurns(m)).toBe('auto');
  });

  it('parses a positive integer', () => {
    const m = new Map([['max-turns', '50']]);
    expect(_coerceMaxTurns(m)).toBe(50);
  });

  it('throws on zero (line 244)', () => {
    const m = new Map([['max-turns', '0']]);
    expect(() => _coerceMaxTurns(m)).toThrow(/invalid max-turns/);
  });

  it('throws on a float string (line 247)', () => {
    const m = new Map([['max-turns', '3.5']]);
    expect(() => _coerceMaxTurns(m)).toThrow(/invalid max-turns/);
  });

  it('throws on a word string (line 247)', () => {
    const m = new Map([['max-turns', 'many']]);
    expect(() => _coerceMaxTurns(m)).toThrow(/invalid max-turns/);
  });

  it('error message mentions "positive integer or auto"', () => {
    const m = new Map([['max-turns', 'bad']]);
    expect(() => _coerceMaxTurns(m)).toThrow(/positive integer or 'auto'/);
  });
});
