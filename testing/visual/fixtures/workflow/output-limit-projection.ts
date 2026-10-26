import { projectRunnerCallEvents } from '../../../../src/engine/calls/event-projection.js';
import {
  boundRunnerCallToolUse,
  runnerCallLimitWarning,
  runnerCallToolUseCountLimit,
} from '../../../../src/engine/calls/output-limit.js';
import type { RunnerCallEvent } from '../../../../src/engine/calls/types.js';
import { scenarioId } from '../../contracts/identifiers.js';
import { BASE_PLANNER, VISUAL_FIXTURE_PROJECT_DIR } from '../screen-fixtures.js';
import type { WorkflowFixtureProjection } from './projections.js';

const LIMIT_TS = 1_783_958_400_000;
const LIMIT_FEATURE = 'Visual fixture workflow';
const LIMIT_CALL_ID = 'visual-output-limit-call';

const TOOL_CALL_LIMIT = runnerCallToolUseCountLimit([
  { id: 'visual-output-limit-read-1', name: 'Read', input: { file_path: 'CLAUDE.md' } },
  { id: 'visual-output-limit-read-2', name: 'Read', input: { file_path: 'docs/ENGINE.md' } },
]);

const TOOL_OUTPUT_LIMIT = boundRunnerCallToolUse({
  id: 'visual-output-limit-read-output',
  name: 'Read',
  input: { file_path: 'docs/ARCHITECTURE.md' },
  output: 'x'.repeat(300 * 1024),
}).limit;

export const OUTPUT_LIMIT_TOOL_CALLS_MESSAGE = TOOL_CALL_LIMIT.message;

export const OUTPUT_LIMIT_TOOL_OUTPUT_MESSAGE =
  TOOL_OUTPUT_LIMIT === null ? '' : TOOL_OUTPUT_LIMIT.message;

const TOOL_CALL_LIMIT_WARNING: RunnerCallEvent = {
  type: 'call_warning',
  ts: LIMIT_TS + 100,
  callId: LIMIT_CALL_ID,
  role: 'planner',
  backendKind: 'cli',
  runnerName: 'claude',
  model: BASE_PLANNER.model,
  warning: {
    ...runnerCallLimitWarning(TOOL_CALL_LIMIT),
    severity: 'warning',
    source: 'system',
    surface: 'activity',
    fingerprint: 'rw:visual-output-limit-tool-calls',
  },
};

const TOOL_OUTPUT_LIMIT_WARNING: RunnerCallEvent | null =
  TOOL_OUTPUT_LIMIT === null
    ? null
    : {
        type: 'call_warning',
        ts: LIMIT_TS + 101,
        callId: LIMIT_CALL_ID,
        role: 'planner',
        backendKind: 'cli',
        runnerName: 'claude',
        model: BASE_PLANNER.model,
        warning: {
          ...runnerCallLimitWarning(TOOL_OUTPUT_LIMIT),
          severity: 'warning',
          source: 'system',
          surface: 'activity',
          fingerprint: 'rw:visual-output-limit-tool-output',
        },
      };

const LIMIT_CALL: readonly RunnerCallEvent[] = [
  TOOL_CALL_LIMIT_WARNING,
  ...(TOOL_OUTPUT_LIMIT_WARNING === null ? [] : [TOOL_OUTPUT_LIMIT_WARNING]),
];

export const outputLimitWarningProjection: WorkflowFixtureProjection = {
  scenarioId: scenarioId('workflow-output-limit-warning'),
  feature: LIMIT_FEATURE,
  inputMode: 'normal',
  sidebarVisible: false,
  events: [
    { type: 'workflow_started', ts: LIMIT_TS, phase: 'planning', feature: LIMIT_FEATURE },
    {
      type: 'planner_status',
      ts: LIMIT_TS + 50,
      phase: 'planning',
      status: 'running',
      tool: 'claude-code',
      model: BASE_PLANNER.model,
      call: 'plan',
    },
    ...LIMIT_CALL.flatMap((event, index) =>
      projectRunnerCallEvents(
        { ...event, ts: LIMIT_TS + 100 + index },
        { rootDir: VISUAL_FIXTURE_PROJECT_DIR, phase: 'planning', sequence: index },
      ),
    ),
  ],
};
