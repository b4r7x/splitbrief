import type { EngineEvent } from '../../../../src/engine/events/types.js';
import { VISUAL_FIXTURE_EPOCH as epoch } from '../common.js';
import { scenarioId } from '../../contracts/identifiers.js';
import type { WorkflowFixtureProjection } from './projections.js';

const check = (ts: number): EngineEvent => ({
  type: 'full_suite',
  ts,
  phase: 'final-review',
  status: 'done',
  moment: 'plan',
  id: 'K1',
  command: 'npm test',
  passed: true,
  duration: 250,
});
const start = (ts: number): EngineEvent => ({
  type: 'review_started',
  ts,
  phase: 'final-review',
  scope: 'final',
  tool: 'claude-code',
  model: 'sonnet',
});

export const reviewResumeProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-review-resumed'),
  feature: 'Add a multiply function',
  inputMode: 'normal',
  sidebarVisible: false,
  config: { planner: { kind: 'cli', tool: 'claude-code', model: 'sonnet' } },
  events: [
    check(epoch + 1_000),
    start(epoch + 1_250),
    {
      type: 'runner_call_activity',
      ts: epoch + 4_000,
      phase: 'final-review',
      callId: 'review:first',
      role: 'review',
      backendKind: 'cli',
      runnerName: 'claude',
      model: 'sonnet',
      sequence: 1,
      activityId: 'review:first:terminal',
      stage: 'aborted',
      kind: 'error',
      label: 'aborted runner_interrupted',
      diagnosticPartial: 'SPLITBRIEF exited',
      endUnknown: true,
      redacted: false,
    },
    { type: 'workflow_resumed', ts: epoch + 20_000, phase: 'final-review' },
    check(epoch + 20_250),
    start(epoch + 20_500),
    {
      type: 'runner_call_activity',
      ts: epoch + 21_000,
      phase: 'final-review',
      callId: 'review:second',
      role: 'review',
      backendKind: 'cli',
      runnerName: 'claude',
      model: 'sonnet',
      sequence: 1,
      activityId: 'review:second:tool:read',
      stage: 'completed',
      kind: 'read',
      label: 'reading src/math.js',
      target: 'src/math.js',
      redacted: false,
    },
    {
      type: 'review_checks',
      ts: epoch + 30_000,
      phase: 'final-review',
      scope: 'final',
      status: 'planned',
      commands: [{ id: 'V1', command: 'npm test', reason: 'Verify multiplication.' }],
      declined: [],
      reason: null,
    },
    {
      type: 'full_suite',
      ts: epoch + 30_250,
      phase: 'final-review',
      status: 'done',
      moment: 'pre-review',
      id: 'V1',
      command: 'npm test',
      passed: true,
      duration: 250,
    },
    {
      type: 'drift_report',
      ts: epoch + 30_500,
      phase: 'final-review',
      passed: true,
      errorCount: 0,
      warningCount: 0,
      findings: [],
    },
    {
      type: 'review_completed',
      ts: epoch + 39_500,
      phase: 'final-review',
      scope: 'final',
      tool: 'claude-code',
      verdict: 'pass',
      duration: 19_000,
    },
    { type: 'workflow_complete', ts: epoch + 40_000, phase: 'complete', review: 'passed' },
  ],
};

export const reviewCheckCrashProjection: WorkflowFixtureProjection = {
  ...reviewResumeProjection,
  scenarioId: scenarioId('workflow-review-check-crash'),
  events: reviewResumeProjection.events.flatMap((event): EngineEvent[] =>
    event.type === 'runner_call_activity' && event.stage === 'aborted'
      ? [
          {
            type: 'review_checks',
            ts: epoch + 3_000,
            phase: 'final-review',
            scope: 'final',
            status: 'planned',
            commands: [{ id: 'V1', command: 'npm test', reason: 'Verify multiplication.' }],
          },
          {
            type: 'full_suite',
            ts: epoch + 4_250,
            phase: 'final-review',
            status: 'running',
            moment: 'pre-review',
            id: 'V1',
            command: 'npm test',
          },
        ]
      : [event],
  ),
};
