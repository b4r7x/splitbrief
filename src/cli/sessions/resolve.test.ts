import { describe, expect, it } from 'vitest';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { applyCommand, assertResumableState, readyToApplyMessage } from './resolve.js';

const workspace = {
  kind: 'worktree',
  path: '/nonexistent/splitbrief-ready-workspace',
  base: { snapshotId: 'workspace-base', head: null },
} as const;

const accepted = makeWorkflowState({
  phase: 'complete',
  reviewStatus: 'failed',
  acceptedAsIs: { at: '2026-09-01T00:00:00.000Z', findings: ['F1'] },
  workspace,
});

describe('the Apply command of a run that is ready to apply', () => {
  it('names --action apply-as-is for a run that was accepted as is', () => {
    expect(applyCommand('sess-1', accepted)).toBe(
      'splitbrief continue sess-1 --action apply-as-is',
    );
    expect(readyToApplyMessage('sess-1', accepted)).toBe(
      'Run sess-1 is ready to apply.\nApply with: splitbrief continue sess-1 --action apply-as-is\nDiscard with: splitbrief continue sess-1 --action discard',
    );
  });

  it.each(['passed', 'none'] as const)(
    'names --action apply for a run whose review status is %s',
    (reviewStatus) => {
      const ready = makeWorkflowState({ phase: 'complete', reviewStatus, workspace });

      expect(applyCommand('sess-1', ready)).toBe('splitbrief continue sess-1 --action apply');
      expect(readyToApplyMessage('sess-1', ready)).toBe(
        'Run sess-1 is ready to apply.\nApply with: splitbrief continue sess-1 --action apply\nDiscard with: splitbrief continue sess-1 --action discard',
      );
    },
  );

  it('refuses to resume a run that was accepted as is and names the command that applies it', () => {
    expect(() => assertResumableState(accepted, 'sess-1')).toThrow(
      'Run sess-1 is ready to apply.\nApply with: splitbrief continue sess-1 --action apply-as-is\nDiscard with: splitbrief continue sess-1 --action discard',
    );
  });
});
