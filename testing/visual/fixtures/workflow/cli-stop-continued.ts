import {
  WORKSPACE_KEPT_CODE,
  WORKSPACE_NOTICE_CATEGORY,
} from '../../../../src/core/sessions/workspace-notice.js';
import { taskId } from '../../../../src/core/schemas/task.js';
import { retainedWorkspaceNotice } from '../../../../src/engine/orchestrator/isolation/retention.js';
import type { EngineEvent, EngineEventOf } from '../../../../src/engine/events/types.js';
import { VISUAL_FIXTURE_EPOCH as epoch } from '../common.js';
import { scenarioId } from '../../contracts/identifiers.js';
import type { WorkflowFixtureProjection } from './projections.js';

const FEATURE = 'Add a greeting helper';
const BRIEF = taskId('T001');
const GREET = 'src/greet.ts';
const SEAT = { tool: 'codex', model: 'gpt-5-codex' } as const;

const briefStarted = (ts: number): EngineEvent => ({
  type: 'task_started',
  ts,
  phase: 'implementing',
  taskId: BRIEF,
  title: FEATURE,
  index: 0,
  total: 2,
  file: GREET,
  files: [GREET, 'src/greet.test.ts'],
  action: 'create',
  tool: SEAT.tool,
  model: SEAT.model,
  backendKind: 'cli',
});

const call = (
  ts: number,
  callId: string,
  attempt: number,
): EngineEventOf<'runner_call_started'> => ({
  type: 'runner_call_started',
  ts,
  phase: 'implementing',
  taskId: BRIEF,
  callId,
  role: 'implementer',
  backendKind: 'cli',
  runnerName: SEAT.tool,
  model: SEAT.model,
  attempt,
  sequence: 0,
});

const activity = (
  started: EngineEventOf<'runner_call_started'>,
  ts: number,
  fields: Pick<
    EngineEventOf<'runner_call_activity'>,
    | 'activityId'
    | 'stage'
    | 'kind'
    | 'label'
    | 'target'
    | 'diagnosticPartial'
    | 'rawAvailable'
    | 'endUnknown'
  >,
): EngineEvent => ({
  type: 'runner_call_activity',
  ts,
  phase: 'implementing',
  taskId: BRIEF,
  callId: started.callId,
  role: 'implementer',
  backendKind: 'cli',
  runnerName: SEAT.tool,
  model: SEAT.model,
  attempt: started.attempt,
  sequence: 1,
  redacted: false,
  ...fields,
});

const crashed = call(epoch + 1_000, 'cli-stop:crashed', 0);
const stopped = call(epoch + 40_000, 'cli-stop:stopped', 0);
const continued = call(epoch + 90_000, 'cli-stop:continued', 0);

/**
 * A run continued twice: the first call was cut when SPLITBRIEF went away, the second when you
 * stopped the CLI tool mid-call, after a line of its own text split its activity in two. The
 * third call has started and reported nothing yet, so the brief, not a batch of a cut call,
 * carries the live mark, and neither cut reads as an error.
 */
export const cliStopContinuedProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-cli-stop-continued'),
  feature: FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  config: { implementer: { kind: 'cli', ...SEAT } },
  events: [
    { type: 'workflow_started', ts: epoch, phase: 'implementing', feature: FEATURE },
    {
      type: 'tasks_planned',
      ts: epoch + 10,
      phase: 'implementing',
      tasks: [
        { id: BRIEF, title: FEATURE, index: 0, file: GREET, action: 'create' },
        {
          id: taskId('T002'),
          title: 'Print the greeting from the CLI',
          index: 1,
          file: 'src/cli.ts',
          action: 'modify',
        },
      ],
      total: 2,
    },
    briefStarted(epoch + 100),
    crashed,
    activity(crashed, epoch + 2_000, {
      activityId: 'cli-stop:crashed:read',
      stage: 'completed',
      kind: 'read',
      label: `reading ${GREET}`,
      target: GREET,
    }),
    activity(crashed, epoch + 2_000, {
      activityId: 'cli-stop:crashed:terminal',
      stage: 'aborted',
      kind: 'error',
      label: 'aborted runner_interrupted',
      diagnosticPartial: 'SPLITBRIEF exited',
      endUnknown: true,
    }),
    { type: 'workflow_resumed', ts: epoch + 30_000, phase: 'implementing' },
    briefStarted(epoch + 30_100),
    stopped,
    activity(stopped, epoch + 40_500, {
      activityId: 'cli-stop:stopped:read',
      stage: 'completed',
      kind: 'read',
      label: `reading ${GREET}`,
      target: GREET,
    }),
    {
      type: 'planner_text',
      ts: epoch + 40_800,
      phase: 'implementing',
      role: 'implementer',
      content: 'markdown',
      text: `The first attempt left ${GREET} without its export, so I will add it.`,
    },
    activity(stopped, epoch + 41_000, {
      activityId: 'cli-stop:stopped:edit',
      stage: 'completed',
      kind: 'edit',
      label: `editing ${GREET}`,
      target: GREET,
    }),
    activity(stopped, epoch + 45_000, {
      activityId: 'cli-stop:stopped:terminal',
      stage: 'aborted',
      kind: 'error',
      label: 'aborted runner_interrupted',
      diagnosticPartial: 'stopped by you',
      rawAvailable: true,
    }),
    {
      type: 'turn_interrupted',
      ts: epoch + 45_100,
      phase: 'implementing',
      source: 'user',
      at: 'mid-step',
      step: { kind: 'brief', taskId: BRIEF, attempt: 0 },
    },
    {
      type: 'warning',
      ts: epoch + 45_200,
      phase: 'implementing',
      message: retainedWorkspaceNotice('.splitbrief/trees/greeting/2026-10-14-greeting'),
      category: WORKSPACE_NOTICE_CATEGORY,
      code: WORKSPACE_KEPT_CODE,
    },
    { type: 'workflow_resumed', ts: epoch + 80_000, phase: 'implementing' },
    briefStarted(epoch + 80_100),
    continued,
  ],
};
