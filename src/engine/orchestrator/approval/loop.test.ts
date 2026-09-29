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
import { PLAN_FILE, SPEC_FILE } from '../../../core/paths.js';
import { runApprovalLoop } from './loop.js';
import { enqueueUserMessage } from '../queue/submit.js';
import type { WorkflowSinks } from '../types.js';
import { createEventBus } from '../../events/bus.js';
import { readRunEvents } from '../../events/replay.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type { RegenerateOptions } from '../../planners/types.js';
import { error } from '../../../utils/error.js';

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

function preparePlanState(): WorkflowState {
  let state = prepareState();
  state = transition(state, { type: 'APPROVE_SPEC' });
  state = transition(state, { type: 'PLAN_DONE', tasks: [] });
  return state;
}

describe('runApprovalLoop', () => {
  it('closes the run when the gate answers end-run — state transitions and spec_rejected event fires', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: false, action: 'end-run' }),
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
    });
    expect(result.closed).toBe(true);
    expect(events.some((e) => e.type === 'spec_rejected')).toBe(true);
    expect(events.some((e) => e.type === 'spec_approved')).toBe(false);
    expect(
      events.some((e) => e.type === 'planner_status' && 'status' in e && e.status === 'done'),
    ).toBe(true);
  });

  it.each([
    { type: 'spec' as const, state: prepareState, phase: 'reviewing-spec' },
    { type: 'plan' as const, state: preparePlanState, phase: 'reviewing-plan' },
  ])(
    'records the $type gate approval in session.jsonl',
    async ({ type, state: makeState, phase }) => {
      const { projectDir, sessionId, specPath } = setupProject();
      const { callbacks } = makeCallbacks({
        onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),
      });
      const bus = createEventBus();
      bus.subscribe(createJsonlSink({ projectDir, sessionId }));

      await runApprovalLoop({
        type,
        filePath: specPath,
        planner: makePlanner(),
        projectDir,
        sessionId,
        callbacks,
        bus,
        state: makeState(),
      });

      const { events } = await readRunEvents({ projectDir, sessionId });
      expect(events.filter((event) => event.type === `${type}_approved`)).toEqual([
        { type: `${type}_approved`, ts: expect.any(Number), phase },
      ]);
    },
  );

  it('records one approval, after the revision the gate approved', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi
        .fn()
        .mockResolvedValueOnce({ approved: false, action: 'revise', comment: 'add auth' })
        .mockResolvedValueOnce({ approved: true }),
    });
    const { bus, events } = makeBusRecorder();

    await runApprovalLoop({
      type: 'spec',
      filePath: specPath,
      planner: makePlanner({
        regenerate: async () => ({ text: '# Spec\n\nWith auth.\n', usage: null }),
      }),
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: prepareState(),
    });

    expect(
      events
        .map((event) => event.type)
        .filter((type) => type === 'spec_regenerated' || type === 'spec_approved'),
    ).toEqual(['spec_regenerated', 'spec_approved']);
  });

  it('records no approval for an answer that arrives after the run was stopped', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const controller = new AbortController();
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: async () => {
        controller.abort();
        return { approved: true as const };
      },
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
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(events.some((e) => e.type === 'spec_approved')).toBe(false);
  });

  it('returns not-closed immediately when AbortSignal is already aborted', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const controller = new AbortController();
    controller.abort();
    let approvalPrompts = 0;
    const onApprovalNeeded = async () => {
      approvalPrompts++;
      return { approved: true as const };
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
      signal: controller.signal,
    });
    expect(result.closed).toBe(false);
    expect(approvalPrompts).toBe(0);
  });

  it('does not close the run when an in-flight approval prompt is aborted', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const controller = new AbortController();
    let approvalPrompts = 0;
    const onApprovalNeeded = async () => {
      approvalPrompts++;
      controller.abort();
      return { approved: false as const };
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
      signal: controller.signal,
    });
    expect(result.closed).toBe(false);
    expect(approvalPrompts).toBe(1);
  });

  it.each([
    {
      type: 'spec' as const,
      state: prepareState,
      phase: 'specifying',
      filename: SPEC_FILE,
      current: '# Spec\n\nFirst draft.\n',
      replacement: '# Spec\n\nRegenerated.\n',
    },
    {
      type: 'plan' as const,
      state: preparePlanState,
      phase: 'planning',
      filename: PLAN_FILE,
      current: '# Plan\n\nFirst draft.\n',
      replacement: '# Plan\n\nRegenerated.\n',
    },
  ])(
    'regenerates $type on feedback and associates both planner statuses with its call',
    async ({ type, state: makeState, phase, filename, current, replacement }) => {
      const { projectDir, sessionId, specPath } = setupProject();
      writeSpecFile({ projectDir, sessionId }, filename, current, null);
      const approvalPrompts = [
        { approved: false, action: 'revise', comment: 'please add auth section' },
        { approved: true },
      ] as const;
      let approvalCalls = 0;
      const onApprovalNeeded = async () => {
        const next = approvalPrompts[approvalCalls++];
        if (!next) throw new Error('unexpected extra approval prompt');
        return next;
      };
      const { callbacks } = makeCallbacks({ onApprovalNeeded });
      const { bus, events } = makeBusRecorder();

      const regenCalls: string[] = [];
      const planner = makePlanner({
        regenerate: async (opts) => {
          regenCalls.push(opts.prompt);
          return { text: replacement, usage: null };
        },
      });

      const result = await runApprovalLoop({
        type,
        filePath: specPath,
        planner,
        projectDir,
        sessionId,
        callbacks,
        bus,
        state: makeState(),
      });

      expect(result.closed).toBe(false);
      expect(result.regenerated).toBe(true);
      expect(regenCalls).toHaveLength(1);
      expect(regenCalls[0]).toContain('please add auth section');
      expect(regenCalls[0]).toContain(type);
      expect(approvalCalls).toBe(2);
      expect(
        events.flatMap((event) =>
          event.type === 'planner_status'
            ? [{ phase: event.phase, status: event.status, call: event.call }]
            : [],
        ),
      ).toEqual([
        { phase, status: 'running', call: type },
        { phase, status: 'done', call: type },
      ]);
      expect(
        readFileSync(join(projectDir, '.splitbrief', 'sessions', sessionId, filename), 'utf8'),
      ).toBe(replacement);
      expect(events.filter((event) => event.type === `${type}_regenerated`)).toHaveLength(1);
      expect(events.filter((event) => event.type === `${type}_approved`)).toHaveLength(1);
    },
  );

  it.each([
    { type: 'spec' as const, outcome: 'fails' as const },
    { type: 'plan' as const, outcome: 'fails' as const },
    { type: 'spec' as const, outcome: 'is cancelled' as const },
    { type: 'plan' as const, outcome: 'is cancelled' as const },
  ])(
    'associates $type regeneration start and completion with the call when it $outcome',
    async ({ type, outcome }) => {
      const { projectDir, sessionId, specPath } = setupProject();
      const filename = type === 'spec' ? SPEC_FILE : PLAN_FILE;
      const phase = type === 'spec' ? 'specifying' : 'planning';
      const state = type === 'spec' ? prepareState() : preparePlanState();
      const current = type === 'spec' ? '# Spec\n\nFirst draft.\n' : '# Plan\n\nFirst draft.\n';
      writeSpecFile({ projectDir, sessionId }, filename, current, null);
      const artifactPath = join(projectDir, '.splitbrief', 'sessions', sessionId, filename);
      const before = readFileSync(artifactPath);
      const controller = new AbortController();
      const onApprovalNeeded = vi.fn().mockResolvedValue({
        approved: false,
        action: 'revise',
        comment: 'make one replacement',
      });
      const { callbacks } = makeCallbacks({ onApprovalNeeded });
      const planner = makePlanner({
        regenerate: vi.fn(async ({ callbacks: plannerCallbacks }) => {
          if (outcome === 'is cancelled') {
            await new Promise<never>((_resolve, reject) => {
              plannerCallbacks.signal?.addEventListener(
                'abort',
                () => reject(new Error('planner call cancelled')),
                { once: true },
              );
              controller.abort();
            });
          }
          throw new Error('planner call failed');
        }),
      });
      const { bus, events } = makeBusRecorder();
      const run = runApprovalLoop({
        type,
        filePath: specPath,
        planner,
        projectDir,
        sessionId,
        callbacks,
        bus,
        state,
        ...(outcome === 'is cancelled' ? { signal: controller.signal } : {}),
      });

      if (outcome === 'is cancelled') {
        await expect(run).resolves.toMatchObject({
          closed: false,
          regenerated: false,
          aborted: true,
        });
      } else {
        await expect(run).rejects.toThrow('planner call failed');
      }

      expect(planner.regenerate).toHaveBeenCalledTimes(1);
      expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
      expect(readFileSync(artifactPath)).toEqual(before);
      expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
      expect(events.filter((event) => event.type === `${type}_regenerated`)).toHaveLength(0);
      expect(events.filter((event) => event.type === `${type}_approved`)).toHaveLength(0);
      expect(
        events.flatMap((event) =>
          event.type === 'planner_status'
            ? [{ phase: event.phase, status: event.status, call: event.call }]
            : [],
        ),
      ).toEqual([
        { phase, status: 'running', call: type },
        { phase, status: 'done', call: type },
      ]);
    },
  );

  it.each([
    {
      type: 'spec' as const,
      filename: SPEC_FILE,
      state: prepareState,
      current: '# Spec\n\nApproved spec.\n',
    },
    {
      type: 'plan' as const,
      filename: PLAN_FILE,
      state: preparePlanState,
      current: '# Plan\n\nApproved plan.\n',
    },
  ])(
    'rejects invalid $type feedback replacement without changing the approved artifact or publishing events',
    async ({ type, filename, state: makeState, current }) => {
      const { projectDir, sessionId, specPath } = setupProject();
      writeSpecFile({ projectDir, sessionId }, filename, current, null);
      const artifactPath = join(projectDir, '.splitbrief', 'sessions', sessionId, filename);
      const before = readFileSync(artifactPath);
      const { callbacks } = makeCallbacks({
        onApprovalNeeded: vi.fn().mockResolvedValue({
          approved: false,
          action: 'revise',
          comment: 'replace with malformed output',
        }),
      });
      const { bus, events } = makeBusRecorder();
      const planner = makePlanner({
        regenerate: async () => ({ text: 'planner prose without a heading', usage: null }),
      });

      await expect(
        runApprovalLoop({
          type,
          filePath: specPath,
          planner,
          projectDir,
          sessionId,
          callbacks,
          bus,
          state: makeState(),
        }),
      ).rejects.toMatchObject({
        kind: 'planning-invalid-artifact',
        data: { phase: type === 'spec' ? 'specifying' : 'planning', filename },
      });

      expect(readFileSync(artifactPath)).toEqual(before);
      expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(0);
      expect(events.filter((event) => event.type === `${type}_regenerated`)).toHaveLength(0);
      expect(
        events.some((event) => event.type === 'planner_status' && event.status === 'done'),
      ).toBe(true);
    },
  );

  it.each([
    {
      type: 'spec' as const,
      filename: SPEC_FILE,
      state: prepareState,
      current: '# Spec\n\nApproved spec.\n',
      replacement: '# Spec\n\nReplacement spec.\n',
    },
    {
      type: 'plan' as const,
      filename: PLAN_FILE,
      state: preparePlanState,
      current: '# Plan\n\nApproved plan.\n',
      replacement: '# Plan\n\nReplacement plan.\n',
    },
  ])(
    'persists and publishes a valid $type feedback replacement exactly once',
    async ({ type, filename, state: makeState, current, replacement }) => {
      const { projectDir, sessionId, specPath } = setupProject();
      writeSpecFile({ projectDir, sessionId }, filename, current, null);
      const { callbacks } = makeCallbacks({
        onApprovalNeeded: vi
          .fn()
          .mockResolvedValueOnce({
            approved: false,
            action: 'revise',
            comment: 'make a valid replacement',
          })
          .mockResolvedValueOnce({ approved: true }),
      });
      const { bus, events } = makeBusRecorder();
      const planner = makePlanner({
        regenerate: async () => ({ text: replacement, usage: null }),
      });

      const result = await runApprovalLoop({
        type,
        filePath: specPath,
        planner,
        projectDir,
        sessionId,
        callbacks,
        bus,
        state: makeState(),
      });

      expect(result.regenerated).toBe(true);
      expect(
        readFileSync(join(projectDir, '.splitbrief', 'sessions', sessionId, filename), 'utf8'),
      ).toBe(replacement);
      expect(events.filter((event) => event.type === 'artifact_written')).toHaveLength(1);
      expect(events.filter((event) => event.type === `${type}_regenerated`)).toHaveLength(1);
    },
  );

  it('applies pending queued planner input before showing the approval prompt', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const { bus, events } = makeBusRecorder();
    const queued = enqueueUserMessage({
      projectDir,
      sessionId,
      state: prepareState(),
      text: 'keep this brief-only and do not write spec.md',
      phase: 'researching',
      bus,
    });
    const onApprovalNeeded = vi.fn().mockResolvedValue({ approved: true });
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const regenCalls: string[] = [];
    const planner = makePlanner({
      regenerate: async (opts) => {
        regenCalls.push(opts.prompt);
        return { text: '# Spec\n\nRegenerated from queued input.\n', usage: null };
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
      state: queued.state,
    });

    expect(result.closed).toBe(false);
    expect(result.regenerated).toBe(true);
    expect(regenCalls).toHaveLength(1);
    expect(regenCalls[0]).toContain('keep this brief-only');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'queue_drained' && e.count === 1)).toBe(true);
    expect(
      events.flatMap((event) =>
        event.type === 'planner_status'
          ? [{ phase: event.phase, status: event.status, call: event.call }]
          : [],
      ),
    ).toEqual([
      { phase: 'specifying', status: 'running', call: 'spec' },
      { phase: 'specifying', status: 'done', call: 'spec' },
    ]);
    expect(
      events.some(
        (e) =>
          e.type === 'spec_regenerated' &&
          'comment' in e &&
          e.comment === '(queued input before spec review)',
      ),
    ).toBe(true);
  });

  it('regenerated spec reaches the transcript as an artifact card, not as a body paste', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const document = `# Spec\n\n${Array.from({ length: 30 }, (_, i) => `Requirement ${i + 1}.`).join('\n\n')}\n`;
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi
        .fn()
        .mockResolvedValueOnce({ approved: false, action: 'revise', comment: 'add auth' })
        .mockResolvedValueOnce({ approved: true }),
    });
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      regenerate: async (opts) => {
        opts.callbacks?.onOutput?.(document);
        return { text: document, usage: null };
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
    });

    expect(events.some((e) => e.type === 'planner_text' && e.text.includes('Requirement 1.'))).toBe(
      false,
    );
    expect(events.filter((e) => e.type === 'artifact_written')).toEqual([
      {
        type: 'artifact_written',
        ts: expect.any(Number),
        phase: 'reviewing-spec',
        filename: SPEC_FILE,
        path: join(projectDir, '.splitbrief', 'sessions', sessionId, SPEC_FILE),
        lineCount: 61,
        excerpt: [
          'Requirement 1.',
          '',
          'Requirement 2.',
          '',
          'Requirement 3.',
          '',
          'Requirement 4.',
          '',
          'Requirement 5.',
        ],
        omittedCount: 52,
        omittedUnit: 'line',
      },
    ]);
  });

  it("regenerates a revised spec with the run's skills context", async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi
        .fn()
        .mockResolvedValueOnce({ approved: false, action: 'revise', comment: 'add auth' })
        .mockResolvedValueOnce({ approved: true }),
    });
    const prompts: string[] = [];
    const planner = makePlanner({
      regenerate: async (opts) => {
        prompts.push(opts.prompt);
        return { text: '# Spec\n\nRevised.\n', usage: null };
      },
    });
    const skillsContext = '## Active Project Skills\n\n### AuthSkill\nREGEN-SKILL-BODY';

    await runApprovalLoop({
      type: 'spec',
      filePath: specPath,
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus: makeBusRecorder().bus,
      state: prepareState(),
      skillsContext,
    });

    expect(prompts).toEqual([expect.stringContaining(skillsContext)]);
  });

  it('keeps the planner thread a revision reports and drops one it finds expired', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const ref = { projectDir, sessionId };
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi
        .fn()
        .mockResolvedValueOnce({ approved: false, action: 'revise', comment: 'add auth' })
        .mockResolvedValueOnce({ approved: false, action: 'revise', comment: 'add audit' }),
    });
    const planner = makePlanner({
      regenerate: vi
        .fn()
        .mockImplementationOnce(async ({ callbacks: thread }: RegenerateOptions) => {
          thread.onSessionId?.('thread-2');
          return { text: '# Spec\n\nRevised.\n', usage: null };
        })
        .mockImplementationOnce(async ({ callbacks: thread }: RegenerateOptions) => {
          thread.onSessionExpired?.('thread-2');
          throw error('session-resume-expired', 'could not resume session thread-2');
        }),
    });
    const state = { ...prepareState(), plannerSessionId: 'thread-1' };
    saveState(ref, state);

    await expect(
      runApprovalLoop({
        type: 'spec',
        filePath: specPath,
        planner,
        projectDir,
        sessionId,
        callbacks,
        bus: makeBusRecorder().bus,
        state,
      }),
    ).rejects.toMatchObject({ kind: 'session-resume-expired' });
    expect(loadState(ref)?.plannerSessionId).toBeNull();
  });

  it('spec gate: editing spec.md on disk then approving triggers regeneration', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const onApprovalNeeded = async () => {
      writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nEdited by user.\n', null);
      return { approved: true as const };
    };
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
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
    });

    expect(result.closed).toBe(false);
    expect(result.regenerated).toBe(true);
    expect(events.some((e) => e.type === 'spec_regenerated')).toBe(true);
  });

  it('spec gate: approving without an on-disk edit does not regenerate', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true as const }),
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
    });

    expect(result.closed).toBe(false);
    expect(result.regenerated).toBe(false);
    expect(events.some((e) => e.type === 'spec_regenerated')).toBe(false);
  });

  it('plan gate: editing plan.md on disk then approving triggers regeneration', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan\n\nFirst draft.\n', null);
    const onApprovalNeeded = async () => {
      writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan\n\nEdited by user.\n', null);
      return { approved: true as const };
    };
    const { callbacks } = makeCallbacks({ onApprovalNeeded });
    const { bus, events } = makeBusRecorder();

    const result = await runApprovalLoop({
      type: 'plan',
      filePath: specPath,
      planner: makePlanner(),
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: preparePlanState(),
    });

    expect(result.closed).toBe(false);
    expect(result.regenerated).toBe(true);
    expect(events.some((e) => e.type === 'plan_regenerated')).toBe(true);
  });

  it('wires live regeneration to the workflow abort handler', async () => {
    const { projectDir, sessionId, specPath } = setupProject();
    const workflowSignal = new AbortController().signal;
    const installedHandlers: (() => void)[] = [];
    const sinks = {
      setAbortHandler: (handler) => {
        if (handler) installedHandlers.push(handler);
      },
      setQueueHandler: () => {},
    } satisfies WorkflowSinks;
    const { callbacks } = makeCallbacks({
      onApprovalNeeded: vi
        .fn()
        .mockResolvedValueOnce({ approved: false, action: 'revise', comment: 'revise' }),
    });
    const { bus } = makeBusRecorder();
    let regenLive = false;
    const planner = makePlanner({
      regenerate: async (opts) => {
        regenLive = true;
        await new Promise<void>((resolve) => {
          const signal = opts.callbacks.signal;
          if (!signal) {
            resolve();
            return;
          }
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        expect(opts.callbacks.signal?.aborted).toBe(true);
        throw new DOMException('The operation was aborted', 'AbortError');
      },
    });

    const loopPromise = runApprovalLoop({
      type: 'spec',
      filePath: specPath,
      planner,
      projectDir,
      sessionId,
      callbacks,
      bus,
      state: prepareState(),
      signal: workflowSignal,
      sinks,
    });

    await vi.waitFor(() => {
      expect(regenLive).toBe(true);
    });
    expect(installedHandlers).toHaveLength(1);
    installedHandlers[0]?.();
    const result = await loopPromise;

    expect(result.aborted).toBe(true);
    expect(result.closed).toBe(false);
    const onDisk = readFileSync(
      join(projectDir, '.splitbrief', 'sessions', sessionId, SPEC_FILE),
      'utf8',
    );
    expect(onDisk).toContain('First draft.');
  });
});
