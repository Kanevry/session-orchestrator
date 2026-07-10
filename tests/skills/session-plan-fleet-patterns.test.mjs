/**
 * tests/skills/session-plan-fleet-patterns.test.mjs
 *
 * Regression guard for the #730 fleet-mining orchestration patterns wired
 * into skills/session-plan/SKILL.md this session:
 *   - Step 3.5 Schritt 6 Contract-Lock detection (#730/H1)
 *   - Step 0.5 / Step 3 over-delivery sizing (#730/H4)
 *   - Step 1 Premise-Verdict consumption (#730/H3)
 *   - agents/code-implementer.md grep-before-create cousin-file guard (#730.3)
 *
 * Style mirrors tests/skills/session-start/what-not-to-retry-surface.test.mjs
 * and tests/skills/wave-executor-dispatch-batch.test.mjs (indexOf-bounded
 * region extraction, content-presence assertions against the live files).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SESSION_PLAN_MD = join(REPO_ROOT, 'skills/session-plan/SKILL.md');
const CODE_IMPLEMENTER_MD = join(REPO_ROOT, 'agents/code-implementer.md');

const sessionPlan = readFileSync(SESSION_PLAN_MD, 'utf8');

describe('#730/H1 Step 3.5 Schritt 6 Contract-Lock detection (session-plan SKILL.md)', () => {
  it('the Contract-Lock detection step (6) follows the File-scope deconfliction step (5)', () => {
    const idx35 = sessionPlan.indexOf('## Step 3.5: Task-to-Agent Distribution');
    const idxStep4 = sessionPlan.indexOf('## Step 4: Agent Specification');
    const idxDeconflict = sessionPlan.indexOf('5. **File-scope deconfliction**', idx35);
    const idxContractLock = sessionPlan.indexOf('6. **Contract-Lock detection (#730/H1)**', idx35);
    expect(idx35).toBeGreaterThan(-1);
    expect(idxStep4).toBeGreaterThan(idx35);
    expect(idxDeconflict).toBeGreaterThan(-1);
    expect(idxContractLock).toBeGreaterThan(-1);
    expect(idxDeconflict).toBeLessThan(idxContractLock);
    expect(idxContractLock).toBeLessThan(idxStep4);
  });

  it('the Contract-Lock step annotates the wave-plan item contract-lock: true', () => {
    const idxContractLock = sessionPlan.indexOf('6. **Contract-Lock detection (#730/H1)**');
    const idxConstraint = sessionPlan.indexOf('**Constraint check:**', idxContractLock);
    const region = sessionPlan.slice(idxContractLock, idxConstraint);
    expect(region).toContain('contract-lock: true');
  });

  it('the Contract-Lock step cross-references wave-loop.md § Contract-Lock Serialization', () => {
    const idxContractLock = sessionPlan.indexOf('6. **Contract-Lock detection (#730/H1)**');
    const idxConstraint = sessionPlan.indexOf('**Constraint check:**', idxContractLock);
    const region = sessionPlan.slice(idxContractLock, idxConstraint);
    expect(region).toContain('skills/wave-executor/wave-loop.md');
    expect(region).toContain('Contract-Lock Serialization');
  });
});

describe('#730/H4 over-delivery sizing (session-plan SKILL.md Step 0.5 + Step 3)', () => {
  it('Step 1 sub-step 0.5 (Read project intelligence) surfaces over_delivery_ratio', () => {
    const idxIntel = sessionPlan.indexOf('0.5. **Read project intelligence**');
    const idxTask1 = sessionPlan.indexOf('For each agreed task/issue:', idxIntel);
    const region = sessionPlan.slice(idxIntel, idxTask1);
    expect(idxIntel).toBeGreaterThan(-1);
    expect(region).toContain('over_delivery_ratio');
  });

  it('Step 3 documents the Over-delivery adjustment blockquote', () => {
    const idx3 = sessionPlan.indexOf('## Step 3: Complexity Assessment');
    const idx35 = sessionPlan.indexOf('## Step 3.5: Task-to-Agent Distribution');
    const region = sessionPlan.slice(idx3, idx35);
    expect(idx3).toBeGreaterThan(-1);
    expect(region).toContain('Over-delivery adjustment (#730/H4)');
  });
});

describe('#730/H3 Step 1 premise-verdict consumption (session-plan SKILL.md)', () => {
  it('Step 1 treats FALSCH-PRÄMISSE/SHIPPED verdicts as binding before decomposing', () => {
    const idx1 = sessionPlan.indexOf('## Step 1: Task Decomposition');
    const idx15 = sessionPlan.indexOf('## Step 1.5: Agent Discovery');
    const region = sessionPlan.slice(idx1, idx15);
    expect(idx1).toBeGreaterThan(-1);
    expect(region).toContain('Premise Verification Result');
    expect(region).toContain('FALSCH-PRÄMISSE/SHIPPED');
  });
});

describe('#730.3 code-implementer grep-before-create cousin-file guard', () => {
  it('agents/code-implementer.md documents the grep-before-create rule', () => {
    const body = readFileSync(CODE_IMPLEMENTER_MD, 'utf8');
    expect(body).toMatch(/grep for existing files with a similar basename/);
    expect(body).toContain('cousin');
    expect(body).toContain('#730.3');
  });
});
