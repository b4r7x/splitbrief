import { describe, expect, it } from 'vitest';
import { makeRunRecord } from '#testing/helpers/factories/run-record.js';
import { taskId } from '../../../../core/schemas/task.js';
import type { ClarificationQuestion } from '../../../../core/schemas/question.js';
import type { RunStatus } from '../../../../core/sessions/run/status.js';
import { rowText } from '../row-format/rows.js';
import { transcriptTail } from './tail.js';

const question: ClarificationQuestion = {
  id: 'api',
  type: 'confirm',
  text: 'Keep the public API?',
};

const live = {
  closedBlock: null,
  closedRun: false,
  plannerAsking: false,
  atRestRecord: undefined,
  viewQuestions: null,
  draftRefusal: null,
  width: 80,
  viewportRows: 20,
};

function openAt(on: { kind: 'question' } | { kind: 'gate'; gate: 'spec' }): RunStatus {
  return {
    kind: 'open',
    stop: { kind: 'waiting-for-you', on },
    resumeAt: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
  };
}

function keys(input: Parameters<typeof transcriptTail>[0]): string[] {
  return transcriptTail(input).map((block) => block.key);
}

describe('transcriptTail', () => {
  it('adds nothing to a live run with no open round and no refused draft', () => {
    expect(transcriptTail(live)).toEqual([]);
  });

  it('puts the closed run, the open round and the refused draft in that order, each after a blank row', () => {
    const closedBlock = { key: 'closed-block:s1', view: null, crewNamed: false, expanded: false };
    expect(
      keys({ ...live, closedBlock, closedRun: true, draftRefusal: 'draft.md: disk full' }),
    ).toEqual([
      'spacer-closed-block:s1',
      'closed-block:s1',
      'spacer-draft-not-saved',
      'draft-not-saved',
    ]);
    expect(
      keys({ ...live, viewQuestions: [question], draftRefusal: 'draft.md: disk full' }),
    ).toEqual(['spacer-open-round', 'open-round', 'spacer-draft-not-saved', 'draft-not-saved']);
  });

  it('names the refused draft as a warning with its cause', () => {
    const [, draft] = transcriptTail({ ...live, draftRefusal: 'draft.md: disk full' });
    const text = draft?.createRows(0, draft.rowCount).map(rowText).join('\n') ?? '';
    expect(text).toContain('Warning');
    expect(text).toContain('draft.md: disk full');
  });

  it('does not repeat the round on a closed run or while the planner asks it in the panel', () => {
    expect(keys({ ...live, viewQuestions: [question], closedRun: true })).toEqual([]);
    expect(keys({ ...live, viewQuestions: [question], plannerAsking: true })).toEqual([]);
  });

  it('shows the round an open run at rest waits at, and no round while it waits at something else', () => {
    const waitsAtQuestion = makeRunRecord({ status: openAt({ kind: 'question' }) });
    const waitsAtGate = makeRunRecord({ status: openAt({ kind: 'gate', gate: 'spec' }) });
    expect(keys({ ...live, atRestRecord: waitsAtQuestion, viewQuestions: [question] })).toEqual([
      'spacer-open-round',
      'open-round',
    ]);
    expect(keys({ ...live, atRestRecord: waitsAtGate, viewQuestions: [question] })).toEqual([]);
  });
});
