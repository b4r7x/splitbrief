import { projectRunnerCallEvents } from '../../../../src/engine/calls/event-projection.js';
import {
  boundRunnerCallToolUse,
  runnerCallLimitWarning,
} from '../../../../src/engine/calls/output-limit.js';
import type { RunnerCallEvent } from '../../../../src/engine/calls/types.js';
import { normalizeRunnerCallWarning } from '../../../../src/engine/calls/warnings.js';
import { scenarioId } from '../../contracts/identifiers.js';
import { BASE_PLANNER, VISUAL_FIXTURE_PROJECT_DIR } from '../screen-fixtures.js';
import type { WorkflowFixtureProjection } from './projections.js';

const LIMIT_TS = 1_783_958_400_000;
const LIMIT_FEATURE = 'Visual fixture workflow';
const LIMIT_CALL_ID = 'visual-output-limit-call';

export const OUTPUT_LIMIT_READ_FILE = 'docs/ARCHITECTURE.md';

const TOOL_OUTPUT = boundRunnerCallToolUse({
  id: 'visual-output-limit-read-output',
  name: 'Read',
  input: { file_path: OUTPUT_LIMIT_READ_FILE },
  output: 'x'.repeat(300 * 1024),
});
const TOOL_OUTPUT_LIMIT = TOOL_OUTPUT.limit;

export const OUTPUT_LIMIT_TOOL_OUTPUT_MESSAGE =
  TOOL_OUTPUT_LIMIT === null ? '' : TOOL_OUTPUT_LIMIT.message;

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
        warning: normalizeRunnerCallWarning({
          ...runnerCallLimitWarning(TOOL_OUTPUT_LIMIT),
          fingerprint: 'rw:visual-output-limit-tool-output',
        }),
      };

// The recorder notes the limit before it records the bounded tool use.
const TOOL_OUTPUT_DONE: RunnerCallEvent = {
  type: 'call_tool_use_done',
  ts: LIMIT_TS + 102,
  callId: LIMIT_CALL_ID,
  role: 'planner',
  backendKind: 'cli',
  runnerName: 'claude',
  model: BASE_PLANNER.model,
  channel: 'tool',
  toolUse: TOOL_OUTPUT.value,
};

const LIMIT_CALL: readonly RunnerCallEvent[] =
  TOOL_OUTPUT_LIMIT_WARNING === null
    ? [TOOL_OUTPUT_DONE]
    : [TOOL_OUTPUT_LIMIT_WARNING, TOOL_OUTPUT_DONE];

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
