import { describe, expect, it } from 'vitest';
import { PHASES } from '../../../core/schemas/enums.js';
import { taskId } from '../../../core/schemas/task.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { operationsStore } from '../../../stores/workflow/operations/state.js';
import { makeRunnerCallStarted } from '#testing/helpers/events/runner-call.js';
import {
  activeVerb,
  suiteStatusParts,
  suiteStageParts,
  reviewActivityParts,
  reviewActivitySpans,
} from './phase-verb.js';

function suiteStageText(suite: Parameters<typeof suiteStageParts>[0]): string {
  return suiteStageParts(suite, 'live')
    .map((part) => part.text)
    .join('');
}

it.each(['live', 'transcript'] as const)(
  'returns %s check seat words and concept separators without a stage prefix',
  (context) => {
    expect(
      suiteStageParts({ id: 'V1', moment: 'pre-review', command: 'npm test' }, context),
    ).toEqual([
      { text: 'Reviewer', tone: 'reviewer' },
      { text: ' check V1', tone: 'textDim' },
      { text: ' · ', tone: 'textDim' },
      { text: 'npm test', tone: 'textDim' },
    ]);
    expect(reviewActivityParts(null, null, false)).toEqual({
      prefix: [
        { text: 'Review', tone: 'reviewer' },
        { text: ' · ', tone: 'textDim' },
      ],
      identity: null,
      suffix: [{ text: 'reviewing changes', tone: 'textDim' }],
    });
  },
);

it.each([['verdict', 'reviewing changes']] as const)(
  'keeps the review identity separate from the %s suffix',
  (step, words) => {
    resetWorkflow();
    addEvent({
      type: 'review_started',
      ts: 1_000,
      phase: 'final-review',
      scope: 'final',
      tool: 'codex',
    });
    addEvent({ type: 'review_step', ts: 1_000, phase: 'final-review', step });
    const operation = operationsStore.get().active;
    expect(reviewActivityParts(operation, 'codex · gpt-5', false)).toEqual({
      prefix: [
        { text: 'Review', tone: 'reviewer' },
        { text: ' · ', tone: 'textDim' },
      ],
      identity: { text: 'codex · gpt-5', tone: 'reviewer' },
      suffix: [
        { text: ' · ', tone: 'textDim' },
        { text: words, tone: 'textDim' },
      ],
    });
    resetWorkflow();
  },
);

it('says the reviewer answers again on the call after a refused answer', () => {
  resetWorkflow();
  addEvent({ type: 'review_step', ts: 1_000, phase: 'final-review', step: 'verdict' });
  addEvent({
    type: 'seat_answer_refused',
    ts: 2_000,
    phase: 'final-review',
    seat: 'reviewer',
    reasons: ['Task T001 is missing from the verdict.'],
  });
  addEvent(makeRunnerCallStarted({ ts: 2_100, phase: 'final-review', role: 'review' }));
  const text = reviewActivitySpans(reviewActivityParts(operationsStore.get().active, null, false))
    .map((part) => part.text)
    .join('');
  expect(text).toBe('Review · answering again');
  resetWorkflow();
});

it.each([
  [
    { id: 'R1', moment: 'plan', scenario: 'workflow-x', command: 'npm run tui-shots' },
    'Render workflow-x',
  ],
  [{ id: 'V1', moment: 'base', command: 'npm test' }, 'Base re-run V1'],
  [{ id: 'V1', moment: 'brief', command: 'npm test' }, 'Fix check V1'],
  [{ id: 'K034', moment: 'plan', taskId: taskId('T007'), command: 'npm test' }, 'T007 check K034'],
  [{ id: 'P1', moment: 'plan', command: 'npm test' }, 'Plan check P1'],
  [{ id: 'T001-K1', moment: 'plan', taskId: taskId('T001'), command: 'npm test' }, 'Check T001-K1'],
  [
    { id: 'T002-K1', moment: 'plan', taskId: taskId('T001'), command: 'npm test' },
    'T001 check T002-K1',
  ],
  [{ moment: 'base', command: 'npm test' }, 'Base re-run'],
  [{ moment: 'brief', command: 'npm test' }, 'Fix check'],
] as const)('paints the %s lead for live activity and transcript rows', (suite, lead) => {
  for (const [context, tone] of [
    ['live', 'text'],
    ['transcript', 'textDim'],
  ] as const) {
    expect(suiteStageParts(suite, context)).toEqual([
      { text: lead, tone },
      ...('scenario' in suite
        ? []
        : [
            { text: ' · ', tone: 'textDim' },
            { text: suite.command, tone: 'textDim' },
          ]),
    ]);
  }
});

it.each([
  ['live', 'text'],
  ['transcript', 'textDim'],
] as const)(
  'ends a %s check that has no command on its lead, with no empty slot',
  (context, tone) => {
    expect(
      suiteStageParts({ id: 'K4', moment: 'plan', taskId: taskId('T002'), command: '' }, context),
    ).toEqual([{ text: 'T002 check K4', tone }]);
  },
);

it('ends the live status of a check that has no command on its lead', () => {
  expect(
    suiteStatusText({
      phase: 'implementing',
      suite: { id: 'K4', moment: 'plan', taskId: taskId('T002'), command: '' },
    }),
  ).toBe('T002 check K4');
});

describe('activeVerb', () => {
  it('uses the review activity wording for a running reviewer and for a waiting verdict', () => {
    resetWorkflow();
    try {
      addEvent(makeRunnerCallStarted({ phase: 'final-review', role: 'review' }));
      for (const reviewerLabel of ['codex · gpt-5', 'Claude Code CLI · Sonnet 4.5']) {
        const spans = reviewActivitySpans(
          reviewActivityParts(operationsStore.get().active, reviewerLabel, false),
        );
        expect(activeVerb('final-review', reviewerLabel, null)).toBe(
          spans.map((span) => span.text).join(''),
        );
      }
      expect(activeVerb('final-review', null, null)).toBe(
        reviewActivitySpans(reviewActivityParts(null, null, false))
          .map((span) => span.text)
          .join(''),
      );
    } finally {
      resetWorkflow();
    }
  });

  it('says one verb for the planning session and names an old chain briefs call', () => {
    expect(activeVerb('planning', null, 'plan')).toBe('Planning…');
    expect(activeVerb('planning', null, 'tasks')).toBe('Compiling briefs…');
  });

  it('says only that it is planning until the engine names the call', () => {
    expect(activeVerb('planning', null, null)).toBe('Planning…');
    expect(activeVerb('planning', null, 'research')).toBe('Planning…');
  });

  it('never claims briefs are being compiled while the plan is still being written', () => {
    for (const call of ['plan', null] as const) {
      expect(activeVerb('planning', null, call)).not.toContain('briefs');
    }
  });

  it('names the call a gate runs to rewrite its document with the verb it has outside the gate', () => {
    expect(activeVerb('reviewing-spec', null, 'spec')).toBe(activeVerb('specifying', null, 'spec'));
    expect(activeVerb('reviewing-plan', null, 'plan')).toBe('Planning…');
    expect(activeVerb('reviewing-plan', null, null)).toBe('Reviewing plan…');
    expect(activeVerb('reviewing-briefs', null, 'tasks')).toBe('Compiling briefs…');
    expect(activeVerb('reviewing-briefs', null, null)).toBe('Reviewing briefs…');
  });

  it('leaves every other phase to its own verb, whatever call is named', () => {
    for (const phase of PHASES) {
      if (
        phase === 'planning' ||
        phase === 'reviewing-spec' ||
        phase === 'reviewing-plan' ||
        phase === 'reviewing-briefs'
      )
        continue;
      expect(activeVerb(phase, null, 'tasks')).toBe(activeVerb(phase, null, null));
    }
    expect(activeVerb('final-review', 'Sonnet 4.5', null)).toBe(
      'Review · Sonnet 4.5 · reviewing changes',
    );
    expect(activeVerb('final-review', null, null)).toBe('Review · reviewing changes');
  });
});

describe('suiteStageText', () => {
  it('keeps task reviewer checks and their base re-runs in Review', () => {
    resetWorkflow();
    addEvent({
      type: 'review_started',
      ts: 1_000,
      phase: 'implementing',
      scope: 'task',
      tool: 'codex',
    });
    const review = operationsStore.get().active;
    expect(
      suiteStatusText({
        phase: 'implementing',
        suite: { id: 'V1', moment: 'pre-review', command: 'npm test' },
        operation: review,
      }),
    ).toBe('Review · Reviewer check V1 · npm test');
    expect(
      suiteStatusText({
        phase: 'implementing',
        suite: { id: 'V1', moment: 'base', command: 'npm test' },
        operation: review,
      }),
    ).toBe('Review · Base re-run V1 · npm test');
    expect(
      suiteStatusText({
        phase: 'implementing',
        suite: { id: 'V1', moment: 'brief', command: 'npm test' },
      }),
    ).toBe('Fix check V1 · npm test');
    resetWorkflow();
  });
  it('names the moment of the full suite and the command it runs', () => {
    expect(suiteStageText({ moment: 'base', command: 'npm test -- src/legacy.test.ts' })).toBe(
      'Base re-run · npm test -- src/legacy.test.ts',
    );
    expect(suiteStageText({ moment: 'pre-review', command: 'npm run lint' })).toBe(
      'Pre-review suite · npm run lint',
    );
    expect(suiteStageText({ moment: 'pre-review', command: 'npm test' })).toBe(
      'Pre-review suite · npm test',
    );
  });

  it('names a reviewer check and its re-run at the run base by the check id', () => {
    expect(suiteStageText({ id: 'V2', moment: 'pre-review', command: 'npm test' })).toBe(
      'Reviewer check V2 · npm test',
    );
    expect(suiteStageText({ id: 'V2', moment: 'base', command: 'npm test' })).toBe(
      'Base re-run V2 · npm test',
    );
  });

  it('names a reviewer check a fix brief runs again as a fix check', () => {
    expect(suiteStageText({ id: 'V2', moment: 'brief', command: 'npm test' })).toBe(
      'Fix check V2 · npm test',
    );
  });
});

describe('review waiting spans', () => {
  it('is the status text while reviewing changes in final review', () => {
    expect(
      reviewActivitySpans(reviewActivityParts(null, null, false))
        .map((part) => part.text)
        .join(''),
    ).toBe('Review · reviewing changes');
  });

  it('names the recheck of the merged result, not a review, when REVIEW is None', () => {
    expect(reviewActivityParts(null, 'None', true)).toEqual({
      prefix: [],
      identity: null,
      suffix: [{ text: 'Checking the merged result', tone: 'textDim' }],
    });
  });
});

function suiteStatusText(input: {
  phase: Parameters<typeof suiteStatusParts>[0];
  suite: Parameters<typeof suiteStatusParts>[1];
  operation?: Parameters<typeof suiteStatusParts>[2];
}): string {
  return suiteStatusParts(input.phase, input.suite, input.operation)
    .map((part) => part.text)
    .join('');
}

it('names the consult while the planner answers for Build', () => {
  expect(activeVerb('escalating', null, null)).toMatch(/consult/i);
});
