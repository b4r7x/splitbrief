import { describe, expect, it } from 'vitest';
import { Box } from 'ink';
import { renderFeature } from '#testing/helpers/ink.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import type { ActiveOperation, OperationStatus } from '../../../../stores/workflow/operations.js';
import { OperationStatusCard } from './operation-status.js';

function runningPlannerOperation(): ActiveOperation {
  return {
    callId: 'planner-call-b',
    role: 'planner',
    phase: 'planning',
    label: 'planner planning',
    status: 'running',
    startedAt: 1_000,
    endedAt: null,
    durationMs: null,
    partial: false,
    reason: null,
    usage: null,
    warnings: [],
  };
}

function plannerHeartbeat(
  overrides?: Partial<EngineEventOf<'planner_heartbeat'>>,
): EngineEventOf<'planner_heartbeat'> {
  return {
    type: 'planner_heartbeat',
    ts: 1_200,
    phase: 'planning',
    elapsedMs: 200,
    accumulatedTokens: 900,
    callId: 'planner-call-a',
    phaseHint: 'reading files',
    ...overrides,
  };
}

type TerminalStatus = Exclude<OperationStatus, 'running'>;
type TerminalOperation = Exclude<ActiveOperation, { status: 'running' }>;

function terminalOperation(status: TerminalStatus): TerminalOperation {
  return {
    callId: `call-${status}`,
    role: 'implementer',
    phase: 'implementing',
    label: 'implementer implementing',
    status,
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
    partial: false,
    reason: null,
    usage: null,
    warnings: [],
  };
}

describe('OperationStatusCard', () => {
  it('renders heartbeat proof-of-life only for the matching planner call', () => {
    const operation = runningPlannerOperation();
    const ui = renderFeature(
      <OperationStatusCard
        operation={operation}
        plannerHeartbeat={plannerHeartbeat()}
        width={120}
      />,
    );

    const mismatchedFrame = ui.lastFrame() ?? '';
    expect(mismatchedFrame).toContain('planner planning');
    expect(mismatchedFrame).not.toContain('900 tokens');
    expect(mismatchedFrame).not.toContain('reading files');

    ui.rerender(
      <OperationStatusCard
        operation={operation}
        plannerHeartbeat={plannerHeartbeat({ callId: 'planner-call-b' })}
        width={120}
      />,
    );

    const matchedFrame = ui.lastFrame() ?? '';
    expect(matchedFrame).toContain('900 tokens');
    expect(matchedFrame).toContain('reading files');
    ui.unmount();
  });

  it('does not render unscoped legacy heartbeat proof-of-life for runner operations', () => {
    const ui = renderFeature(
      <OperationStatusCard
        operation={runningPlannerOperation()}
        plannerHeartbeat={plannerHeartbeat({ callId: undefined })}
        width={120}
      />,
    );

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('planner planning');
    expect(frame).not.toContain('900 tokens');
    expect(frame).not.toContain('reading files');
    ui.unmount();
  });

  it('renders failure reason before warning preview, partial output, and tool suffix', () => {
    const operation: ActiveOperation = {
      ...terminalOperation('failed'),
      reason: 'model refused to edit',
      partial: true,
      warnings: ['first warning', 'latest warning detail'],
      runnerName: 'codex',
      model: 'gpt-5',
    };

    const ui = renderFeature(
      <Box width={200}>
        <OperationStatusCard operation={operation} />
      </Box>,
    );
    const frame = ui.lastFrame() ?? '';

    const reasonIndex = frame.indexOf('model refused to edit');
    const warningIndex = frame.indexOf('2 warnings: latest warning detail');
    const partialIndex = frame.indexOf('partial output');
    const toolIndex = frame.indexOf('[Codex');

    expect(reasonIndex).toBeGreaterThan(-1);
    expect(warningIndex).toBeGreaterThan(reasonIndex);
    expect(partialIndex).toBeGreaterThan(warningIndex);
    expect(toolIndex).toBeGreaterThan(partialIndex);
    ui.unmount();
  });

  it.each([
    ['failed', 'failed implementing'],
    ['truncated', 'truncated implementing'],
    ['aborted', 'interrupted implementing'],
    ['timeout', 'timeout implementing'],
    ['refused', 'refused implementing'],
    ['unsupported_tool', 'unsupported tool implementing'],
    ['incomplete', 'incomplete implementing'],
  ] satisfies readonly (readonly [
    TerminalStatus,
    string,
  ])[])('keeps terminal status label distinct for %s', (status, label) => {
    const ui = renderFeature(<OperationStatusCard operation={terminalOperation(status)} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain(label);
    ui.unmount();
  });

  it('sanitizes terminal reason, warning preview, and tool labels at render boundary', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const operation: ActiveOperation = {
      ...terminalOperation('failed'),
      reason: `failed runner_interrupted ${jwt}\u001b[31m`,
      warnings: [`warn runner_interrupted ${jwt}`],
      runnerName: `codex ${jwt}`,
    };

    const ui = renderFeature(<OperationStatusCard operation={operation} />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('***REDACTED***');
    expect(frame).toContain('interrupted');
    expect(frame).not.toContain('runner_interrupted');
    expect(frame).not.toContain('eyJhbGci');
    expect(frame).not.toContain('\u001b');
    ui.unmount();
  });
});
