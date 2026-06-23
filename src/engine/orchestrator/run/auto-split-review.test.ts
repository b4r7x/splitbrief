import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { formatTasks } from '../../spec/formatter.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { reviewAutoSplitOutput } from './auto-split-review.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
  vi.restoreAllMocks();
});

function makePassingTask(overrides?: Parameters<typeof makeTask>[0]) {
  return makeTask({
    implementationSteps: ['Implement the parser branch'],
    tests: ['parser handles the accepted branch'],
    scope: { inBounds: ['src/parser.ts'] },
    evidence: ['Parser-focused test passes'],
    ...overrides,
  });
}

const malformedTaskLikeBlock = `---
id: T002
title:
action: invalid
file:
depends_on: []
---

### Description
This block looks like a task but has invalid frontmatter.
`;

describe('reviewAutoSplitOutput', () => {
  it('approves when refreshed readiness passes', async () => {
    const projectDir = createTempDir('auto-split-review-test');
    dirs.push(projectDir);
    const sessionId = 'sess-auto-split-ready';
    const task = makePassingTask({ id: 'T001', file: 'src/parser.ts' });
    const state = makeImplState([task]);
    const { bus } = makeBusRecorder();
    const onApprovalNeeded = vi.fn(async () => ({ approved: true as const }));
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const setTrackedState = vi.fn();

    const result = await reviewAutoSplitOutput({
      wctx: makeWctx({ projectDir, sessionId, bus, callbacks }),
      state,
      tasks: [task],
      setTrackedState,
    });

    expect(onApprovalNeeded).toHaveBeenCalledOnce();
    expect(result.approved).toBe(true);
    expect(result.state.phase).toBe('implementing');
  });

  it('re-prompts after a malformed tasks.md, then adopts a corrected file', async () => {
    const projectDir = createTempDir('auto-split-review-test');
    dirs.push(projectDir);
    const sessionId = 'sess-auto-split';
    const task = makePassingTask({ id: 'T001', file: 'src/parser.ts' });
    const fixedTask = makePassingTask({ id: 'T010', file: 'src/parser.ts', title: 'Corrected' });
    const state = makeImplState([task]);
    const { bus, events } = makeBusRecorder();
    const onApprovalNeeded = vi.fn(async (_type: 'spec' | 'plan' | 'briefs', filePath: string) => {
      if (onApprovalNeeded.mock.calls.length === 1) {
        await writeFile(filePath, `${formatTasks([task])}\n${malformedTaskLikeBlock}`, 'utf8');
      } else {
        await writeFile(filePath, formatTasks([fixedTask]), 'utf8');
      }
      return { approved: true as const };
    });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const setTrackedState = vi.fn();

    const result = await reviewAutoSplitOutput({
      wctx: makeWctx({ projectDir, sessionId, bus, callbacks }),
      state,
      tasks: [task],
      setTrackedState,
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(result.approved).toBe(true);
    expect(result.state.phase).toBe('implementing');
    expect(result.tasks.map((t) => t.id)).toEqual(['T010']);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('invalid Task Briefs'),
      }),
    );
  });

  it('re-prompts after an edit instead of approving on the first edit', async () => {
    const projectDir = createTempDir('auto-split-review-test');
    dirs.push(projectDir);
    const sessionId = 'sess-auto-split-edit';
    const task = makePassingTask({ id: 'T001', file: 'src/parser.ts' });
    const editedTask = makePassingTask({ id: 'T020', file: 'src/parser.ts', title: 'Edited' });
    const state = makeImplState([task]);
    const { bus } = makeBusRecorder();
    const onApprovalNeeded = vi.fn(async (_type: 'spec' | 'plan' | 'briefs', filePath: string) => {
      if (onApprovalNeeded.mock.calls.length === 1) {
        await writeFile(filePath, formatTasks([editedTask]), 'utf8');
        return { approved: false as const, action: 'edit' as const };
      }
      return { approved: true as const };
    });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const setTrackedState = vi.fn();

    const result = await reviewAutoSplitOutput({
      wctx: makeWctx({ projectDir, sessionId, bus, callbacks }),
      state,
      tasks: [task],
      setTrackedState,
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(result.approved).toBe(true);
    expect(result.state.phase).toBe('implementing');
    expect(result.tasks.map((t) => t.id)).toEqual(['T020']);
  });

  it('regenerates from revise feedback instead of rejecting auto-split briefs', async () => {
    const projectDir = createTempDir('auto-split-review-test');
    dirs.push(projectDir);
    const sessionId = 'sess-auto-split-revise';
    const task = makePassingTask({ id: 'T001', file: 'src/parser.ts' });
    const regeneratedTask = makePassingTask({
      id: 'T030',
      file: 'src/parser.ts',
      title: 'Regenerated',
    });
    const state = makeImplState([task]);
    const { bus } = makeBusRecorder();
    const onApprovalNeeded = vi
      .fn()
      .mockResolvedValueOnce({
        approved: false as const,
        action: 'revise' as const,
        comment: 'keep only the parser branch and add concrete evidence',
      })
      .mockResolvedValueOnce({ approved: true as const });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const planner = makePlanner({
      review: vi.fn(async () => ({ text: formatTasks([regeneratedTask]), usage: null })),
    });
    const setTrackedState = vi.fn();

    const result = await reviewAutoSplitOutput({
      wctx: makeWctx({ projectDir, sessionId, bus, callbacks, planner }),
      state,
      tasks: [task],
      setTrackedState,
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(planner.review).toHaveBeenCalledOnce();
    expect(planner.review).toHaveBeenCalledWith(
      expect.stringContaining('keep only the parser branch and add concrete evidence'),
      projectDir,
      expect.any(Object),
    );
    expect(result.approved).toBe(true);
    expect(result.state.phase).toBe('implementing');
    expect(result.tasks.map((t) => t.id)).toEqual(['T030']);
    expect(setTrackedState.mock.calls.some(([nextState]) => nextState.phase === 'idle')).toBe(
      false,
    );
  });

  it('rejects into a resumable state when the reviewer quits', async () => {
    const projectDir = createTempDir('auto-split-review-test');
    dirs.push(projectDir);
    const sessionId = 'sess-auto-split-reject';
    const task = makePassingTask({ id: 'T001', file: 'src/parser.ts' });
    const state = makeImplState([task]);
    const { bus, events } = makeBusRecorder();
    const onApprovalNeeded = vi.fn(async () => ({ approved: false as const }));
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const setTrackedState = vi.fn();

    const result = await reviewAutoSplitOutput({
      wctx: makeWctx({ projectDir, sessionId, bus, callbacks }),
      state,
      tasks: [task],
      setTrackedState,
    });

    expect(onApprovalNeeded).toHaveBeenCalledOnce();
    expect(result.approved).toBe(false);
    expect(result.state.phase).toBe('idle');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('rejected'),
      }),
    );
  });

  it('blocks approval when refreshed readiness reports overflow', async () => {
    const projectDir = createTempDir('auto-split-review-test');
    dirs.push(projectDir);
    const sessionId = 'sess-auto-split-overflow';
    const task = makePassingTask({
      id: 'T001',
      file: 'src/parser.ts',
      description: 'Create an intentionally large split task',
      implementationSteps: [
        Array.from({ length: 300 }, (_, index) => `implementation detail ${index}`).join(' '),
      ],
    });
    const state = makeImplState([task]);
    const { bus, events } = makeBusRecorder();
    const onApprovalNeeded = vi
      .fn()
      .mockResolvedValueOnce({ approved: true as const })
      .mockResolvedValueOnce({ approved: false as const });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const setTrackedState = vi.fn();

    const result = await reviewAutoSplitOutput({
      wctx: makeWctx({
        projectDir,
        sessionId,
        bus,
        callbacks,
        config: makeConfig({ implementer: { contextLength: 200 } }),
      }),
      state,
      tasks: [task],
      setTrackedState,
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(result.approved).toBe(false);
    expect(result.state.phase).toBe('idle');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('Task Brief approval blocked'),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('Next best action'),
      }),
    );
  });

  it('blocks approval when refreshed readiness reports no capable worker', async () => {
    const projectDir = createTempDir('auto-split-review-test');
    dirs.push(projectDir);
    const sessionId = 'sess-auto-split-no-worker';
    const task = makePassingTask({
      id: 'T001',
      file: 'src/parser.ts',
      scope: { inBounds: ['src/parser.ts', 'src/sidecar.ts'] },
    });
    const state = makeImplState([task]);
    const { bus, events } = makeBusRecorder();
    const onApprovalNeeded = vi
      .fn()
      .mockResolvedValueOnce({ approved: true as const })
      .mockResolvedValueOnce({ approved: false as const });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const setTrackedState = vi.fn();

    const result = await reviewAutoSplitOutput({
      wctx: makeWctx({ projectDir, sessionId, bus, callbacks }),
      state,
      tasks: [task],
      setTrackedState,
    });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(result.approved).toBe(false);
    expect(result.state.phase).toBe('idle');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        message: expect.stringContaining('has no capable worker'),
      }),
    );
  });
});
