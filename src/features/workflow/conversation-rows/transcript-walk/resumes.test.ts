import { describe, expect, it } from 'vitest';
import { groupEventsIntoSections } from '../../../../core/sections/group.js';
import { taskId } from '../../../../core/schemas/task.js';
import {
  WORKSPACE_KEPT_CODE,
  WORKSPACE_NOTICE_CATEGORY,
} from '../../../../core/sessions/workspace-notice.js';
import type { EngineEvent, EngineEventOf } from '../../../../engine/events/types.js';
import { answeredResumes, carriedOnSeatChanges, keptWorkspaceNotice } from './resumes.js';

const kept = (ts: number): EngineEventOf<'warning'> => ({
  type: 'warning',
  ts,
  phase: 'implementing',
  message: 'Your work is kept for Continue.',
  category: WORKSPACE_NOTICE_CATEGORY,
  code: WORKSPACE_KEPT_CODE,
});
const resumed = (ts: number, cause?: 'seat-change'): EngineEventOf<'workflow_resumed'> => ({
  type: 'workflow_resumed',
  ts,
  phase: 'implementing',
  ...(cause !== undefined && { cause }),
});
const parked = (ts: number, cause?: 'seat-change'): EngineEventOf<'turn_interrupted'> => ({
  type: 'turn_interrupted',
  ts,
  phase: 'implementing',
  source: 'user',
  at: 'boundary',
  step: { kind: 'brief', taskId: taskId('T002'), attempt: 0 },
  ...(cause !== undefined && { cause }),
});
const cancelled: EngineEvent = {
  type: 'workflow_cancelled',
  ts: 1_500,
  phase: 'implementing',
  reason: 'user_cancelled',
};
const answer: EngineEvent = {
  type: 'recovery_action_selected',
  ts: 1_000,
  phase: 'implementing',
  issueId: 'i-1',
  reason: 'validation-failed',
  action: 'retry-same-worker',
};
const refused: EngineEvent = {
  type: 'recovery_action_failed',
  ts: 1_500,
  phase: 'implementing',
  issueId: 'i-1',
  reason: 'validation-failed',
  action: 'retry-same-worker',
  message: 'retry could not start',
};
const sectionsOf = (events: EngineEvent[]) => groupEventsIntoSections(events);

describe('keptWorkspaceNotice', () => {
  it('is the last notice while the run stays stopped', () => {
    const later = kept(1_200);
    expect(keptWorkspaceNotice(sectionsOf([kept(1_000), later]))).toBe(later);
  });

  it('is gone once the run continues', () => {
    expect(keptWorkspaceNotice(sectionsOf([kept(1_000), resumed(1_100)]))).toBeUndefined();
  });

  it('is gone once a close lets the workspace go', () => {
    const closed: EngineEvent = { type: 'workspace_closed', ts: 1_100, phase: 'implementing' };
    expect(keptWorkspaceNotice(sectionsOf([kept(1_000), closed]))).toBeUndefined();
  });

  it('is the notice of a stop after the continue', () => {
    const again = kept(1_200);
    expect(keptWorkspaceNotice(sectionsOf([kept(1_000), resumed(1_100), again]))).toBe(again);
  });
});

describe('answeredResumes', () => {
  it('holds the one resume that a recovery answer started', () => {
    const first = resumed(2_000);
    expect(answeredResumes(sectionsOf([answer, first, resumed(3_000)]))).toEqual(new Set([first]));
  });

  it.each([
    ['a cancel', cancelled],
    ['a stop', parked(1_500)],
    ['a refused answer', refused],
  ])('holds no resume after %s between the answer and the resume', (_, between) => {
    expect(answeredResumes(sectionsOf([answer, between, resumed(2_000)]))).toEqual(new Set());
  });
});

describe('carriedOnSeatChanges', () => {
  it('holds the park and the resume of a crew change that carried the run on', () => {
    const park = parked(1_000, 'seat-change');
    const resume = resumed(1_100, 'seat-change');
    expect(carriedOnSeatChanges(sectionsOf([park, resume]))).toEqual(new Set([park, resume]));
  });

  it('holds only the resume when the park before it was not a crew change', () => {
    const resume = resumed(1_100, 'seat-change');
    expect(carriedOnSeatChanges(sectionsOf([parked(1_000), resume]))).toEqual(new Set([resume]));
  });

  it.each([
    ['a cancel', cancelled],
    ['a plain continue', resumed(1_200)],
  ])('holds only the resume when %s came after the park', (_, between) => {
    const resume = resumed(2_000, 'seat-change');
    expect(
      carriedOnSeatChanges(sectionsOf([parked(1_000, 'seat-change'), between, resume])),
    ).toEqual(new Set([resume]));
  });

  it('holds nothing for a park that no crew change resumed', () => {
    expect(
      carriedOnSeatChanges(sectionsOf([parked(1_000, 'seat-change'), resumed(1_100)])),
    ).toEqual(new Set());
  });
});
