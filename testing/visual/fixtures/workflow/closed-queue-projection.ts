import { deriveRunStatus } from '../../../../src/core/sessions/run-status.js';
import { makeMessage } from '../../../helpers/queue.js';
import { scenarioId } from '../../contracts/identifiers.js';
import { atRestProjections } from './at-rest-projections.js';
import type { WorkflowFixtureProjection } from './projections.js';

const ended = atRestProjections.find(
  (projection) => projection.scenarioId === 'workflow-closed-ended',
);
const record = ended?.atRest?.record;
if (
  ended === undefined ||
  record?.hydration.kind !== 'loaded' ||
  record.startedAt === null ||
  record.summary === null
) {
  throw new Error('The closed queue fixture requires the ended BUILD run');
}

const endedAt = Date.parse(record.startedAt) + record.summary.totalTime;
const message = {
  ...makeMessage('Keep the validation API'),
  phase: 'implementing',
  queuedAt: new Date(endedAt - 1).toISOString(),
} satisfies ReturnType<typeof makeMessage>;
const state = {
  ...record.hydration.state,
  closed: { as: 'ended', at: new Date(endedAt).toISOString() },
  messageQueue: [message],
} satisfies typeof record.hydration.state;

export const closedQueueProjection: WorkflowFixtureProjection = {
  ...ended,
  scenarioId: scenarioId('workflow-closed-queued'),
  atRest: {
    record: {
      ...record,
      ref: { ...record.ref, sessionId: 'visual-closed-queued' },
      hydration: { kind: 'loaded', state },
      status: deriveRunStatus({ state, liveness: 'not-alive' }),
    },
    log: [
      {
        type: 'message_queued',
        ts: endedAt - 1,
        phase: 'implementing',
        id: message.id,
        seat: 'build',
        preview: message.text,
      },
    ],
  },
};
