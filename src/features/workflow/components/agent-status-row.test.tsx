import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makePlannerStatus } from '#testing/helpers/events.js';
import { renderFeature } from '#testing/helpers/ink.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { addEvent, resetWorkflow } from '../../../stores/workflow/actions.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { AgentStatusRow } from './agent-status-row.js';

const SPINNER_FRAME_PATTERN = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u;
type RunnerToolUseDeltaEvent = Extract<EngineEventOf<'runner_call_tool_use'>, { stage: 'delta' }>;

function makePlannerHeartbeat(
  overrides?: Partial<EngineEventOf<'planner_heartbeat'>>,
): EngineEventOf<'planner_heartbeat'> {
  return {
    type: 'planner_heartbeat',
    ts: 1_250,
    phase: 'planning',
    elapsedMs: 250,
    accumulatedTokens: 42_000,
    phaseHint: 'generating plan',
    ...overrides,
  };
}

function makePlannerRunnerStarted(
  overrides?: Partial<EngineEventOf<'runner_call_started'>>,
): EngineEventOf<'runner_call_started'> {
  return {
    type: 'runner_call_started',
    ts: 1_000,
    phase: 'planning',
    callId: 'planner-call-1',
    role: 'planner',
    backendKind: 'cli',
    runnerName: 'codex',
    model: 'default',
    sequence: 1,
    ...overrides,
  };
}

function makeRunnerWarning(
  overrides?: Partial<EngineEventOf<'runner_call_warning'>>,
): EngineEventOf<'runner_call_warning'> {
  return {
    type: 'runner_call_warning',
    ts: 1_100,
    phase: 'planning',
    callId: 'planner-call-1',
    role: 'planner',
    backendKind: 'cli',
    runnerName: 'codex',
    model: 'default',
    sequence: 2,
    warning: { code: 'stderr', message: 'stderr noise' },
    ...overrides,
  };
}

function makeRunnerTextDelta(
  overrides?: Partial<EngineEventOf<'runner_call_text_delta'>>,
): EngineEventOf<'runner_call_text_delta'> {
  return {
    type: 'runner_call_text_delta',
    ts: 1_100,
    phase: 'planning',
    callId: 'planner-call-1',
    role: 'planner',
    backendKind: 'cli',
    runnerName: 'codex',
    model: 'default',
    sequence: 2,
    channel: 'stdout',
    text: 'reading files',
    ...overrides,
  };
}

function makeRunnerToolUse(
  overrides?: Partial<RunnerToolUseDeltaEvent>,
): EngineEventOf<'runner_call_tool_use'> {
  const event: RunnerToolUseDeltaEvent = {
    ...overrides,
    type: 'runner_call_tool_use',
    ts: overrides?.ts ?? 1_150,
    phase: overrides?.phase ?? 'planning',
    callId: overrides?.callId ?? 'planner-call-1',
    role: overrides?.role ?? 'planner',
    backendKind: overrides?.backendKind ?? 'cli',
    runnerName: overrides?.runnerName ?? 'codex',
    model: overrides?.model ?? 'default',
    sequence: overrides?.sequence ?? 3,
    stage: overrides?.stage ?? 'delta',
    name: overrides?.name ?? 'Bash',
    inputDelta: overrides?.inputDelta ?? '{"command":"npm run typecheck"}',
  };
  return event;
}

function makeRunnerError(
  overrides?: Partial<EngineEventOf<'runner_call_error'>>,
): EngineEventOf<'runner_call_error'> {
  return {
    type: 'runner_call_error',
    ts: 1_300,
    phase: 'planning',
    callId: 'planner-call-1',
    role: 'planner',
    backendKind: 'cli',
    runnerName: 'codex',
    model: 'default',
    sequence: 3,
    status: 'failed',
    error: { code: 'failed', message: 'runner stopped' },
    partial: false,
    startedAt: 1_000,
    endedAt: 1_300,
    durationMs: 300,
    usage: null,
    nativeSessionId: null,
    ...overrides,
  };
}

function makeRunnerCompleted(
  overrides?: Partial<EngineEventOf<'runner_call_completed'>>,
): EngineEventOf<'runner_call_completed'> {
  return {
    type: 'runner_call_completed',
    ts: 1_300,
    phase: 'planning',
    callId: 'planner-call-1',
    role: 'planner',
    backendKind: 'cli',
    runnerName: 'codex',
    model: 'default',
    sequence: 3,
    status: 'completed',
    error: null,
    partial: false,
    startedAt: 1_000,
    endedAt: 1_300,
    durationMs: 300,
    usage: null,
    nativeSessionId: null,
    ...overrides,
  };
}

describe('AgentStatusRow', () => {
  beforeEach(() => {
    resetWorkflow();
    terminalSizeStore.__testReset({ cols: 100, rows: 24, isSmall: true });
  });
  afterEach(() => {
    resetWorkflow();
    terminalSizeStore.__testReset();
  });

  it('renders cancellation as terminal after planner_status running plus workflow_cancelled', () => {
    addEvent(makePlannerStatus({ ts: 1_000, phase: 'planning', status: 'running' }));
    addEvent({
      type: 'workflow_cancelled',
      ts: 1_250,
      phase: 'planning',
      reason: 'user_cancelled',
    });

    const ui = renderFeature(<AgentStatusRow />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('cancelled');
    expect(frame).not.toMatch(SPINNER_FRAME_PATTERN);
    expect(frame).not.toContain('...');
    expect(frame).not.toContain('(still waiting...)');
    expect(frame).not.toContain('✓');

    ui.unmount();
  });

  it('does not render planner answer text in status chrome', () => {
    addEvent(makePlannerRunnerStarted());
    addEvent(
      makeRunnerTextDelta({ channel: 'assistant', text: 'This answer belongs in transcript' }),
    );

    const ui = renderFeature(<AgentStatusRow />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('planner planning');
    expect(frame).not.toContain('This answer belongs in transcript');

    ui.unmount();
  });

  it('renders heartbeat tokens and phase hint for legacy planner_status', () => {
    addEvent(makePlannerStatus({ ts: 1_000, phase: 'planning', status: 'running' }));
    addEvent(makePlannerHeartbeat());

    const ui = renderFeature(<AgentStatusRow />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('42.0k tokens');
    expect(frame).toContain('generating plan');

    ui.unmount();
  });

  it('renders heartbeat tokens and phase hint for a planner runner call', () => {
    addEvent(makePlannerRunnerStarted());
    addEvent(
      makePlannerHeartbeat({
        accumulatedTokens: 900,
        phaseHint: 'reading files',
        callId: 'planner-call-1',
      }),
    );

    const ui = renderFeature(<AgentStatusRow />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('900 tokens');
    expect(frame).toContain('reading files');

    ui.unmount();
  });

  it('does not render unscoped legacy heartbeat proof-of-life for a planner runner call', () => {
    addEvent(makePlannerRunnerStarted());
    addEvent(makePlannerHeartbeat({ accumulatedTokens: 900, phaseHint: 'reading files' }));

    const ui = renderFeature(<AgentStatusRow />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('planner planning');
    expect(frame).not.toContain('900 tokens');
    expect(frame).not.toContain('reading files');

    ui.unmount();
  });

  it('keeps runner activity labels out of compact running status', () => {
    addEvent(makePlannerRunnerStarted());
    addEvent(makeRunnerToolUse());

    const ui = renderFeature(<AgentStatusRow />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('planner planning');
    expect(frame).not.toContain('running npm run typecheck');

    ui.unmount();
  });

  it('keeps proof-of-life ahead of runner identity in narrow running status', () => {
    terminalSizeStore.__testReset({ cols: 52, rows: 24, isSmall: true });
    addEvent(
      makePlannerRunnerStarted({
        runnerName: 'codex',
        model: 'expensive-model-that-should-drop-first',
      }),
    );
    addEvent(
      makePlannerHeartbeat({
        accumulatedTokens: 42_000,
        phaseHint: undefined,
        callId: 'planner-call-1',
      }),
    );
    addEvent(makeRunnerToolUse({ inputDelta: '{"command":"npm run typecheck"}' }));

    const ui = renderFeature(<AgentStatusRow />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toMatch(SPINNER_FRAME_PATTERN);
    expect(frame).toContain('planner planning');
    expect(frame).toContain('42.0k tokens');
    expect(frame).not.toContain('npm run typecheck');
    expect(frame).not.toContain('expensive-model');

    ui.unmount();
  });

  it('shows planner fallback tool and model in wide running status', () => {
    terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
    addEvent(
      makePlannerStatus({
        ts: 1_000,
        phase: 'planning',
        status: 'running',
        tool: 'codex',
        model: 'gpt-5',
      }),
    );

    const ui = renderFeature(<AgentStatusRow />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('planner planning');
    expect(frame).toContain('Codex');
    expect(frame).toContain('gpt-5');

    ui.unmount();
  });

  it('renders terminal failure kind, partial output, warning count, and latest warning text', () => {
    addEvent(makePlannerRunnerStarted());
    addEvent(makeRunnerWarning({ warning: { code: 'stderr', message: 'old warning' } }));
    addEvent(
      makeRunnerWarning({
        sequence: 3,
        warning: { code: 'stderr', message: 'latest warning detail' },
      }),
    );
    addEvent(
      makeRunnerError({
        sequence: 4,
        status: 'truncated',
        error: { code: 'truncated', message: 'runner stopped' },
        partial: true,
      }),
    );

    const ui = renderFeature(<AgentStatusRow />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('truncated');
    expect(frame).toContain('partial output');
    expect(frame).toContain('2 warnings');
    expect(frame).toContain('latest warning detail');

    ui.unmount();
  });

  it('shows warning count for a successful call without expanding warning text', () => {
    addEvent(makePlannerRunnerStarted());
    addEvent(makeRunnerWarning({ warning: { code: 'stderr', message: 'success warning detail' } }));
    addEvent(makeRunnerCompleted());

    const ui = renderFeature(<AgentStatusRow />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('1 warning');
    expect(frame).not.toContain('success warning detail');
    expect(frame).not.toContain('partial output');

    ui.unmount();
  });

  it('keeps successful calls without warnings compact', () => {
    addEvent(makePlannerRunnerStarted());
    addEvent(makeRunnerCompleted());

    const ui = renderFeature(<AgentStatusRow />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('planning');
    expect(frame).not.toContain('warning');
    expect(frame).not.toContain('partial output');
    expect(frame).not.toContain('runner stopped');

    ui.unmount();
  });
});
