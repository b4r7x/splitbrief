import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeCallbacks,
  makePlanner,
  makeBusRecorder,
} from '#testing/helpers/orchestrator-factories.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSessionDir, writeSpecFile } from '../../../core/paths-io.js';
import { SPEC_FILE } from '../../../core/paths.js';
import { runApprovalLoop } from './loop.js';

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
  writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nFirst draft.\n', null);
  return { projectDir, sessionId, specPath: '/tmp/mock-spec.md' };
}

function prepareState(): WorkflowState {
  let state = createInitialState('test-feature');
  state = transition(state, { type: 'START' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  return state;
}

describe('runApprovalLoop', () => {
  it('returns not-rejected when user approves', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),
    });
    const { bus } = makeBusRecorder();
    const result = await runApprovalLoop({
      type: 'spec',
      filePath: specPath,
      planner: makePlanner(),
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: prepareState(),
      persistTranscript: false,
    });
    expect(result.rejected).toBe(false);
    expect(result.regenerated).toBe(false);
  });

  it('rejects when user declines without comment — state transitions and spec_rejected event fires', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: false }),
    });
    const { bus, events } = makeBusRecorder();
    const result = await runApprovalLoop({
      type: 'spec',
      filePath: specPath,
      planner: makePlanner(),
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: prepareState(),
      persistTranscript: false,
    });
    expect(result.rejected).toBe(true);
    expect(
      events.some((e) => e.type === 'planner_status' && 'status' in e && e.status === 'done'),
    ).toBe(true);
  });

  it('returns not-rejected immediately when AbortSignal is already aborted', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const controller = new AbortController();
    controller.abort();
    let approvalPrompts = 0;
    const onApprovalNeeded = async () => {
      approvalPrompts++;
      return { approved: true };
    };
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const result = await runApprovalLoop({
      type: 'spec',
      filePath: specPath,
      planner: makePlanner(),
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: prepareState(),
      persistTranscript: false,
      signal: controller.signal,
    });
    expect(result.rejected).toBe(false);
    expect(approvalPrompts).toBe(0);
  });

  it('does not treat an aborted in-flight approval prompt as rejection', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const controller = new AbortController();
    let approvalPrompts = 0;
    const onApprovalNeeded = async () => {
      approvalPrompts++;
      controller.abort();
      return { approved: false };
    };
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();
    const result = await runApprovalLoop({
      type: 'spec',
      filePath: specPath,
      planner: makePlanner(),
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: prepareState(),
      persistTranscript: false,
      signal: controller.signal,
    });
    expect(result.rejected).toBe(false);
    expect(approvalPrompts).toBe(1);
  });

  it('regenerate on feedback: planner.regenerate receives prompt containing user comment, loop continues until approval', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const approvalPrompts: Array<{ approved: boolean; comment?: string }> = [
      { approved: false, comment: 'please add auth section' },
      { approved: true },
    ];
    let approvalCalls = 0;
    const onApprovalNeeded = async () => {
      const next = approvalPrompts[approvalCalls++];
      if (!next) throw new Error('unexpected extra approval prompt');
      return next;
    };
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus } = makeBusRecorder();

    const regenCalls: string[] = [];
    const planner = makePlanner({
      regenerate: async (opts) => {
        regenCalls.push(opts.prompt);
        return { text: 'regenerated', usage: null };
      },
    });

    const result = await runApprovalLoop({
      type: 'spec',
      filePath: specPath,
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: prepareState(),
      persistTranscript: false,
    });

    expect(result.rejected).toBe(false);
    expect(result.regenerated).toBe(true);
    expect(regenCalls).toHaveLength(1);
    expect(regenCalls[0]).toContain('please add auth section');
    expect(regenCalls[0]).toContain('spec');
    expect(approvalCalls).toBe(2);
  });

  it('writes regenerated spec text to disk before downstream planning reads it', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi
        .fn()
        .mockResolvedValueOnce({ approved: false, comment: 'add auth' })
        .mockResolvedValueOnce({ approved: true }),
    });
    const { bus } = makeBusRecorder();
    const planner = makePlanner({
      regenerate: async () => ({ text: '# Spec\n\nWith auth.\n', usage: null }),
    });

    await runApprovalLoop({
      type: 'spec',
      filePath: specPath,
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: prepareState(),
      persistTranscript: false,
    });

    const onDisk = readFileSync(
      join(projectDir, '.diptych', 'sessions', sessionId, SPEC_FILE),
      'utf8',
    );
    expect(onDisk).toContain('With auth.');
  });

  it('passes the abort signal into planner regeneration callbacks', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const controller = new AbortController();
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi
        .fn()
        .mockResolvedValueOnce({ approved: false, comment: 'revise' })
        .mockResolvedValueOnce({ approved: true }),
    });
    const { bus } = makeBusRecorder();
    let capturedSignal: AbortSignal | undefined;
    const planner = makePlanner({
      regenerate: async (opts) => {
        capturedSignal = opts.callbacks.signal;
        return { text: 'regenerated', usage: null };
      },
    });

    await runApprovalLoop({
      type: 'spec',
      filePath: specPath,
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: prepareState(),
      persistTranscript: false,
      signal: controller.signal,
    });

    expect(capturedSignal).toBe(controller.signal);
  });
});
