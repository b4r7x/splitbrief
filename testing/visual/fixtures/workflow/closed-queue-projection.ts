import { deriveRunStatus } from '../../../../src/core/sessions/run-status.js';
import type { EngineEvent } from '../../../../src/engine/events/types.js';
import { makeMessage } from '../../../helpers/queue.js';
import { scenarioId } from '../../contracts/identifiers.js';
import { atRestProjections } from './at-rest-projections.js';
import type { WorkflowFixtureProjection } from './projections.js';

const ended = atRestProjections.find(
  (projection) => projection.scenarioId === 'workflow-closed-ended',
);
const record = ended?.atRest?.record;
const endedLog = ended?.atRest?.log;
if (
  ended === undefined ||
  typeof endedLog !== 'object' ||
  record?.hydration.kind !== 'loaded' ||
  record.startedAt === null ||
  record.summary === null
) {
  throw new Error('The closed queue fixture requires the ended BUILD run');
}

// The message was queued for BUILD while T003 ran, before the stop that ended the run.
const queuedAt = Date.parse(record.startedAt) + record.summary.totalTime - 1_500;
const message = {
  ...makeMessage('Keep the validation API'),
  phase: 'implementing',
  queuedAt: new Date(queuedAt).toISOString(),
} satisfies ReturnType<typeof makeMessage>;
const state = {
  ...record.hydration.state,
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
      status: deriveRunStatus({ state, liveness: 'not-alive', reviewNone: false }),
    },
    log: endedLog.flatMap<EngineEvent>((event) =>
      event.type === 'turn_interrupted'
        ? [
            {
              type: 'message_queued',
              ts: queuedAt,
              phase: 'implementing',
              id: message.id,
              seat: 'build',
              preview: message.text,
            },
            event,
          ]
        : [event],
    ),
  },
};
