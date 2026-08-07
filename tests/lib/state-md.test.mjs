import { describe, it, expect } from 'vitest';
import * as stateMdBarrel from '@lib/state-md.mjs';
import * as bodySections from '@lib/state-md/body-sections.mjs';
import {
  parseStateMd,
  serializeStateMd,
  parseRecommendations,
  updateFrontmatterFields,
} from '@lib/state-md.mjs';

describe('barrel re-exports', () => {
  it('re-exports body-section helpers as the leaf bindings', () => {
    expect({
      readCurrentTask: stateMdBarrel.readCurrentTask,
      appendDeviation: stateMdBarrel.appendDeviation,
      markExpressPathComplete: stateMdBarrel.markExpressPathComplete,
      appendWhatNotToRetry: stateMdBarrel.appendWhatNotToRetry,
      readWhatNotToRetry: stateMdBarrel.readWhatNotToRetry,
      appendWhatNotToRetryOnDisk: stateMdBarrel.appendWhatNotToRetryOnDisk,
      readOpenQuestions: stateMdBarrel.readOpenQuestions,
      appendOpenQuestion: stateMdBarrel.appendOpenQuestion,
      markOpenQuestionAnswered: stateMdBarrel.markOpenQuestionAnswered,
      appendOpenQuestionOnDisk: stateMdBarrel.appendOpenQuestionOnDisk,
      markOpenQuestionAnsweredOnDisk: stateMdBarrel.markOpenQuestionAnsweredOnDisk,
      MAX_OPEN_QUESTIONS_STORED: stateMdBarrel.MAX_OPEN_QUESTIONS_STORED,
    }).toEqual({
      readCurrentTask: bodySections.readCurrentTask,
      appendDeviation: bodySections.appendDeviation,
      markExpressPathComplete: bodySections.markExpressPathComplete,
      appendWhatNotToRetry: bodySections.appendWhatNotToRetry,
      readWhatNotToRetry: bodySections.readWhatNotToRetry,
      appendWhatNotToRetryOnDisk: bodySections.appendWhatNotToRetryOnDisk,
      readOpenQuestions: bodySections.readOpenQuestions,
      appendOpenQuestion: bodySections.appendOpenQuestion,
      markOpenQuestionAnswered: bodySections.markOpenQuestionAnswered,
      appendOpenQuestionOnDisk: bodySections.appendOpenQuestionOnDisk,
      markOpenQuestionAnsweredOnDisk: bodySections.markOpenQuestionAnsweredOnDisk,
      MAX_OPEN_QUESTIONS_STORED: bodySections.MAX_OPEN_QUESTIONS_STORED,
    });
  });
});


describe('recommendations v1.1', () => {
  const FULL = `---
schema-version: 1
session-type: deep
status: completed
recommended-mode: deep
top-priorities: [272, 273, 274]
carryover-ratio: 0.33
completion-rate: 0.85
rationale: "v0: carryover ≥30% → deep"
---

body
`;

  it('parses all 5 recommendation fields', () => {
    const parsed = parseStateMd(FULL);
    const rec = parseRecommendations(parsed.frontmatter);
    expect(rec).not.toBeNull();
    expect(rec.mode).toBe('deep');
    expect(rec.priorities).toEqual([272, 273, 274]);
    expect(rec.carryoverRatio).toBe(0.33);
    expect(rec.completionRate).toBe(0.85);
    expect(rec.rationale).toBe('v0: carryover ≥30% → deep');
  });

  it('returns null on pre-v1.1 STATE.md (no fields present)', () => {
    const parsed = parseStateMd(`---
schema-version: 1
status: completed
---

body
`);
    expect(parseRecommendations(parsed.frontmatter)).toBeNull();
  });

  it('accepts partial field set — missing fields become null', () => {
    const parsed = parseStateMd(`---
status: completed
recommended-mode: feature
completion-rate: 0.95
---

body
`);
    const rec = parseRecommendations(parsed.frontmatter);
    expect(rec).not.toBeNull();
    expect(rec.mode).toBe('feature');
    expect(rec.completionRate).toBe(0.95);
    expect(rec.priorities).toBeNull();
    expect(rec.carryoverRatio).toBeNull();
    expect(rec.rationale).toBeNull();
  });

  it('coerces type-mismatched fields to null (defensive)', () => {
    const rec = parseRecommendations({
      'recommended-mode': 42,
      'top-priorities': 'not-an-array',
      'carryover-ratio': 'zero',
      'completion-rate': true,
      rationale: null,
    });
    expect(rec).not.toBeNull();
    expect(rec.mode).toBeNull();
    expect(rec.priorities).toBeNull();
    expect(rec.carryoverRatio).toBeNull();
    expect(rec.completionRate).toBeNull();
    expect(rec.rationale).toBeNull();
  });

  it('updateFrontmatterFields is additive — preserves unknown extension keys', () => {
    const input = `---
schema-version: 1
session-type: deep
custom-extension: "keep-me"
status: active
---

body
`;
    const out = updateFrontmatterFields(input, {
      'recommended-mode': 'feature',
      'completion-rate': 0.9,
    });
    const parsed = parseStateMd(out);
    expect(parsed.frontmatter['custom-extension']).toBe('keep-me');
    expect(parsed.frontmatter['schema-version']).toBe(1);
    expect(parsed.frontmatter['session-type']).toBe('deep');
    expect(parsed.frontmatter.status).toBe('active');
    expect(parsed.frontmatter['recommended-mode']).toBe('feature');
    expect(parsed.frontmatter['completion-rate']).toBe(0.9);
  });

  it('roundtrip parseStateMd → serializeStateMd → parseStateMd is idempotent with recommendation fields', () => {
    const parsed = parseStateMd(FULL);
    const serialized = serializeStateMd(parsed);
    const reparsed = parseStateMd(serialized);
    expect(reparsed.frontmatter).toEqual(parsed.frontmatter);
    expect(parseRecommendations(reparsed.frontmatter)).toEqual(
      parseRecommendations(parsed.frontmatter),
    );
  });

  it('updateFrontmatterFields removes a key when value is null', () => {
    const input = `---
status: completed
recommended-mode: deep
completion-rate: 0.85
---

body
`;
    const out = updateFrontmatterFields(input, { 'recommended-mode': null });
    const parsed = parseStateMd(out);
    expect(parsed.frontmatter['recommended-mode']).toBeUndefined();
    expect(parsed.frontmatter['completion-rate']).toBe(0.85);
    expect(parsed.frontmatter.status).toBe('completed');
  });
});
