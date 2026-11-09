import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../core/state/machine.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import type { RecoveryIssue } from '../core/schemas/recovery/schemas.js';
import { buildReviewFailedRecoveryIssue } from '../engine/orchestrator/recovery/builders/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  configDeclaresFallback,
  emitRecoveryAndFailIfPending,
  failIfSessionFailed,
} from './headless.js';

const POINTER = 'Workflow failed — see the error output above.';
const CAUSE = 'The run baseline snapshot could not be initialized; workspace acquisition stopped.';

const failedState: WorkflowState = {
  ...createInitialState('Add a probe'),
  phase: 'implementing',
  lastFailure: {
    step: { kind: 'planner', call: 'plan' },
    message: CAUSE,
    at: '2026-10-19T00:00:00.000Z',
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('configDeclaresFallback', () => {
  it('a None config counts no review fallback', () => {
    expect(configDeclaresFallback(makeConfig({ reviewer: 'none' }))).toBe(false);
  });
});

describe('failIfSessionFailed', () => {
  it('prints the cause on stderr once, before the pointer to it', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => failIfSessionFailed(failedState, 's-1', vi.fn(), CAUSE)).toThrow(POINTER);
    expect(stderr.mock.calls.map(([chunk]) => chunk)).toEqual([`${CAUSE}\n`]);
  });

  it('prints nothing more when no cause was collected', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const writeRecord = vi.fn();

    expect(() => failIfSessionFailed(failedState, 's-1', writeRecord, undefined)).toThrow(POINTER);
    expect(stderr.mock.calls).toEqual([]);
    expect(writeRecord).toHaveBeenCalledWith({
      type: 'error',
      message: 'Session s-1 failed.',
    });
  });

  it('prints no cause for a run that did not fail', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { lastFailure: _, ...stopped } = failedState;

    expect(() => failIfSessionFailed(stopped, 's-1', vi.fn(), CAUSE)).not.toThrow();
    expect(stderr.mock.calls).toEqual([]);
  });
});

describe('emitRecoveryAndFailIfPending — a review halt that needs another review seat', () => {
  const createdAt = '2026-11-04T12:00:00.000Z';

  function haltOn(issue: RecoveryIssue) {
    const state: WorkflowState = {
      ...createInitialState('Add a probe'),
      phase: 'final-review',
      pendingRecovery: issue,
    };
    const writeRecord = vi.fn();
    let thrown: unknown;
    try {
      emitRecoveryAndFailIfPending({ state, sessionId: 's-1', writeRecord });
    } catch (err) {
      thrown = err;
    }
    return {
      message: thrown instanceof Error ? thrown.message : '',
      resumeCommand: writeRecord.mock.calls[0]?.[0]?.resumeCommand,
    };
  }

  it.each([
    [
      'the review seat could not see the renders',
      buildReviewFailedRecoveryIssue({
        createdAt,
        blocking: 0,
        unverified: 1,
        reviewSeatNoImages: true,
        cannot: 'No fix brief can make a seat that cannot see images judge the renders.',
      }),
    ],
    [
      'the review seat had too small a context',
      buildReviewFailedRecoveryIssue({
        createdAt,
        failure: {
          kind: 'insufficient-context',
          diagnostic: {
            code: 'insufficient-context',
            seat: 'review',
            cause: 'input-budget',
            missingSections: [],
          },
        },
      }),
    ],
  ])('names the review seat change in the line to paste when %s', (_name, issue) => {
    const line = 'splitbrief continue s-1 --reviewer <tool> --action retry';

    const halt = haltOn(issue);

    expect(halt.message).toContain(`\nContinue with: ${line} [--plain|--json]`);
    expect(halt.resumeCommand).toBe(line);
  });

  it('keeps a bare retry when the review call failed on a seat that can review', () => {
    const halt = haltOn(
      buildReviewFailedRecoveryIssue({
        createdAt,
        failure: { kind: 'call-failed', code: 'ETIMEDOUT', message: 'Review call failed.' },
      }),
    );

    expect(halt.message).toContain(
      '\nContinue with: splitbrief continue s-1 --action retry [--plain|--json]',
    );
    expect(halt.resumeCommand).toBe('splitbrief continue s-1 --action retry');
  });
});
