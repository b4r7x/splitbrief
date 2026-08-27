import { afterEach, describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createInitialState } from '../../../core/state/machine.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
} from '#testing/helpers/orchestrator-task-context.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { EvidenceValidationEntry } from '../../../core/schemas/evidence.js';
import type { ValidationResult } from '../validation/result.js';
import { persistTaskEvidence } from './persistence.js';

function passing(stage: EvidenceValidationEntry['stage']): ValidationResult {
  return { stage, passed: true };
}

function failing(stage: EvidenceValidationEntry['stage'], error: string): ValidationResult {
  return { stage, passed: false, error };
}

afterEach(() => {
  cleanupTaskProjects();
});

describe('persistTaskEvidence — retry exempt stages', () => {
  it('leaves the initial blocking failure unexempt when only the retry exempted that stage', () => {
    const task = makeTask({ id: 'T001', file: 'src/task.ts' });
    const state = { ...createInitialState('feat'), tasks: [task] };
    const wctx = makeTaskWorkflowContext();

    persistTaskEvidence({
      wctx,
      state,
      task,
      recordKind: 'retry',
      details: {
        status: 'done',
        method: 'local',
        retries: 1,
        escalated: false,
        initialValidation: [failing('typecheck', 'tsc: src/task.ts(3,1)'), failing('test', 'red')],
        initialChangedFiles: ['src/task.ts'],
        initialExemptStages: [],
        validation: [passing('typecheck'), failing('test', 'legacy suite')],
        changedFiles: ['src/task.ts'],
        exemptStages: ['test'],
      },
    });

    const entry = readEvidenceLedger(wctx)?.tasks[0];
    expect(entry?.validation).toEqual([
      {
        stage: 'typecheck',
        passed: false,
        errorSummary: 'tsc: src/task.ts(3,1)',
        retryState: 'initial-failure',
        changedFiles: ['src/task.ts'],
      },
      {
        stage: 'test',
        passed: false,
        errorSummary: 'red',
        retryState: 'initial-failure',
        changedFiles: ['src/task.ts'],
      },
      { stage: 'typecheck', passed: true, retryState: 'retry', changedFiles: ['src/task.ts'] },
      {
        stage: 'test',
        passed: false,
        errorSummary: 'legacy suite',
        baselineExempt: true,
        retryState: 'retry',
        changedFiles: ['src/task.ts'],
      },
    ]);
    expect(entry?.observedEvidence).toContain('test failed (pre-existing)');
    expect(entry?.observedEvidence).not.toContain('typecheck failed (pre-existing)');
  });

  it('keeps the initial attempt exemption when the retry no longer exempts that stage', () => {
    const task = makeTask({ id: 'T001', file: 'src/task.ts' });
    const state = { ...createInitialState('feat'), tasks: [task] };
    const wctx = makeTaskWorkflowContext();

    persistTaskEvidence({
      wctx,
      state,
      task,
      recordKind: 'retry',
      details: {
        status: 'done',
        method: 'local',
        retries: 1,
        escalated: false,
        initialValidation: [failing('lint', 'legacy lint'), failing('test', 'red')],
        initialChangedFiles: ['src/task.ts'],
        initialExemptStages: ['lint'],
        validation: [passing('lint'), passing('test')],
        changedFiles: ['src/task.ts'],
        exemptStages: [],
      },
    });

    const entry = readEvidenceLedger(wctx)?.tasks[0];
    expect(entry?.validation[0]).toMatchObject({
      stage: 'lint',
      passed: false,
      baselineExempt: true,
      retryState: 'initial-failure',
    });
    expect(entry?.validation[1]?.baselineExempt).toBeUndefined();
    expect(entry?.observedEvidence).toContain('lint failed (pre-existing)');
    expect(entry?.observedEvidence).not.toContain('test failed (pre-existing)');
  });

  it('still records the local acceptance exemption for a task that never retried', () => {
    const task = makeTask({ id: 'T001', file: 'src/task.ts' });
    const state = { ...createInitialState('feat'), tasks: [task] };
    const wctx = makeTaskWorkflowContext();

    persistTaskEvidence({
      wctx,
      state,
      task,
      recordKind: 'local',
      details: {
        status: 'done',
        method: 'local',
        retries: 0,
        validation: [failing('lint', 'legacy lint'), passing('test')],
        changedFiles: ['src/task.ts'],
        exemptStages: ['lint'],
      },
    });

    const entry = readEvidenceLedger(wctx)?.tasks[0];
    expect(entry?.validation).toEqual([
      {
        stage: 'lint',
        passed: false,
        errorSummary: 'legacy lint',
        baselineExempt: true,
        changedFiles: ['src/task.ts'],
      },
      { stage: 'test', passed: true, changedFiles: ['src/task.ts'] },
    ]);
    expect(entry?.observedEvidence).toContain('lint failed (pre-existing)');
    expect(entry?.observedEvidence).toContain('test passed');
  });
});
