import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makePlannerStatus } from '#testing/helpers/events.js';
import { renderFeature } from '#testing/helpers/ink.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { addEvent, resetWorkflow } from '../../../stores/workflow/actions.js';
import { AgentStatusRow } from './agent-status-row.js';

const SPINNER_FRAME_PATTERN = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u;

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

describe('AgentStatusRow', () => {
  beforeEach(() => resetWorkflow());
  afterEach(() => resetWorkflow());

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
    addEvent(makePlannerHeartbeat({ accumulatedTokens: 900, phaseHint: 'reading files' }));

    const ui = renderFeature(<AgentStatusRow />);
    const frame = ui.lastFrame() ?? '';

    expect(frame).toContain('900 tokens');
    expect(frame).toContain('reading files');

    ui.unmount();
  });
});
