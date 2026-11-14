import { afterEach, describe, expect, it } from 'vitest';
import { setupProject } from '#testing/helpers/planning-phase.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { readSpecFile, writeSpecFile } from '../sessions/spec-files.js';
import type { WorkflowState } from '../schemas/workflow/state.js';
import type { ReviewRecord } from '../schemas/workflow/review-record.js';
import * as store from './store.js';
import { readReviewRecord } from './store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('readReviewRecord', () => {
  it('returns null only for an absent old-session artifact', () => {
    const ref = setupProject(dirs);
    expect(readReviewRecord(ref)).toBeNull();
  });

  it.each(['', '{', '{}'])('reports a corrupt present typed artifact: %j', (content) => {
    const ref = setupProject(dirs);
    writeSpecFile(ref, 'review.json', content);
    expect(() => readReviewRecord(ref)).toThrow('Invalid typed review');
  });
});

describe('writeAcceptedReview', () => {
  const reviewAt = '2026-11-13T10:00:00.000Z';
  const frontmatter =
    '---\ngenerated_by: splitbrief v0.1.0\nplanner: Claude Code CLI · auto\ncreated_at: 2026-11-13T10:00:01.000Z\n---\n';
  const review: ReviewRecord = {
    cycle: 0,
    at: reviewAt,
    outcome: 'fail',
    verification: [],
    redInputs: [{ id: 'V1.1', text: 'npm test failed: 2 specs failed' }],
    verdict: {
      tasks: [{ id: makeTask().id, plan: 'met', note: '' }],
      criteria: [],
      findings: [
        {
          id: 'F1',
          kind: 'defect',
          severity: 'blocking',
          taskId: null,
          file: null,
          line: null,
          text: 'The greeting drops an empty name',
          acceptance: null,
          checkIds: null,
          criterionId: null,
        },
      ],
    },
  };
  /** A failed review before its accept: one red check blocks, and the reviewer set a second aside. */
  const state: WorkflowState = {
    ...makeImplState([makeTask({ title: 'Add the hello export', status: 'done' })]),
    review,
    pendingTriage: {
      inputs: [
        {
          id: 'V1.1',
          kind: 'defect',
          source: 'check',
          text: 'npm test failed: 2 specs failed',
          file: null,
          checkIds: ['V1'],
          command: 'npm test',
          output: 'RUN v4\nError: 2 specs failed\n',
        },
        {
          id: 'V2.1',
          kind: 'defect',
          source: 'check',
          text: 'npm run lint failed: 1 error',
          file: null,
          checkIds: ['V2'],
          command: 'npm run lint',
        },
      ],
    },
    triage: [
      {
        reviewAt,
        cycle: 1,
        at: reviewAt,
        inputIds: ['F1', 'V1.1', 'V2.1'],
        result: {
          fixTasks: [],
          rejected: [{ findingId: 'V2.1', reason: 'Lint is red at the run base too' }],
          ask: null,
        },
      },
    ],
  };
  const upToTheAccept = [
    '### Verdict',
    '',
    'fail',
    '',
    '### Tasks',
    '',
    '- [met] T001 Add the hello export',
    '',
    '### Criteria Results',
    '',
    'None.',
    '',
    '### Findings',
    '',
    '**Critical**',
    '',
    '- The greeting drops an empty name',
    '- V1.1: npm test failed: 2 specs failed',
    '',
    '**Set aside**',
    '',
    '- Set aside V2.1: Lint is red at the run base too',
    '',
  ];
  const afterTheAccept = ['', '**Note**', '', 'None.', ''];

  it('writes your accept and its red checks under the findings of the review, and keeps the Set aside list and the frontmatter', () => {
    const ref = setupProject(dirs);
    writeSpecFile(ref, 'review.md', `${frontmatter}### Verdict\n\nfail\n`);
    expect(store.writeAcceptedReview).toBeTypeOf('function');
    store.writeAcceptedReview(ref, state, review, {
      redChecks: [{ id: 'V1', command: 'npm test', lastLine: 'Error: 2 specs failed' }],
    });
    expect(readSpecFile(ref, 'review.md')).toBe(
      frontmatter +
        [
          ...upToTheAccept,
          '**Accepted as is by you**',
          '',
          'The planner did not accept this result. You accepted it as is, with 1 red check:',
          '',
          '- V1 failed · npm test · Error: 2 specs failed',
          ...afterTheAccept,
        ].join('\n'),
    );
  });

  it("writes the planner's accept with its note in the same place", () => {
    const ref = setupProject(dirs);
    writeSpecFile(ref, 'review.md', `${frontmatter}### Verdict\n\nfail\n`);
    expect(store.writeAcceptedReview).toBeTypeOf('function');
    store.writeAcceptedReview(ref, state, review, {
      by: 'planner',
      note: 'The old error type is part of the public API.',
    });
    expect(readSpecFile(ref, 'review.md')).toBe(
      frontmatter +
        [
          ...upToTheAccept,
          '**Accepted by the planner**',
          '',
          'The old error type is part of the public API.',
          ...afterTheAccept,
        ].join('\n'),
    );
  });
});
