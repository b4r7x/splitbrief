import { describe, it, expect } from 'vitest';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { parseEngineEvent } from '../../events/schema.js';
import { publishReviewCheck, publishReviewChecks } from './review.js';

describe('publishReviewChecks', () => {
  it.each(['off', 'none'] as const)('publishes a %s record with no other field', (status) => {
    const { bus, events } = makeBusRecorder();
    publishReviewChecks({ bus, phase: 'final-review' }, status);

    expect(parseEngineEvent(events[0])).toEqual({
      type: 'review_checks',
      ts: expect.any(Number),
      phase: 'final-review',
      status,
    });
  });
});

describe('publishReviewCheck', () => {
  it('publishes a full_suite record with the check id and the detail of a refusal', () => {
    const { bus, events } = makeBusRecorder();
    publishReviewCheck(
      { bus, phase: 'final-review' },
      {
        status: 'refused',
        id: 'V2',
        command: 'make test',
        moment: 'pre-review',
        detail: 'runs make on Makefile, which this run changed',
      },
    );

    const event = parseEngineEvent(events[0]);
    expect(event).toMatchObject({
      type: 'full_suite',
      status: 'refused',
      id: 'V2',
      command: 'make test',
      moment: 'pre-review',
      detail: 'runs make on Makefile, which this run changed',
    });
    expect(event).not.toHaveProperty('stage');
    expect(event).not.toHaveProperty('passed');
  });

  it('carries the verdict and duration of a finished base re-run', () => {
    const { bus, events } = makeBusRecorder();
    publishReviewCheck(
      { bus, phase: 'final-review' },
      {
        status: 'done',
        id: 'V1',
        command: 'npm test',
        moment: 'base',
        passed: false,
        duration: 12,
      },
    );

    expect(parseEngineEvent(events[0])).toMatchObject({
      type: 'full_suite',
      status: 'done',
      id: 'V1',
      moment: 'base',
      passed: false,
      duration: 12,
    });
  });

  it('carries the timeout of a finished check and omits the field on one that did not time out', () => {
    const { bus, events } = makeBusRecorder();
    publishReviewCheck(
      { bus, phase: 'final-review' },
      {
        status: 'done',
        id: 'V1',
        command: 'npm test',
        moment: 'base',
        passed: false,
        timedOut: true,
      },
    );
    publishReviewCheck(
      { bus, phase: 'final-review' },
      {
        status: 'done',
        id: 'V2',
        command: 'npm run lint',
        moment: 'base',
        passed: true,
      },
    );

    expect(parseEngineEvent(events[0])).toMatchObject({ status: 'done', timedOut: true });
    expect(parseEngineEvent(events[1])).not.toHaveProperty('timedOut');
  });

  it('names the first failing tests of each side of a base split and omits an empty side', () => {
    const { bus, events } = makeBusRecorder();
    publishReviewCheck(
      { bus, phase: 'final-review' },
      {
        status: 'done',
        id: 'V1',
        command: 'npm test',
        moment: 'base',
        passed: false,
        newFailures: 0,
        preExisting: 5,
        newKeys: [],
        preExistingKeys: [
          'a.test.ts::one',
          'a.test.ts::two',
          'b.test.ts::three',
          'b.test.ts::four',
        ],
      },
    );

    const event = parseEngineEvent(events[0]);
    expect(event).toMatchObject({
      preExistingKeys: ['a.test.ts::one', 'a.test.ts::two', 'b.test.ts::three'],
    });
    expect(event).not.toHaveProperty('newKeys');
  });
});
