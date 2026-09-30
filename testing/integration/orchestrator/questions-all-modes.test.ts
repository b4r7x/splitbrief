import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_LOG_FILE, sessionDir } from '../../../src/core/paths.js';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import type { WorkflowMode } from '../../../src/core/schemas/enums.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { OrchestratorCallbacks } from '../../../src/engine/orchestrator/types.js';
import { runPlanningPhase } from '../../../src/engine/orchestrator/planning/run.js';
import { makePhaseCallResult } from '#testing/helpers/factories/phase-call.js';
import {
  createQuestionAccumulator,
  extractQuestionsFromStream,
} from '../../../src/engine/parsers/question.js';
import { CONVERSATIONAL_CAPS } from '../../../src/engine/planners/types.js';
import type {
  PhaseCallResult,
  Planner,
  PlannerCallbacks,
  RunPhaseInput,
} from '../../../src/engine/planners/types.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import {
  auto,
  makePassingTask,
  REAL_TASKS_MD,
  setupProject,
} from '#testing/helpers/planning-phase.js';
import {
  makeWorkflowMetadata,
  TEST_WORKFLOW_SINKS,
} from '#testing/helpers/orchestrator-context.js';

const Q1_MARKER =
  '<!-- Q:{"id":"q1","type":"choice","text":"Which auth approach should the module use?","options":["jwt","session"]} -->';
const Q2_MARKER =
  '<!-- Q:{"id":"q2","type":"input","text":"Which directory owns the login flow?"} -->';
const TWO_MARKERS = [Q1_MARKER, Q2_MARKER];
const SEVEN_MARKERS = Array.from(
  { length: 7 },
  (_, i) => `<!-- Q:{"id":"cap-q${i + 1}","type":"input","text":"Cap question ${i + 1}?"} -->`,
);
const ANSWER = 'use-jwt-for-auth';
const FLAVORS = ['conversational', 'command'] as const;

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function splitIntoChunks(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

type RecordedCall = { call: string; feature: string; promptPrefix: string };

function makeMarkerPlanner(opts: {
  flavor: (typeof FLAVORS)[number];
  markers: readonly string[];
}): { planner: Planner; planningInputs: RecordedCall[]; reviewPrompts: string[] } {
  const planningInputs: RecordedCall[] = [];
  const reviewPrompts: string[] = [];
  const narration = `Reviewing the feature request.\n\n${opts.markers.join('\n')}\n\nDrafting Task Briefs.\n`;

  const stream = (callbacks: PlannerCallbacks): void => {
    if (opts.flavor === 'conversational') {
      // Conversational backends (src/engine/runners/claude/invoke.ts) feed each streamed
      // text block to the question accumulator; marker lines arrive whole inside a block.
      const accumulator = createQuestionAccumulator();
      for (const chunk of narration.split(/(?<=\n)/)) {
        callbacks.onOutput(chunk);
        const fresh = accumulator.addChunk(chunk);
        if (fresh.length > 0) callbacks.onQuestion?.(fresh);
      }
      return;
    }
    // 7-byte chunks are shorter than the '<!-- Q:' prefix, so every marker arrives split
    // across chunk boundaries and exercises the engine-side stripper.
    for (const chunk of splitIntoChunks(narration, 7)) callbacks.onOutput(chunk);
    // Command-style backends surface markers only in stdout; the engine extracts them
    // once over the full output, mirroring src/engine/planners/command-invoke.ts.
    if (callbacks.onQuestion) {
      const questions = extractQuestionsFromStream(narration);
      if (questions.length > 0) callbacks.onQuestion(questions);
    }
  };

  const respond = async (input: RunPhaseInput): Promise<PhaseCallResult> => {
    planningInputs.push({
      call: input.call,
      feature: input.inputs.feature,
      promptPrefix: input.inputs.promptSuffix ?? input.inputs.promptPrefix ?? '',
    });
    if (planningInputs.length === 1) {
      stream(input.callbacks);
      return {
        kind: 'conversation',
        text: narration,
        questions: extractQuestionsFromStream(narration).slice(0, 5),
        usage: null,
      };
    }
    return makePhaseCallResult({
      call: input.call,
      usage: { inputTokens: 100, outputTokens: 50 },
      ...(input.call === 'tasks' ? { tasks: [makePassingTask()] } : {}),
    });
  };

  const planner = makePlanner({
    runPhase: vi.fn(respond),
    review: vi.fn(async (prompt: string) => {
      reviewPrompts.push(prompt);
      return { text: REAL_TASKS_MD, usage: null };
    }),
    ...(opts.flavor === 'conversational' ? { capabilities: CONVERSATIONAL_CAPS } : {}),
  });

  return { planner, planningInputs, reviewPrompts };
}

function entryState(feature: string): WorkflowState {
  return transition(createInitialState(feature), { type: 'START' });
}

async function runMode(opts: {
  mode: WorkflowMode;
  planner: Planner;
  onPlannerReply?: OrchestratorCallbacks['onPlannerReply'];
  project?: { projectDir: string; sessionId: string };
  state?: WorkflowState;
  feature?: string;
}) {
  const project = opts.project ?? setupProject(dirs);
  const feature = opts.feature ?? 'add token auth';
  const { callbacks } = makeCallbacks(
    opts.onPlannerReply ? { onPlannerReply: opts.onPlannerReply } : undefined,
  );
  const { bus, events } = makeBusRecorder();
  const result = await runPlanningPhase({
    wctx: {
      projectDir: project.projectDir,
      sessionId: project.sessionId,
      config: makeConfig({ workflow: auto(opts.mode) }),
      callbacks,
      metadata: makeWorkflowMetadata(opts.mode),
      bus,
      sinks: TEST_WORKFLOW_SINKS,
    },
    planner: opts.planner,
    state: opts.state ?? entryState(feature),
    feature,
  });
  return { result, events, ...project };
}

function expectMarkerFreePlannerText(events: EngineEvent[]): void {
  const texts = events.flatMap((event) => (event.type === 'planner_text' ? [event.text] : []));
  expect(texts.length).toBeGreaterThan(0);
  for (const text of texts) expect(text).not.toContain('<!--');
}

async function expectStillPending(promise: Promise<unknown>): Promise<void> {
  const outcome = await Promise.race([
    promise.then(() => 'settled'),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve('pending'), 25);
    }),
  ]);
  expect(outcome).toBe('pending');
}

function modeSuite(mode: WorkflowMode): void {
  it.each(FLAVORS)('%s planner: question prompt fires and pauses the workflow', async (flavor) => {
    const { planner } = makeMarkerPlanner({ flavor, markers: TWO_MARKERS });
    const resolvers: Array<(answer: string) => void> = [];
    const onPlannerReply = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const pending = runMode({ mode, planner, onPlannerReply });
    await vi.waitFor(() => expect(onPlannerReply).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await expectStillPending(pending);
    resolvers[0]?.('Use jwt in src/auth.');
    const { result, events } = await pending;

    expect(onPlannerReply).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: [expect.objectContaining({ id: 'q1' }), expect.objectContaining({ id: 'q2' })],
      }),
    );
    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expectMarkerFreePlannerText(events);
  });

  it('caps prompted questions at five when seven markers are emitted', async () => {
    const { planner } = makeMarkerPlanner({ flavor: 'command', markers: SEVEN_MARKERS });
    const onPlannerReply = vi.fn().mockResolvedValue('skip');

    const { result, events } = await runMode({ mode, planner, onPlannerReply });

    expect(onPlannerReply).toHaveBeenCalledTimes(1);
    expect(onPlannerReply.mock.calls[0]?.[0].questions).toHaveLength(5);
    expect(result.disposition).toBe('ready-for-tasks');
    expect(result.state.phase).toBe('implementing');
    expectMarkerFreePlannerText(events);
  });

  it('persists the answer in the transcript and continues the same planner step', async () => {
    const { planner, planningInputs } = makeMarkerPlanner({
      flavor: 'conversational',
      markers: TWO_MARKERS,
    });
    const onPlannerReply = vi.fn().mockResolvedValueOnce(ANSWER).mockResolvedValue('skip');

    const first = await runMode({ mode, planner, onPlannerReply });

    expect(first.result.disposition).toBe('ready-for-tasks');
    const specContent = readFileSync(
      join(sessionDir(first.projectDir, first.sessionId), SESSION_LOG_FILE),
      'utf8',
    );
    expect(specContent).toContain(ANSWER);

    const calls = planningInputs.map((input) => input.call);
    expect(calls[0]).toBe(calls[1]);
    expect(new Set(calls).size).toBe(calls.length - 1);
    expect(planningInputs.every((input) => !input.feature.includes(ANSWER))).toBe(true);
    expect(planningInputs[1]?.promptPrefix).toContain(ANSWER);
    expectMarkerFreePlannerText(first.events);
  });

  it('an empty answer sends the default continuation and continues the same step', async () => {
    const { planner, planningInputs } = makeMarkerPlanner({
      flavor: 'conversational',
      markers: TWO_MARKERS,
    });
    const onPlannerReply = vi.fn().mockResolvedValue('');

    const { result, events } = await runMode({ mode, planner, onPlannerReply });

    expect(onPlannerReply).toHaveBeenCalledTimes(1);
    expect(result.disposition).toBe('ready-for-tasks');
    expect(planningInputs[1]?.call).toBe(planningInputs[0]?.call);
    expect(planningInputs[1]?.promptPrefix).toContain('No further input');
    expectMarkerFreePlannerText(events);
  });

  it('a stopped reply wait parks the run without admitting a document', async () => {
    const { planner } = makeMarkerPlanner({ flavor: 'conversational', markers: TWO_MARKERS });
    const onPlannerReply = vi.fn().mockResolvedValue(undefined);

    const { result, events } = await runMode({ mode, planner, onPlannerReply });

    expect(onPlannerReply).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ disposition: 'terminal', outcome: 'input-required' });
    expectMarkerFreePlannerText(events);
  });
}

describe('quick', { timeout: 90_000 }, () => {
  modeSuite('quick');
});

describe('standard', { timeout: 90_000 }, () => {
  modeSuite('standard');
});

describe('speckit', { timeout: 90_000 }, () => {
  modeSuite('speckit');
});
