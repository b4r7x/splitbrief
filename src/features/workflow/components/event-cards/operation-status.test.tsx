import { describe, expect, it } from 'vitest';
import { renderFeature } from '#testing/helpers/ink.js';
import type { EngineEventOf } from '../../../../engine/events/types.js';
import type { ActiveOperation } from '../../../../stores/workflow/operations.js';
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
});
