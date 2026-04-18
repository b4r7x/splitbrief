import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { ensureSessionDir, writeSpecFile } from '../../core/paths-io.js';
import { SPEC_FILE } from '../../core/paths.js';
import { runApprovalLoop } from './approval.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string; specPath: string } {
  const projectDir = createTempDir('approval-test');
  dirs.push(projectDir);
  const sessionId = 'sess-approval';
  ensureSessionDir(projectDir, sessionId);
  // Seed a real spec file so readSpecFileOrEmpty finds real content during regen.
  writeSpecFile(projectDir, sessionId, SPEC_FILE, '# Spec\n\nFirst draft.\n', null);
  return { projectDir, sessionId, specPath: '/tmp/mock-spec.md' };
}

function prepareState(): WorkflowState {
  let state = createInitialState('test-feature');
  state = transition(state, { type: 'START', feature: 'test-feature' });
  return state;
}

describe('runApprovalLoop', () => {
  it('returns not-rejected when user approves', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const { callbacks } = makeCallbacks({ onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }) });
    const result = await runApprovalLoop({
      type: 'spec',
      filePath: specPath,
      planner: makePlanner(),
      projectDir,
      sessionId,
      callbacks,
      state: prepareState(),
      persistTranscript: false,
    });
    expect(result.rejected).toBe(false);
    expect(result.regenerated).toBe(false);
  });

  it('rejects when user declines without comment — state transitions and spec_rejected event fires', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const { callbacks, events } = makeCallbacks({ onApprovalNeeded: vi.fn().mockResolvedValue({ approved: false }) });
    const result = await runApprovalLoop({
      type: 'spec',
      filePath: specPath,
      planner: makePlanner(),
      projectDir,
      sessionId,
      callbacks,
      state: prepareState(),
      persistTranscript: false,
    });
    expect(result.rejected).toBe(true);
    expect(events.some((e) => e.type === 'planner-status' && e.status === 'done')).toBe(true);
  });

  it('returns not-rejected immediately when AbortSignal is already aborted', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const controller = new AbortController();
    controller.abort();
    const onApprovalNeeded = vi.fn();
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const result = await runApprovalLoop({
      type: 'spec',
      filePath: specPath,
      planner: makePlanner(),
      projectDir,
      sessionId,
      callbacks,
      state: prepareState(),
      persistTranscript: false,
      signal: controller.signal,
    });
    expect(result.rejected).toBe(false);
    expect(onApprovalNeeded).not.toHaveBeenCalled();
  });

  it('does not treat an aborted in-flight approval prompt as rejection', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const controller = new AbortController();
    const onApprovalNeeded = vi.fn().mockImplementationOnce(async () => {
      controller.abort();
      return { approved: false };
    });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const result = await runApprovalLoop({
      type: 'spec',
      filePath: specPath,
      planner: makePlanner(),
      projectDir,
      sessionId,
      callbacks,
      state: prepareState(),
      persistTranscript: false,
      signal: controller.signal,
    });
    expect(result.rejected).toBe(false);
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
  });

  it('regenerate on feedback: planner.regenerate receives prompt containing user comment, loop continues until approval', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const onApprovalNeeded = vi.fn()
      .mockResolvedValueOnce({ approved: false, comment: 'please add auth section' })
      .mockResolvedValueOnce({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const planner = makePlanner();

    const result = await runApprovalLoop({
      type: 'spec',
      filePath: specPath,
      planner,
      projectDir,
      sessionId,
      callbacks,
      state: prepareState(),
      persistTranscript: false,
    });

    expect(result.rejected).toBe(false);
    expect(result.regenerated).toBe(true);
    // Planner regenerate port was exercised with the user's comment in the prompt.
    expect(planner.regenerate).toHaveBeenCalledTimes(1);
    const regenArgs = vi.mocked(planner.regenerate).mock.calls[0];
    expect(regenArgs?.[0]).toContain('please add auth section');
    expect(regenArgs?.[1]).toBe('spec');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
  });
});
