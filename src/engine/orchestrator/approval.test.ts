import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowState } from '../../types.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-fixtures.js';

vi.mock('../../core/state/persistence.js', () => ({
  saveState: vi.fn(),
  appendEvent: vi.fn(),
}));
vi.mock('../../core/paths-io.js', () => ({
  readSpecFileOrEmpty: vi.fn().mockReturnValue(''),
  writeSpecFile: vi.fn(),
  ensureDiptychDir: vi.fn(),
}));
vi.mock('../spec/prompts/plan.js', () => ({
  buildRegeneratePrompt: vi.fn().mockReturnValue('regen prompt'),
}));

import { runApprovalLoop } from './approval.js';

beforeEach(() => { vi.clearAllMocks(); });

function prepareState(): WorkflowState {
  let state = createInitialState('test-feature');
  state = transition(state, { type: 'START', feature: 'test-feature' });
  return state;
}

describe('runApprovalLoop', () => {
  it('returns not-rejected when user approves', async () => {
    const { callbacks } = makeCallbacks({ onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }) });
    const result = await runApprovalLoop({
      type: 'spec',
      filePath: '/mock/spec.md',
      planner: makePlanner(),
      projectDir: '/mock',
      sessionId: 'test-session',
      callbacks,
      state: prepareState(), persistTranscript: false,
    });
    expect(result.rejected).toBe(false);
    expect(result.regenerated).toBe(false);
  });

  it('returns rejected when user declines without comment', async () => {
    const { callbacks } = makeCallbacks({ onApprovalNeeded: vi.fn().mockResolvedValue({ approved: false }) });
    const result = await runApprovalLoop({
      type: 'spec',
      filePath: '/mock/spec.md',
      planner: makePlanner(),
      projectDir: '/mock',
      sessionId: 'test-session',
      callbacks,
      state: prepareState(), persistTranscript: false,
    });
    expect(result.rejected).toBe(true);
  });

  it('returns not-rejected immediately when AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const onApprovalNeeded = vi.fn();
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const result = await runApprovalLoop({
      type: 'spec',
      filePath: '/mock/spec.md',
      planner: makePlanner(),
      projectDir: '/mock',
      sessionId: 'test-session',
      callbacks,
      state: prepareState(), persistTranscript: false,
      signal: controller.signal,
    });
    expect(result.rejected).toBe(false);
    expect(onApprovalNeeded).not.toHaveBeenCalled();
  });

  it('does not treat an aborted in-flight approval prompt as rejection', async () => {
    const controller = new AbortController();
    const onApprovalNeeded = vi.fn().mockImplementationOnce(async () => {
      controller.abort();
      return { approved: false };
    });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const result = await runApprovalLoop({
      type: 'spec',
      filePath: '/mock/spec.md',
      planner: makePlanner(),
      projectDir: '/mock',
      sessionId: 'test-session',
      callbacks,
      state: prepareState(), persistTranscript: false,
      signal: controller.signal,
    });
    expect(result.rejected).toBe(false);
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
  });

  it('aborts after first approval call resolves when signal fires mid-loop', async () => {
    const controller = new AbortController();
    const onApprovalNeeded = vi.fn()
      .mockImplementationOnce(async () => {
        controller.abort();
        return { approved: false, comment: 'please regenerate' };
      });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const planner = makePlanner();

    const result = await runApprovalLoop({
      type: 'spec',
      filePath: '/mock/spec.md',
      planner,
      projectDir: '/mock',
      sessionId: 'test-session',
      callbacks,
      state: prepareState(), persistTranscript: false,
      signal: controller.signal,
    });

    // Regeneration was triggered for the comment, but on the next loop iteration
    // the signal is aborted so it returns early without hanging.
    expect(result.rejected).toBe(false);
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
  });
});
