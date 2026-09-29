import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePhaseCallResult } from '#testing/helpers/factories/phase-call.js';
import { makePassingTask } from '#testing/helpers/planning-phase.js';
import { makeCallbacks, makePlanner, makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { sessionDir } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { OrchestratorCallbacks } from '../types.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import { readMessages } from '../../../core/sessions/log-reader.js';
import { createEventBus } from '../../events/bus.js';
import type { EngineEvent } from '../../events/types.js';
import { formatTasks } from '../../spec/formatter.js';
import { createContinuationHolder } from '../continuation.js';
import { resumeParkedApproval } from './resume-parked-approval.js';

const CORRECTION = 'Use the cached parser and cover invalid input';
let projectDir = '';
afterEach(() => cleanupTempDir(projectDir));

function setup(gate: 'spec' | 'plan' | 'briefs', steer: string | undefined = CORRECTION) {
  projectDir = createTempDir('parked-gate-correction');
  const sessionId = 'correction';
  const ref = { projectDir, sessionId };
  ensureSessionDir(projectDir, sessionId);
  const dir = sessionDir(projectDir, sessionId);
  const tasks = [makePassingTask()];
  for (const filename of ['research.md', 'spec.md', 'plan.md']) {
    writeFileSync(join(dir, filename), '# Existing artifact\n\nKeep the original requirement.\n');
  }
  writeFileSync(join(dir, 'tasks.md'), formatTasks(tasks));
  const phase =
    gate === 'spec' ? 'reviewing-spec' : gate === 'plan' ? 'reviewing-plan' : 'reviewing-briefs';
  const state: WorkflowState = {
    ...createInitialState('add parsing'),
    phase,
    mode: 'standard',
    approve: 'all',
    tasks,
  };
  if (steer?.trim()) appendMessage(ref, { role: 'user', phase, text: steer.trim() });
  const continuation = createContinuationHolder({ step: { kind: 'gate', gate }, steer });
  const revised =
    gate === 'briefs'
      ? formatTasks([
          { ...makePassingTask(), title: 'Use the cached parser', description: CORRECTION },
        ])
      : `# Revised ${gate}\n\n${CORRECTION}\n`;
  const prompts: string[] = [];
  const revise = async (prompt: string) => {
    prompts.push(prompt);
    return { text: revised, usage: null };
  };
  const planner = makePlanner({ regenerate: ({ prompt }) => revise(prompt), review: revise });
  const events: EngineEvent[] = [];
  const bus = createEventBus();
  bus.subscribe((event) => events.push(event));
  const onApprovalNeeded = vi.fn<OrchestratorCallbacks['onApprovalNeeded']>(async () => ({
    approved: false,
    action: 'end-run',
  }));
  const wctx = makeWctx({
    ...ref,
    config: makeConfig({ workflow: { mode: 'standard', approve: 'all' } }),
    planner,
    callbacks: makeCallbacks({ onApprovalNeeded }).callbacks,
    bus,
    continuation,
  });
  const run = () =>
    resumeParkedApproval({
      wctx,
      state,
      setTrackedState: () => {},
      phaseTimings: {},
      startTime: Date.now(),
    });
  return { ref, dir, state, wctx, run, revised, prompts, onApprovalNeeded, events, continuation };
}

it.each(['spec', 'plan', 'briefs'] as const)(
  'applies a parked %s correction before reopening its prompt and records it once',
  async (gate) => {
    const fixture = setup(gate);
    await fixture.run();
    expect(fixture.prompts).toHaveLength(1);
    expect(fixture.prompts[0]).toContain(CORRECTION);
    expect(
      readFileSync(join(fixture.dir, gate === 'briefs' ? 'tasks.md' : `${gate}.md`), 'utf8'),
    ).toContain('cached parser');
    expect(fixture.onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(fixture.onApprovalNeeded.mock.calls[0]?.[0]).toBe(gate);
    expect(fixture.continuation.take({ kind: 'gate', gate })).toBeUndefined();
    const messages = [];
    for await (const message of readMessages(fixture.ref)) messages.push(message);
    expect(
      messages.filter((message) => message.role === 'user').map((message) => message.text),
    ).toEqual([CORRECTION]);
  },
);

it.each([undefined, '', '   '])(
  'a bare continuation reopens the gate without regeneration (%s)',
  async (steer) => {
    const fixture = setup('spec', '');
    fixture.wctx.continuation = createContinuationHolder({
      step: { kind: 'gate', gate: 'spec' },
      steer,
    });
    await fixture.run();
    expect(fixture.prompts).toEqual([]);
    expect(fixture.onApprovalNeeded).toHaveBeenCalledTimes(1);
  },
);

it('consumes the correction once, then records a later live revision normally', async () => {
  const fixture = setup('spec');
  fixture.onApprovalNeeded.mockResolvedValueOnce({
    approved: false,
    action: 'revise',
    comment: 'Also cover blank input',
  });
  await fixture.run();
  expect(fixture.prompts).toHaveLength(2);
  expect(fixture.prompts[0]).toContain(CORRECTION);
  expect(fixture.prompts[1]).toContain('Also cover blank input');
  const messages = [];
  for await (const message of readMessages(fixture.ref)) messages.push(message);
  expect(
    messages.filter((message) => message.role === 'user').map((message) => message.text),
  ).toEqual([CORRECTION, 'Also cover blank input']);
});

it('does not consume a correction owned by another step', async () => {
  const fixture = setup('spec', '');
  fixture.wctx.continuation = createContinuationHolder({
    step: { kind: 'gate', gate: 'briefs' },
    steer: CORRECTION,
  });
  await fixture.run();
  expect(fixture.prompts).toEqual([]);
  expect(fixture.wctx.continuation.take({ kind: 'gate', gate: 'briefs' })).toEqual({
    steer: CORRECTION,
  });
});

it('warns when the current approval level skips the corrected gate', async () => {
  const fixture = setup('plan');
  fixture.wctx.config = makeConfig({ workflow: { mode: 'standard', approve: 'spec' } });
  await fixture.run();
  expect(fixture.prompts).toEqual([]);
  expect(fixture.events).toContainEqual(
    expect.objectContaining({
      type: 'warning',
      message:
        "Your correction was not applied: the plan gate no longer opens at this run's approval level.",
    }),
  );
  expect(fixture.onApprovalNeeded.mock.calls.map(([gate]) => gate)).toEqual(['briefs']);
});

it.each([
  ['standard', 'spec'],
  ['standard', 'plan'],
  ['standard', 'briefs'],
  ['speckit', 'spec'],
  ['speckit', 'plan'],
] as const)(
  'keeps the corrected %s %s effective after its reopened gate stops again',
  async (mode, gate) => {
    const fixture = setup(gate);
    fixture.state.mode = mode;
    fixture.wctx.config = makeConfig({ workflow: { mode, approve: 'all' } });
    if (mode === 'speckit') {
      for (const file of ['clarifications.md', 'constitution-check.json', 'analyze.json']) {
        writeFileSync(join(fixture.dir, file), '# Previous check\n');
      }
    }
    const upstream = gate === 'spec' ? ['research.md'] : ['research.md', 'spec.md'];
    if (gate === 'briefs') upstream.push('plan.md');
    const original = upstream.map((file) => readFileSync(join(fixture.dir, file)));
    const controller = new AbortController();
    fixture.wctx.signal = controller.signal;
    saveState(fixture.ref, fixture.state);
    fixture.onApprovalNeeded.mockImplementationOnce(async () => {
      controller.abort();
      return { approved: false };
    });

    expect(await fixture.run()).toMatchObject({
      disposition: 'terminal',
      outcome: 'cancelled',
    });
    const correctedFile = gate === 'briefs' ? 'tasks.md' : `${gate}.md`;
    const corrected = readFileSync(join(fixture.dir, correctedFile));
    expect(corrected.toString()).toContain('cached parser');
    const saved = loadState(fixture.ref);
    if (saved === null) throw new Error('Missing saved state');
    const expectedTitle = gate === 'briefs' ? 'Use the cached parser' : 'Compile corrected briefs';
    const tasks = [{ ...makePassingTask(), title: expectedTitle }];
    const runPhase = vi.fn(async ({ call }: Parameters<typeof fixture.wctx.planner.runPhase>[0]) =>
      makePhaseCallResult({ call, ...(call === 'tasks' ? { tasks } : {}) }),
    );
    const review = vi.fn(async () => ({
      text: JSON.stringify({ specTaskCoverage: 1, planTaskCoverage: 1 }),
      usage: null,
    }));
    const planner = makePlanner({ runPhase, review });
    const gates: string[] = [];
    const result = await resumeParkedApproval({
      wctx: makeWctx({
        ...fixture.ref,
        config: fixture.wctx.config,
        planner,
        callbacks: makeCallbacks({
          onApprovalNeeded: async (next) => {
            gates.push(next);
            return { approved: true };
          },
        }).callbacks,
      }),
      state: saved,
      setTrackedState: () => {},
      phaseTimings: {},
      startTime: Date.now(),
    });

    expect(result).toMatchObject({
      disposition: 'ready-for-tasks',
      state: { phase: 'implementing', tasks: [{ title: expectedTitle }] },
      tasks: [{ title: expectedTitle }],
    });
    expect(loadState(fixture.ref)).toMatchObject({
      phase: 'implementing',
      tasks: [{ title: expectedTitle }],
    });
    expect(runPhase.mock.calls.map(([input]) => input.call)).toEqual(
      gate === 'spec' ? ['plan', 'tasks'] : gate === 'plan' ? ['tasks'] : [],
    );
    if (gate === 'spec') expect(runPhase.mock.calls[0]?.[0].inputs.spec).toBe(corrected.toString());
    if (gate === 'plan') expect(runPhase.mock.calls[0]?.[0].inputs.plan).toBe(corrected.toString());
    expect(gates).toEqual(
      gate === 'spec'
        ? ['spec', 'plan', 'briefs']
        : gate === 'plan'
          ? ['plan', 'briefs']
          : ['briefs'],
    );
    expect(planner.regenerate).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledTimes(mode === 'speckit' ? 1 : 0);
    if (mode === 'speckit') {
      expect(existsSync(join(fixture.dir, 'clarifications.md'))).toBe(true);
      expect(existsSync(join(fixture.dir, 'constitution-check.json'))).toBe(true);
    }
    if (gate !== 'briefs')
      expect(readFileSync(join(fixture.dir, correctedFile))).toEqual(corrected);
    expect(upstream.map((file) => readFileSync(join(fixture.dir, file)))).toEqual(original);
    expect(fixture.prompts).toHaveLength(1);
    const messages = [];
    for await (const message of readMessages(fixture.ref)) messages.push(message);
    expect(
      messages.filter((message) => message.role === 'user').map((message) => message.text),
    ).toEqual([CORRECTION]);
  },
);

it.each(['spec', 'plan'] as const)(
  'preserves the existing artifacts when a corrected %s fails admission',
  async (gate) => {
    const fixture = setup(gate);
    const files = ['research.md', 'spec.md', 'plan.md', 'tasks.md'];
    const original = files.map((file) => readFileSync(join(fixture.dir, file)));
    fixture.wctx.planner = makePlanner({
      regenerate: async () => ({ text: 'invalid replacement without a heading', usage: null }),
    });
    await expect(fixture.run()).rejects.toThrow();
    expect(files.map((file) => readFileSync(join(fixture.dir, file)))).toEqual(original);
  },
);

it('warns when approval none skips the corrected briefs gate without recompiling its saved briefs', async () => {
  const fixture = setup('briefs');
  fixture.wctx.config = makeConfig({ workflow: { mode: 'standard', approve: 'none' } });
  const result = await fixture.run();
  expect(result?.disposition).toBe('ready-for-tasks');
  expect(fixture.prompts).toEqual([]);
  expect(fixture.onApprovalNeeded).not.toHaveBeenCalled();
  expect(fixture.events).toContainEqual(
    expect.objectContaining({
      type: 'warning',
      message:
        "Your correction was not applied: the briefs gate no longer opens at this run's approval level.",
    }),
  );
});

it.each([
  { mode: 'standard', approve: 'none' },
  { mode: 'quick', approve: 'all' },
] as const)(
  'warns before an omitted corrected briefs gate halts on failed quality ($mode/$approve)',
  async ({ mode, approve }) => {
    const fixture = setup('briefs');
    fixture.state.mode = mode;
    fixture.wctx.config = makeConfig({
      workflow: { mode: 'standard', approve, maxRetries: 0 },
    });
    const invalidTasks = fixture.state.tasks.map((task) => ({ ...task, tests: [] }));
    writeFileSync(join(fixture.dir, 'tasks.md'), formatTasks(invalidTasks));
    const result = await fixture.run();
    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(fixture.prompts).toEqual([]);
    expect(fixture.onApprovalNeeded).not.toHaveBeenCalled();
    const warningIndex = fixture.events.findIndex(
      (event) =>
        event.type === 'warning' &&
        event.message ===
          "Your correction was not applied: the briefs gate no longer opens at this run's approval level.",
    );
    const qualityIndex = fixture.events.findIndex((event) => event.type === 'brief_quality_failed');
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(qualityIndex).toBeGreaterThan(warningIndex);
    expect(fixture.events.filter((event) => event.type === 'warning')).toHaveLength(1);
    expect(fixture.continuation.take({ kind: 'gate', gate: 'briefs' })).toBeUndefined();
  },
);
