/**
 * tests/lib/session-schema/constants.test.mjs
 *
 * Vitest suite for scripts/lib/session-schema/constants.mjs.
 * Covers: version number, SESSION_KEY_ALIASES frozen-ness + entries,
 * VALID_SESSION_TYPES, REQUIRED_FIELDS completeness, AGENT_SUMMARY_FIELDS.
 */

import { describe, it, expect } from 'vitest';
import {
  CURRENT_SESSION_SCHEMA_VERSION,
  SESSION_KEY_ALIASES,
  VALID_SESSION_TYPES,
  REQUIRED_FIELDS,
  AGENT_SUMMARY_FIELDS,
} from '../../../scripts/lib/session-schema/constants.mjs';

describe('CURRENT_SESSION_SCHEMA_VERSION', () => {
  it('is the number 1', () => {
    expect(CURRENT_SESSION_SCHEMA_VERSION).toBe(1);
  });
});

describe('SESSION_KEY_ALIASES', () => {
  it('is a frozen object (cannot be mutated)', () => {
    expect(Object.isFrozen(SESSION_KEY_ALIASES)).toBe(true);
  });

  it('maps type → session_type', () => {
    expect(SESSION_KEY_ALIASES.type).toBe('session_type');
  });

  it('maps closed_issues → issues_closed', () => {
    expect(SESSION_KEY_ALIASES.closed_issues).toBe('issues_closed');
  });

  it('maps waves_completed → total_waves (legacy scalar alias)', () => {
    expect(SESSION_KEY_ALIASES.waves_completed).toBe('total_waves');
  });

  it('maps head_ref → branch', () => {
    expect(SESSION_KEY_ALIASES.head_ref).toBe('branch');
  });

  it('maps files_changed → total_files_changed', () => {
    expect(SESSION_KEY_ALIASES.files_changed).toBe('total_files_changed');
  });

  it('has at least 10 declared entries (completeness floor)', () => {
    expect(Object.keys(SESSION_KEY_ALIASES).length).toBeGreaterThanOrEqual(10);
  });

  it('all values are non-empty strings', () => {
    for (const val of Object.values(SESSION_KEY_ALIASES)) {
      expect(typeof val).toBe('string');
      expect(val.length).toBeGreaterThan(0);
    }
  });
});

describe('VALID_SESSION_TYPES', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(VALID_SESSION_TYPES)).toBe(true);
  });

  it('includes feature, deep, housekeeping', () => {
    expect(VALID_SESSION_TYPES).toContain('feature');
    expect(VALID_SESSION_TYPES).toContain('deep');
    expect(VALID_SESSION_TYPES).toContain('housekeeping');
  });

  it('has exactly 3 types (closed enum)', () => {
    expect(VALID_SESSION_TYPES).toHaveLength(3);
  });
});

describe('REQUIRED_FIELDS', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(REQUIRED_FIELDS)).toBe(true);
  });

  it('includes the 9 canonical required fields', () => {
    const expected = [
      'session_id',
      'session_type',
      'started_at',
      'completed_at',
      'total_waves',
      'waves',
      'agent_summary',
      'total_agents',
      'total_files_changed',
    ];
    for (const field of expected) {
      expect(REQUIRED_FIELDS).toContain(field);
    }
  });

  it('has exactly 9 required fields', () => {
    expect(REQUIRED_FIELDS).toHaveLength(9);
  });
});

describe('AGENT_SUMMARY_FIELDS', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(AGENT_SUMMARY_FIELDS)).toBe(true);
  });

  it('includes complete, partial, failed, spiral', () => {
    expect(AGENT_SUMMARY_FIELDS).toContain('complete');
    expect(AGENT_SUMMARY_FIELDS).toContain('partial');
    expect(AGENT_SUMMARY_FIELDS).toContain('failed');
    expect(AGENT_SUMMARY_FIELDS).toContain('spiral');
  });

  it('has exactly 4 fields', () => {
    expect(AGENT_SUMMARY_FIELDS).toHaveLength(4);
  });
});
