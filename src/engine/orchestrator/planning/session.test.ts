import { plainUserMessage } from '../../../core/types/user-input.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePlanProposal, makeTaskSpec } from '#testing/helpers/factories/plan.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
  TEST_SINKS,
} from '#testing/helpers/orchestrator-factories.js';
import { setupProject } from '#testing/helpers/planning-phase.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { scriptedTypedCall } from '#testing/helpers/typed-planner.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { PLAN_JSON_FILE, SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import { readSpecFileOrEmpty } from '../../../core/paths-io.js';
import type { PlanResult } from '../../../core/schemas/plan.js';
import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { parsePlanJson } from '../../../core/sessions/plan-file.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { gateChangedFiles } from '../approval/gate-files.js';
import { enqueueUserMessage } from '../queue/submit.js';
import type { OrchestratorCallbacks, ResumeContextHolder } from '../types.js';
import type { Planner } from '../../planners/types.js';
import { createSteeringPort, type SteeringPort } from '../../calls/steering.js';
import { sessionResumeExpiredError } from '../../session-expiry.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { resumeContinuation } from '../run/init.js';
import { measureApiBudget } from '../../providers/api-budget.js';
import { runPlanningPhase } from './run.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import {
  attachedMessage,
  expectCompactMessage,
  expectResumedMessage,
} from '#testing/helpers/user-message.js';

const statFailure = vi.hoisted(() => ({ code: undefined as string | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) => {
      if (args[0] === '/path-check/brief.md' && statFailure.code !== undefined) {
        return Promise.reject(
          Object.assign(new Error(`${statFailure.code}: cannot stat /path-check/brief.md`), {
            code: statFailure.code,
          }),
        );
      }
      return actual.stat(...args);
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  statFailure.code = undefined;
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

const questions = (round: number): PlanResult => ({
  kind: 'questions',
  questions: [
    { id: `q${round}a`, text: `Round ${round}: which module?`, choices: null, default: 'src/a.ts' },
    {
      id: `q${round}b`,
      text: `Round ${round}: which style?`,
      choices: ['terse', 'verbose'],
      default: 'terse',
    },
  ],
});

const uncoveredPlan = makePlanProposal({
  criteria: [
    { id: 'C1', text: 'A name gets a greeting', checkIds: ['K1'] },
    { id: 'C2', text: 'An empty name is refused', checkIds: ['K1'] },
  ],
});

async function plan(opts: {
  script: Array<PlanResult | string | Error>;
  config?: Config;
  callbacks?: Partial<OrchestratorCallbacks>;
  state?: (state: WorkflowState) => WorkflowState;
  setup?: (projectDir: string) => void;
  rewindPending?: WorkflowState['rewindPending'];
  planner?: Partial<Planner>;
  resumeHolder?: ResumeContextHolder;
  feature?: string;
  steering?: SteeringPort;
}) {
  const { projectDir, sessionId } = setupProject(dirs);
  opts.setup?.(projectDir);
  const typed = scriptedTypedCall(opts.script);
  const planner = makePlanner({ typedCall: typed.typedCall, ...opts.planner });
  const onApprovalNeeded = vi.fn().mockResolvedValue({ approved: true });
  const { bus, events } = makeBusRecorder();
  bus.subscribe(createJsonlSink({ projectDir, sessionId }));
  const started = transition(createInitialState('greet people'), { type: 'START' });
  const state = opts.state?.(started) ?? started;
  saveState({ projectDir, sessionId }, state);
  const result = await runPlanningPhase({
    wctx: {
      projectDir,
      sessionId,
      config: opts.config ?? makeConfig({ codebase: { enabled: false, tokenBudget: 4000 } }),
      callbacks: makeCallbacks({ onApprovalNeeded, ...opts.callbacks }).callbacks,
      bus,
      metadata: TEST_METADATA,
      sinks: TEST_SINKS,
      ...(opts.steering !== undefined && { steering: opts.steering }),
      ...(opts.resumeHolder !== undefined && { resumeHolder: opts.resumeHolder }),
    },
    planner,
    state,
    feature: opts.feature ?? 'greet people',
    ...(opts.rewindPending !== undefined && { rewindPending: opts.rewindPending }),
  });
  return {
    result,
    prompts: typed.prompts,
    contexts: typed.contexts,
    onApprovalNeeded,
    events,
    projectDir,
    sessionId,
  };
}

describe('the planning thread', () => {
  it('passes queued images and their expanded text into the next planning call', async () => {
    const message = {
      ...plainUserMessage('Inspect [image:queue-shot]\n\nPELICAN-42'),
      id: 'queued-shot',
      queuedAt: '2026-10-10T00:00:00Z',
      phase: 'planning' as const,
      deliveredViaNative: false,
      nativeDeliveryState: 'pending' as const,
      images: [
        {
          id: 'queue-shot',
          kind: 'image' as const,
          path: '/outside/shot.png',
          mimeType: 'image/png',
          sizeBytes: 5,
        },
      ],
      attachedInputs: [{ kind: 'image' as const, path: '/outside/shot.png' }],
    };
    const run = await plan({
      script: [makePlanProposal()],
      state: (state) => ({ ...state, messageQueue: [message] }),
    });

    expect(run.prompts[0]).toContain(message.text);
    expect(run.contexts[0]?.images).toEqual(message.images);
    expect(loadState(run)?.messageQueue[0]?.images).toEqual(message.images);
  });

  it('delivers an attached file in a planner reply and records compact text once', async () => {
    let message = plainUserMessage('');
    const run = await plan({
      script: [questions(1), makePlanProposal()],
      setup: (projectDir) => {
        message = attachedMessage(projectDir);
      },
      callbacks: { onPlannerReply: async () => message },
    });
    expect(run.prompts[1]).toContain(message.text);
    expect(run.result.state.userAnswers?.[0]?.answer).toBe(message.text);
    expect(loadState(run)?.resumeUserMessages?.[0]).toMatchObject({ answerIndex: 0 });
    expect(loadState(run)?.resumeUserMessages?.[0]).not.toHaveProperty('text');
    await expectCompactMessage(run, run.events, message);
    await expectResumedMessage(run, message);
  });

  it('delivers an attached file in a plan revision and publishes the correction once', async () => {
    let message = plainUserMessage('');
    let revised = false;
    const run = await plan({
      script: [makePlanProposal(), makePlanProposal()],
      setup: (projectDir) => {
        message = attachedMessage(projectDir);
      },
      callbacks: {
        onApprovalNeeded: async () => {
          if (revised) return { approved: true };
          revised = true;
          return { approved: false, action: 'revise', message };
        },
      },
    });
    expect(run.prompts[1]).toContain('PELICAN-42');
    expect(run.events.find((event) => event.type === 'plan_regenerated')).toMatchObject({
      comment: message.displayText,
    });
    await expectCompactMessage(run, run.events, message);
    await expectResumedMessage(run, message);
  });

  it('passes the same steering port to opening, answer, and repair calls', async () => {
    const steering = createSteeringPort();
    const run = await plan({
      script: [questions(1), uncoveredPlan, makePlanProposal()],
      callbacks: { onPlannerReply: vi.fn().mockResolvedValue(plainUserMessage('')) },
      steering,
    });

    expect(run.result.disposition).toBe('ready-for-tasks');
    expect(run.contexts).toHaveLength(3);
    for (const ctx of run.contexts) expect(ctx.callbacks.steering).toBe(steering);
    expect(steering.current()).toBeNull();
  });

  it('hands the rebuilt transcript to the first call only', async () => {
    const messages = [{ role: 'user' as const, content: 'Earlier: keep the public API' }];
    const run = await plan({
      script: [questions(1), makePlanProposal()],
      callbacks: { onPlannerReply: vi.fn().mockResolvedValue(plainUserMessage('')) },
      resumeHolder: { messages },
    });

    expect(run.contexts.map((ctx) => ctx.priorMessages)).toEqual([messages, undefined]);
    expect(run.result.disposition).toBe('ready-for-tasks');
  });

  it('rebuilds structured attached answers when the native planner session expires', async () => {
    let message = plainUserMessage('');
    const run = await plan({
      script: [questions(1), sessionResumeExpiredError('native-1', 'Expired'), makePlanProposal()],
      setup: (projectDir) => {
        const attached = attachedMessage(projectDir);
        message = {
          ...attached,
          displayText: `1. Round 1: which module?\n${attached.displayText}\n\n2. Round 1: which style?\nterse`,
          text: `1. Round 1: which module?\n${attached.text}\n\n2. Round 1: which style?\nterse`,
        };
      },
      callbacks: {
        onPlannerReply: async () => ({
          message,
          qa: [
            {
              question: 'Round 1: which module?',
              answer: message.displayText.split('\n')[1] ?? '',
            },
            { question: 'Round 1: which style?', answer: 'terse' },
          ],
        }),
      },
      planner: {
        capabilities: { ...makePlanner().capabilities, supportsSessionResume: true },
      },
      state: (state) => ({ ...state, plannerSessionId: 'native-1' }),
    });

    expect(run.contexts[2]?.priorMessages).toContainEqual({ role: 'user', content: message.text });
    await expectCompactMessage(run, run.events, message);
    await expectResumedMessage(run, message);
  });

  it('asks again on a fresh session with the whole conversation when the thread expired', async () => {
    const run = await plan({
      script: [
        questions(1),
        sessionResumeExpiredError('native-1', 'No conversation found with session ID native-1'),
        makePlanProposal(),
      ],
      callbacks: { onPlannerReply: vi.fn().mockResolvedValue(plainUserMessage('')) },
      planner: {
        capabilities: { ...makePlanner().capabilities, supportsSessionResume: true },
      },
      state: (state) => ({ ...state, plannerSessionId: 'native-1' }),
    });

    // On the thread the answers go alone; the fresh session reads the prompt and the round again.
    expect(run.prompts[1]).not.toContain('# Plan the change');
    expect(run.prompts[2]).toContain('# Plan the change');
    expect(run.prompts[2]).toContain('Round 1: which module?');
    expect(run.events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        message: expect.stringMatching(/^Planner session expired/),
      }),
    );
    expect(run.result.disposition).toBe('ready-for-tasks');
    expect(run.result.state.plannerSessionId ?? null).toBeNull();
  });
});

describe('a planner that reads no files of its own', () => {
  const ROOMY_CONTEXT = {
    contextKey: 'ollama@local',
    selectionId: 'qwen2.5',
    observedAt: 0,
    applicationContextTokens: 64_000,
    budgetSource: 'configured' as const,
    loadState: 'unknown' as const,
  };
  const writeHello = (projectDir: string) => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'hello.ts'), 'export const HELLO_SENTINEL = 1;\n');
  };

  it('carries the current source of the files the request names in its first prompt', async () => {
    const run = await plan({
      script: [makePlanProposal()],
      planner: { resolvePlanningContext: async () => ROOMY_CONTEXT },
      feature: 'Modify `src/hello.ts` so it greets people by name.',
      setup: writeHello,
    });

    expect(run.prompts).toHaveLength(1);
    expect(run.prompts[0]).toContain('export const HELLO_SENTINEL = 1;');
    expect(run.prompts[0]).toContain('src/hello.ts — whole file, sha256');
    expect(run.prompts[0]).toContain('no filesystem, shell or search tool');
    expect(run.result.disposition).toBe('ready-for-tasks');
  });

  it('leaves a planner that reads the project itself to read it', async () => {
    const run = await plan({
      script: [makePlanProposal()],
      feature: 'Modify `src/hello.ts` so it greets people by name.',
      setup: writeHello,
    });

    expect(run.prompts[0]).not.toContain('HELLO_SENTINEL');
  });

  it('admits every later turn of a session whose first packet filled the context', async () => {
    const context = { ...ROOMY_CONTEXT, applicationContextTokens: 16_000 };
    const run = await plan({
      script: [questions(1), uncoveredPlan, 'not json', makePlanProposal()],
      config: makeConfig({ codebase: { enabled: true, tokenBudget: 4000 } }),
      callbacks: { onPlannerReply: vi.fn().mockResolvedValue(plainUserMessage('')) },
      planner: { resolvePlanningContext: async () => context },
      feature: 'Modify `src/m0.ts` so it greets people by name.',
      setup: (projectDir) => {
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        for (let index = 0; index < 40; index++) {
          writeFileSync(
            join(projectDir, 'src', `m${index}.ts`),
            `import { m${(index + 1) % 40} } from './m${(index + 1) % 40}.js';\nexport function m${index}(name: string): string {\n  return \`${'x'.repeat(1200)}\` + name + m${(index + 1) % 40};\n}\n`,
          );
        }
      },
    });

    expect(run.prompts).toHaveLength(4);
    for (const prompt of run.prompts) {
      const measured = measureApiBudget({
        context,
        messages: [{ role: 'user', content: prompt }],
        role: 'plan',
      });
      expect(measured.kind).toBe('fits');
    }
    expect(run.result.disposition).toBe('ready-for-tasks');
  });

  const pathNotices = (events: readonly { type: string }[]) =>
    events.filter(
      (event): event is { type: 'warning'; message: string } =>
        event.type === 'warning' &&
        String((event as { message?: unknown }).message).includes('cannot open'),
    );

  it('names every absolute path it cannot open in one warning before the first call', async () => {
    let brief = '';
    let notes = '';
    const run = await plan({
      script: [questions(1), makePlanProposal()],
      callbacks: { onPlannerReply: vi.fn().mockResolvedValue(plainUserMessage('')) },
      planner: { resolvePlanningContext: async () => ROOMY_CONTEXT },
      setup: (projectDir) => {
        mkdirSync(join(projectDir, 'notes'), { recursive: true });
        writeFileSync(join(projectDir, 'notes', 'brief.md'), 'PELICAN-42\n');
        brief = join(projectDir, 'notes', 'brief.md');
        notes = join(projectDir, 'notes');
      },
      get feature() {
        return `Plan from ${brief}, and read ${notes}/ too.`;
      },
    });

    const notices = pathNotices(run.events);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toBe(
      `The plan seat reads no files, so it cannot open ${brief}, ${notes}/. Put @ before a file path to attach its text.`,
    );
    expect(run.prompts).toHaveLength(2);
    expect(run.prompts[0]).not.toContain('PELICAN-42');
    expect(run.result.disposition).toBe('ready-for-tasks');
  });

  it('says nothing about a slash route that names no file or folder', async () => {
    const run = await plan({
      script: [makePlanProposal()],
      planner: { resolvePlanningContext: async () => ROOMY_CONTEXT },
      feature: 'Rate-limit /api/users and /v1/login/refresh.',
    });

    expect(pathNotices(run.events)).toEqual([]);
  });

  it.each(['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'ELOOP', 'EACCES', 'EPERM'])(
    'does not name a path whose metadata check fails with %s',
    async (code) => {
      statFailure.code = code;
      const run = await plan({
        script: [makePlanProposal()],
        planner: { resolvePlanningContext: async () => ROOMY_CONTEXT },
        feature: 'Read /path-check/brief.md.',
      });

      expect(pathNotices(run.events)).toEqual([]);
      expect(run.result.disposition).toBe('ready-for-tasks');
    },
  );

  it('propagates a metadata EIO failure to the planning error boundary before any call', async () => {
    statFailure.code = 'EIO';
    const run = await plan({
      script: [makePlanProposal()],
      planner: { resolvePlanningContext: async () => ROOMY_CONTEXT },
      feature: 'Read /path-check/brief.md.',
    });

    expect(run.prompts).toEqual([]);
    expect(pathNotices(run.events)).toEqual([]);
    expect(run.result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(run.events).toContainEqual(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('EIO') }),
    );
  });

  it('says nothing when the plan seat reads the path with its own tools', async () => {
    let brief = '';
    const run = await plan({
      script: [makePlanProposal()],
      setup: (projectDir) => {
        writeFileSync(join(projectDir, 'brief.md'), 'PELICAN-42\n');
        brief = join(projectDir, 'brief.md');
      },
      get feature() {
        return `Plan the change in ${brief}.`;
      },
    });

    expect(pathNotices(run.events)).toEqual([]);
  });

  it('halts before any call when the named source does not fit the model', async () => {
    const run = await plan({
      script: [makePlanProposal()],
      planner: {
        resolvePlanningContext: async () => ({ ...ROOMY_CONTEXT, applicationContextTokens: 2_200 }),
      },
      feature: 'Modify `src/hello.ts` so it greets people by name.',
      setup: writeHello,
    });

    expect(run.prompts).toEqual([]);
    expect(run.result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(run.result.state.pendingRecovery?.facts?.apiContextCode).toBe('insufficient-context');
    expect(run.result.state.pendingRecovery?.details).toContain(
      'Pick a plan seat with a larger context in /crew plan, then choose Try again.',
    );
  });
});

describe('the planning session on the live path', () => {
  it('asks the questions, takes every default on ⏎, and reaches the plan approval', async () => {
    const onPlannerReply = vi.fn().mockResolvedValue(plainUserMessage(''));
    const run = await plan({
      script: [questions(1), makePlanProposal()],
      callbacks: { onPlannerReply },
    });

    expect(onPlannerReply).toHaveBeenCalledTimes(1);
    expect(onPlannerReply.mock.calls[0]?.[0]).toMatchObject({
      call: 'plan',
      questions: [
        { id: 'q1a', type: 'input', default: 'src/a.ts' },
        { id: 'q1b', type: 'choice', options: ['terse', 'verbose'], default: 'terse' },
      ],
    });
    expect(run.prompts[1]).toContain('Round 1: which module?\nsrc/a.ts');
    expect(run.prompts[1]).toContain('Round 1: which style?\nterse');
    expect(run.onApprovalNeeded).toHaveBeenCalledWith(
      'plan',
      expect.stringMatching(/plan\.md$/),
      [],
    );
    expect(run.result.disposition).toBe('ready-for-tasks');
    expect(run.result.state.phase).toBe('implementing');
    expect(run.result.state.pendingPlannerConversation).toBeUndefined();
    expect(run.result.state.userAnswers).toEqual([
      {
        reply: expect.stringContaining('Round 1: which module?'),
        answer: expect.stringContaining('src/a.ts'),
      },
    ]);
    expect(loadState(run)?.userAnswers).toEqual(run.result.state.userAnswers);
    expect(run.result.state.plan?.summary).toBe('Greet people by name');
    expect(run.result.state.tasks.map((task) => task.suggestedFiles[0])).toEqual(['src/hello.ts']);
    expect(parsePlanJson(readSpecFileOrEmpty(run, PLAN_JSON_FILE))).toEqual({
      plan: makePlanProposal(),
    });
  });

  it('keeps a typed reply in the session log and hands it to the next planning call', async () => {
    const run = await plan({
      script: [questions(1), makePlanProposal()],
      callbacks: {
        onPlannerReply: vi.fn().mockResolvedValue(plainUserMessage('use-jwt-for-auth')),
      },
    });

    const log = readFileSync(
      join(sessionDir(run.projectDir, run.sessionId), SESSION_LOG_FILE),
      'utf8',
    );
    expect(log).toContain('use-jwt-for-auth');
    expect(run.prompts[0]).not.toContain('use-jwt-for-auth');
    expect(run.prompts[1]).toContain('use-jwt-for-auth');
    expect(run.result.disposition).toBe('ready-for-tasks');
  });

  it.each([
    ['an uncovered criterion', uncoveredPlan, 'uncovered-criterion'],
    [
      'a criterion without a check',
      makePlanProposal({ criteria: [{ id: 'C1', text: 'A name gets a greeting', checkIds: [] }] }),
      'criterion-without-check',
    ],
    [
      'a dependency cycle',
      makePlanProposal({
        tasks: [
          makeTaskSpec({ id: 'T001', dependsOn: ['T002'] }),
          makeTaskSpec({
            id: 'T002',
            dependsOn: ['T001'],
            checks: [{ id: 'K2', kind: 'test', value: 'src/b.test.ts', required: true }],
            suggestedFiles: ['src/b.ts'],
          }),
        ],
      }),
      'dependency-cycle',
    ],
    [
      'a duplicate check id',
      makePlanProposal({
        tasks: [
          makeTaskSpec({ id: 'T001' }),
          makeTaskSpec({ id: 'T002', suggestedFiles: ['src/b.ts'] }),
        ],
      }),
      'duplicate-check-id',
    ],
    [
      'a task over the context of the implementer',
      makePlanProposal({ tasks: [makeTaskSpec({ contextFiles: ['src/big.ts'] })] }),
      'context-overflow',
    ],
    [
      'a directory as a context file',
      makePlanProposal({ tasks: [makeTaskSpec({ contextFiles: ['src'] })] }),
      'path-not-file',
    ],
    [
      'a directory as a suggested file',
      makePlanProposal({ tasks: [makeTaskSpec({ suggestedFiles: ['src'] })] }),
      'path-not-file',
    ],
    [
      'a context file that does not exist',
      makePlanProposal({ tasks: [makeTaskSpec({ contextFiles: ['src/gone.ts'] })] }),
      'missing-context-file',
    ],
    [
      'a protected operation that asks for nothing',
      makePlanProposal({
        tasks: [
          makeTaskSpec({ protectedOperations: [{ path: 'src/hello.ts', operation: 'write' }] }),
        ],
      }),
      'unprotected-operation',
    ],
  ] as const)(
    'sends a plan with %s back once and approves the corrected plan',
    async (_label, invalid, code) => {
      const run = await plan({
        script: [invalid, makePlanProposal()],
        config: makeConfig({
          codebase: { enabled: false, tokenBudget: 4000 },
          implementer: { contextLength: 8192 },
        }),
        setup: (projectDir) => {
          mkdirSync(join(projectDir, 'src'), { recursive: true });
          writeFileSync(join(projectDir, 'src', 'big.ts'), 'export const x = 1;\n'.repeat(2500));
        },
      });

      expect(run.prompts).toHaveLength(2);
      expect(run.prompts[1]).toContain(`- ${code}: `);
      expect(run.events).toContainEqual(
        expect.objectContaining({
          type: 'warning',
          message: expect.stringMatching(
            new RegExp(`^The plan failed check ${code}: .+; it goes back to the planner once\\.$`),
          ),
          planCheck: expect.objectContaining({ code, message: expect.any(String) }),
        }),
      );
      expect(run.onApprovalNeeded).toHaveBeenCalledTimes(1);
      expect(run.result.disposition).toBe('ready-for-tasks');
    },
  );

  it('reports one pass after the repaired plan passes its checks', async () => {
    const run = await plan({ script: [uncoveredPlan, makePlanProposal()] });
    const passes = run.events.filter(
      (event) => event.type === 'info' && event.message === 'The revised plan passes its checks.',
    );
    expect(passes).toEqual([
      {
        type: 'info',
        ts: expect.any(Number),
        phase: 'planning',
        message: 'The revised plan passes its checks.',
      },
    ]);
    expect(run.events.findIndex((event) => event.type === 'warning')).toBeLessThan(
      run.events.findIndex((event) => passes.includes(event)),
    );
  });

  it.each([
    { name: 'an initial pass', script: [makePlanProposal()] },
    { name: 'a failed retry', script: [uncoveredPlan, uncoveredPlan] },
  ])('does not report a repair pass for $name', async ({ script }) => {
    const run = await plan({ script });
    expect(
      run.events.filter(
        (event) =>
          (event.type === 'info' && event.message === 'The revised plan passes its checks.') ||
          (event.type === 'planner_text' && event.text === 'The revised plan passes its checks.'),
      ),
    ).toEqual([]);
  });

  it('names the check code and reason in the warning on one failing check', async () => {
    const run = await plan({ script: [uncoveredPlan, makePlanProposal()] });

    expect(run.events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        message:
          'The plan failed check uncovered-criterion: Criterion C2 is served by no task; it goes back to the planner once.',
        planCheck: {
          code: 'uncovered-criterion',
          message: 'Criterion C2 is served by no task.',
        },
      }),
    );
    expect(run.result.disposition).toBe('ready-for-tasks');
  });

  it('names the first blocking check and the count of more checks when three checks fail', async () => {
    const threeErrorsPlan = makePlanProposal({
      criteria: [
        { id: 'C1', text: 'A name gets a greeting', checkIds: [] },
        { id: 'C2', text: 'An empty name is refused', checkIds: [] },
        { id: 'C3', text: 'Special characters handled', checkIds: [] },
      ],
      tasks: [makeTaskSpec({ criteria: ['C1', 'C2', 'C3'] })],
    });
    const run = await plan({ script: [threeErrorsPlan, makePlanProposal()] });

    expect(run.events).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        message:
          'The plan failed check criterion-without-check: Criterion C1 names no check that verifies it (+2 more); it goes back to the planner once.',
        planCheck: {
          code: 'criterion-without-check',
          message: 'Criterion C1 names no check that verifies it.',
        },
      }),
    );
    expect(run.result.disposition).toBe('ready-for-tasks');
  });

  it('halts on a second plan that fails its checks and never opens the approval', async () => {
    const run = await plan({ script: [uncoveredPlan, uncoveredPlan] });

    expect(run.onApprovalNeeded).not.toHaveBeenCalled();
    expect(run.result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(run.result.state.pendingRecovery).toMatchObject({
      reason: 'plan-checks-failed',
      details: ['Criterion C2 is served by no task.'],
    });
  });

  it('sends render checks back once while validation.render is unset, then names them on the card', async () => {
    const renderPlan = makePlanProposal({
      checks: [{ id: 'K-render', kind: 'render', value: 'overlay-picker', required: true }],
      criteria: [{ id: 'C1', text: 'A name gets a greeting', checkIds: ['K1', 'K-render'] }],
    });
    const run = await plan({ script: [renderPlan, renderPlan] });

    expect(run.prompts[1]).toContain(
      'Render check K-render needs validation.render, which is not set; drop it or ask the user.',
    );
    expect(run.onApprovalNeeded).toHaveBeenCalledTimes(1);
    expect(run.result.disposition).toBe('ready-for-tasks');
    const card = readFileSync(join(sessionDir(run.projectDir, run.sessionId), 'plan.md'), 'utf8');
    expect(card).toContain('## Before you approve');
    expect(card).toContain('K-render');
    expect(card).toContain('validation.render');
    expect(
      run.events.filter(
        (event) =>
          (event.type === 'info' && event.message === 'The revised plan passes its checks.') ||
          (event.type === 'planner_text' && event.text === 'The revised plan passes its checks.'),
      ),
    ).toEqual([]);
  });

  it('takes render checks without a word when validation.render is set', async () => {
    const renderPlan = makePlanProposal({
      checks: [{ id: 'K-render', kind: 'render', value: 'overlay-picker', required: true }],
      criteria: [{ id: 'C1', text: 'A name gets a greeting', checkIds: ['K1', 'K-render'] }],
    });
    const run = await plan({
      script: [renderPlan],
      config: makeConfig({
        codebase: { enabled: false, tokenBudget: 4000 },
        validation: { render: 'npm run tui-shots -- --scenario {id} --output {out}' },
      }),
    });

    expect(run.prompts).toHaveLength(1);
    const card = readFileSync(join(sessionDir(run.projectDir, run.sessionId), 'plan.md'), 'utf8');
    expect(card).not.toContain('## Before you approve');
  });

  it('halts on a third round of questions and keeps the answered rounds', async () => {
    const run = await plan({
      script: [questions(1), questions(2), questions(3)],
      callbacks: { onPlannerReply: vi.fn().mockResolvedValue(plainUserMessage('')) },
    });

    expect(run.result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(run.result.state.pendingRecovery?.reason).toBe('plan-questions-exhausted');
    expect(run.result.state.pendingPlannerConversation?.answers).toHaveLength(2);
  });

  it.each([
    ['retry-same-worker', undefined],
    ['revise', 'Keep it in one module'],
  ] as const)(
    'tells the planner no question round remains when a run halted at a third round continues (%s)',
    async (action, comment) => {
      const first = await plan({
        script: [questions(1), questions(2), questions(3)],
        callbacks: { onPlannerReply: vi.fn().mockResolvedValue(plainUserMessage('')) },
      });
      expect(first.result.state.pendingRecovery?.reason).toBe('plan-questions-exhausted');
      const saved = loadState(first);
      if (saved === null) throw new Error('state not saved');
      const applied = await applyRecoveryAction({
        ...first,
        state: saved,
        action,
        comment: comment === undefined ? undefined : plainUserMessage(comment),
        bus: makeBusRecorder().bus,
      });
      expect(applied).toMatchObject({ ok: true, status: 'continued' });

      const typed = scriptedTypedCall([makePlanProposal()]);
      const result = await runPlanningPhase({
        wctx: {
          projectDir: first.projectDir,
          sessionId: first.sessionId,
          config: makeConfig({ codebase: { enabled: false, tokenBudget: 4000 } }),
          callbacks: makeCallbacks().callbacks,
          bus: makeBusRecorder().bus,
          metadata: TEST_METADATA,
          sinks: TEST_SINKS,
        },
        planner: makePlanner({ typedCall: typed.typedCall }),
        state: applied.state,
        feature: 'greet people',
      });

      expect(typed.prompts[0]).toContain('No question round remains');
      if (comment !== undefined) expect(typed.prompts[0]).toContain(comment);
      expect(result.disposition).toBe('ready-for-tasks');
    },
  );

  it('halts on an answer that twice fails the typed contract', async () => {
    const run = await plan({ script: ['not json', 'still not json'] });

    expect(run.result).toMatchObject({ disposition: 'terminal', outcome: 'halted' });
    expect(run.result.state.pendingRecovery?.reason).toBe('seat-protocol-error');
  });

  it('records the plan validation block as the discovered validation', async () => {
    const run = await plan({
      script: [
        makePlanProposal({
          validation: {
            language: 'typescript',
            test: 'npx vitest run',
            testPattern: '*.test.ts',
          },
        }),
      ],
    });

    expect(run.result.state.discoveredValidation).toEqual({
      language: 'typescript',
      testCommand: 'npx vitest run',
      testPattern: '*.test.ts',
    });
  });

  it('parks unanswered questions and answers them when the run continues', async () => {
    const first = await plan({ script: [questions(1)] });
    expect(first.result).toMatchObject({ disposition: 'terminal', outcome: 'input-required' });

    const saved = loadState(first);
    if (saved === null) throw new Error('state not saved');
    expect(saved.pendingPlannerConversation).toMatchObject({ call: 'plan', answered: false });

    const typed = scriptedTypedCall([makePlanProposal()]);
    const result = await runPlanningPhase({
      wctx: {
        projectDir: first.projectDir,
        sessionId: first.sessionId,
        config: makeConfig({ codebase: { enabled: false, tokenBudget: 4000 } }),
        callbacks: makeCallbacks({
          onPlannerReply: vi.fn().mockResolvedValue({
            message: plainUserMessage('1. Round 1: which module?\nsrc/b.ts'),
            qa: [{ question: 'Round 1: which module?', answer: 'src/b.ts' }],
          }),
        }).callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner: makePlanner({ typedCall: typed.typedCall }),
      state: saved,
      feature: 'greet people',
    });

    expect(typed.prompts).toHaveLength(1);
    expect(typed.prompts[0]).toContain('Round 1: which module?\nsrc/b.ts');
    expect(result.disposition).toBe('ready-for-tasks');
  });

  it('runs a pending rewind as one session that carries its comment, then shows the plan card', async () => {
    const rewindPending = { target: 'plan' as const, comment: 'Split the greeting module' };
    const run = await plan({
      script: [makePlanProposal()],
      state: (state) => ({ ...state, rewindPending }),
      rewindPending,
    });

    expect(run.prompts).toHaveLength(1);
    expect(run.prompts[0]).toContain('Split the greeting module');
    expect(run.onApprovalNeeded).toHaveBeenCalledOnce();
    expect(run.onApprovalNeeded).toHaveBeenCalledWith(
      'plan',
      expect.stringMatching(/plan\.md$/),
      [],
    );
    expect(run.result.disposition).toBe('ready-for-tasks');
    expect(loadState(run)?.rewindPending).toBeUndefined();
  });

  it('reads a plan conversation an older chain left as earlier planning and clears it', async () => {
    const onPlannerReply = vi.fn();
    const run = await plan({
      script: [makePlanProposal()],
      callbacks: { onPlannerReply },
      state: (state) => ({
        ...state,
        pendingPlannerConversation: {
          call: 'plan',
          text: 'Which store should keep the greeting?',
          questions: [],
          answers: [],
          answered: false,
        },
      }),
    });

    expect(onPlannerReply).not.toHaveBeenCalled();
    expect(run.prompts).toHaveLength(1);
    expect(run.prompts[0]).toContain('Which store should keep the greeting?');
    expect(run.result.disposition).toBe('ready-for-tasks');
    expect(run.result.state.pendingPlannerConversation).toBeUndefined();
  });

  it('reads a steer that continues an old unanswered question as that question’s answer', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const state: WorkflowState = {
      ...createInitialState('greet people'),
      phase: 'researching',
      mode: 'standard',
      pendingPlannerConversation: {
        call: 'research',
        text: 'Which DB should we use?',
        questions: [],
        answers: [],
        answered: false,
      },
    };
    saveState({ projectDir, sessionId }, state);
    const holder = await resumeContinuation({
      ref: { projectDir, sessionId },
      state,
      steer: plainUserMessage('ANSWER-ABC postgres'),
    });
    const typed = scriptedTypedCall([makePlanProposal()]);

    await runPlanningPhase({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ codebase: { enabled: false, tokenBudget: 4000 } }),
        callbacks: makeCallbacks().callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        continuation: holder,
      },
      planner: makePlanner({ typedCall: typed.typedCall }),
      state,
      feature: 'greet people',
    });

    expect(typed.prompts[0]).toContain('Which DB should we use?\n\nUser:\nANSWER-ABC postgres');
    expect(typed.prompts[0]).not.toContain('(not answered)');
    expect(typed.prompts[0]?.match(/ANSWER-ABC/g)).toHaveLength(1);
  });

  it('starts an old run that stopped inside the multi-step chain on one session with its documents', async () => {
    const { projectDir, sessionId } = setupProject(dirs);
    const { writeSpecFile } = await import('../../../core/paths-io.js');
    writeSpecFile({ projectDir, sessionId }, 'research.md', '# Research\n\nOld findings', null);
    const typed = scriptedTypedCall([makePlanProposal({ tasks: [makeTaskSpec()] })]);
    const state: WorkflowState = {
      ...createInitialState('greet people'),
      phase: 'reviewing-spec',
      mode: 'standard',
    };
    saveState({ projectDir, sessionId }, state);

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        sessionId,
        config: makeConfig({ codebase: { enabled: false, tokenBudget: 4000 } }),
        callbacks: makeCallbacks().callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner: makePlanner({ typedCall: typed.typedCall }),
      state,
      feature: 'greet people',
    });

    expect(typed.prompts[0]).toContain('Old findings');
    expect(result.disposition).toBe('ready-for-tasks');
  });
});

describe('the plan card', () => {
  it('sends typed text back to the same session with the plan, then shows the card again', async () => {
    const onApprovalNeeded = vi
      .fn()
      .mockResolvedValueOnce({
        approved: false,
        action: 'revise',
        message: plainUserMessage('Greet in Polish'),
      })
      .mockResolvedValue({ approved: true });
    const run = await plan({
      script: [makePlanProposal(), makePlanProposal({ summary: 'Greet people in Polish' })],
      callbacks: { onApprovalNeeded },
    });

    expect(run.prompts).toHaveLength(2);
    expect(run.prompts[1]).toContain('Greet in Polish');
    expect(run.prompts[1]).toContain('"summary": "Greet people by name"');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(run.events.some((event) => JSON.stringify(event).includes('Regenerating'))).toBe(false);
    expect(run.result.disposition).toBe('ready-for-tasks');
    expect(run.result.state.plan?.summary).toBe('Greet people in Polish');
  });

  it('keeps the correction on every later call of a planner without a session', async () => {
    const onApprovalNeeded = vi
      .fn()
      .mockResolvedValueOnce({
        approved: false,
        action: 'revise',
        message: plainUserMessage('Greet in Polish'),
      })
      .mockResolvedValue({ approved: true });
    const run = await plan({
      script: [
        makePlanProposal(),
        questions(1),
        makePlanProposal({ summary: 'Greet people in Polish' }),
      ],
      callbacks: {
        onApprovalNeeded,
        onPlannerReply: vi.fn().mockResolvedValue(plainUserMessage('')),
      },
    });

    expect(run.prompts).toHaveLength(3);
    expect(run.prompts[2]).toContain('Greet in Polish');
    expect(run.prompts[2]).toContain('"summary": "Greet people by name"');
    expect(run.prompts[2]?.match(/Greet in Polish/g)).toHaveLength(1);
    expect(run.result.state.plan?.summary).toBe('Greet people in Polish');
  });

  it('keeps the correction across a stop at the questions it led to', async () => {
    const first = await plan({
      script: [makePlanProposal(), questions(1)],
      callbacks: {
        onApprovalNeeded: vi.fn().mockResolvedValueOnce({
          approved: false,
          action: 'revise',
          message: plainUserMessage('Greet in Polish'),
        }),
      },
    });
    expect(first.result).toMatchObject({ disposition: 'terminal', outcome: 'input-required' });
    const saved = loadState(first);
    if (saved === null) throw new Error('state not saved');

    const typed = scriptedTypedCall([questions(2), makePlanProposal()]);
    await runPlanningPhase({
      wctx: {
        projectDir: first.projectDir,
        sessionId: first.sessionId,
        config: makeConfig({ codebase: { enabled: false, tokenBudget: 4000 } }),
        callbacks: makeCallbacks({
          onPlannerReply: vi.fn().mockResolvedValue(plainUserMessage('')),
          onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),
        }).callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
      },
      planner: makePlanner({ typedCall: typed.typedCall }),
      state: saved,
      feature: 'greet people',
    });

    expect(typed.prompts).toHaveLength(2);
    expect(typed.prompts[0]).toContain('Greet in Polish');
    expect(typed.prompts[1]).toContain('Greet in Polish');
  });

  async function continuePlanning(
    first: { projectDir: string; sessionId: string },
    script: Array<PlanResult | string | Error>,
    steer?: ReturnType<typeof plainUserMessage>,
  ) {
    const saved = loadState(first);
    if (saved === null) throw new Error('state not saved');
    const holder = await resumeContinuation({ ref: first, state: saved, steer });
    let state = saved.pendingRecovery
      ? transition(saved, { type: 'RESOLVE_PENDING_RECOVERY' })
      : saved;
    if (state.interruptedStep !== undefined) state = transition(state, { type: 'RESUME_STEP' });
    saveState(first, state);
    const typed = scriptedTypedCall(script);
    const result = await runPlanningPhase({
      wctx: {
        projectDir: first.projectDir,
        sessionId: first.sessionId,
        config: makeConfig({ codebase: { enabled: false, tokenBudget: 4000 } }),
        callbacks: makeCallbacks({
          onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),
        }).callbacks,
        bus: makeBusRecorder().bus,
        metadata: TEST_METADATA,
        sinks: TEST_SINKS,
        continuation: holder,
      },
      planner: makePlanner({ typedCall: typed.typedCall }),
      state,
      feature: 'greet people',
      ...(state.rewindPending !== undefined && { rewindPending: state.rewindPending }),
    });
    return { result, prompts: typed.prompts };
  }

  const reviseOnce = () =>
    vi.fn().mockResolvedValueOnce({
      approved: false,
      action: 'revise',
      message: plainUserMessage('Greet in Polish'),
    });

  it('keeps the correction and the plan it corrects when its replan halts and the run continues', async () => {
    const first = await plan({
      script: [makePlanProposal(), 'not json', 'still not json'],
      callbacks: { onApprovalNeeded: reviseOnce() },
    });
    expect(first.result.state.pendingRecovery?.reason).toBe('seat-protocol-error');

    const next = await continuePlanning(first, [
      makePlanProposal({ summary: 'Greet people in Polish' }),
    ]);

    expect(next.prompts[0]).toContain('Greet in Polish');
    expect(next.prompts[0]).toContain('"summary": "Greet people by name"');
    expect(next.result.disposition).toBe('ready-for-tasks');
    expect(loadState(first)?.rewindPending).toBeUndefined();
  });

  it('hands a steer to the replan a stop cut mid-call', async () => {
    const first = await plan({
      script: [makePlanProposal(), 'not json', 'still not json'],
      callbacks: { onApprovalNeeded: reviseOnce() },
    });
    const halted = loadState(first);
    if (halted === null) throw new Error('state not saved');
    saveState(
      first,
      transition(transition(halted, { type: 'RESOLVE_PENDING_RECOVERY' }), {
        type: 'INTERRUPT_STEP',
        step: { kind: 'planner', call: 'plan' },
        source: 'user',
        cut: 'mid-step',
      }),
    );

    const message = attachedMessage(first.projectDir);
    const next = await continuePlanning(first, [makePlanProposal()], message);

    expect(next.prompts[0]).toContain(message.text);
    expect(next.prompts[0]).toContain('Greet in Polish');
  });

  it('sends only the correction to a planner that keeps its session', async () => {
    const onApprovalNeeded = vi
      .fn()
      .mockResolvedValueOnce({
        approved: false,
        action: 'revise',
        message: plainUserMessage('Greet in Polish'),
      })
      .mockResolvedValue({ approved: true });
    const run = await plan({
      script: [makePlanProposal(), makePlanProposal({ summary: 'Greet people in Polish' })],
      callbacks: { onApprovalNeeded },
      planner: {
        capabilities: { ...makePlanner().capabilities, supportsSessionResume: true },
      },
      state: (state) => ({ ...state, plannerSessionId: 'native-1' }),
    });

    expect(run.prompts[1]).toContain('Greet in Polish');
    expect(run.prompts[1]).toContain('"summary": "Greet people by name"');
    expect(run.prompts[1]).not.toContain('# Plan the change');
    expect(run.result.disposition).toBe('ready-for-tasks');
  });

  const editPlanJson = (text: string) => async (_type: string, input: string) => {
    writeFileSync(join(dirname(input), PLAN_JSON_FILE), text);
    return { approved: false, action: 'edit' };
  };

  it('compiles a valid edit of plan.json and shows the card again without a planner call', async () => {
    const edited = makePlanProposal({
      summary: 'Edited by hand',
      tasks: [makeTaskSpec({ suggestedFiles: ['src/greet.ts'] })],
    });
    const onApprovalNeeded = vi
      .fn()
      .mockImplementationOnce(editPlanJson(JSON.stringify(edited)))
      .mockResolvedValue({ approved: true });
    const run = await plan({ script: [makePlanProposal()], callbacks: { onApprovalNeeded } });

    expect(run.prompts).toHaveLength(1);
    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(run.result.disposition).toBe('ready-for-tasks');
    expect(run.result.state.plan?.summary).toBe('Edited by hand');
    expect(run.result.state.tasks.map((task) => task.suggestedFiles[0])).toEqual(['src/greet.ts']);
    expect(
      readFileSync(join(sessionDir(run.projectDir, run.sessionId), 'plan.md'), 'utf8'),
    ).toContain('Edited by hand');
  });

  it('compiles an edit that adds a render check with no render command and names it on the card', async () => {
    const edited = makePlanProposal({
      summary: 'Edited by hand',
      checks: [{ id: 'K-render', kind: 'render', value: 'overlay-picker', required: true }],
      criteria: [{ id: 'C1', text: 'A name gets a greeting', checkIds: ['K1', 'K-render'] }],
    });
    const onApprovalNeeded = vi
      .fn()
      .mockImplementationOnce(editPlanJson(JSON.stringify(edited)))
      .mockResolvedValue({ approved: true });
    const run = await plan({ script: [makePlanProposal()], callbacks: { onApprovalNeeded } });

    expect(run.prompts).toHaveLength(1);
    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(run.result.state.plan?.checks.map((check) => check.id)).toEqual(['K-render']);
    expect(
      run.events.filter(
        (event) => event.type === 'warning' && event.message.startsWith('The edited plan'),
      ),
    ).toEqual([]);
    const card = readFileSync(join(sessionDir(run.projectDir, run.sessionId), 'plan.md'), 'utf8');
    expect(card).toContain('## Before you approve');
    expect(card).toContain('Render check K-render needs validation.render');
  });

  it.each([
    ['text that is not JSON', '{ "summary": '],
    ['a plan that fails its checks', JSON.stringify(uncoveredPlan)],
  ])(
    'restores plan.json after an edit to %s and names the errors in one warning',
    async (_label, text) => {
      const onApprovalNeeded = vi
        .fn()
        .mockImplementationOnce(editPlanJson(text))
        .mockResolvedValue({ approved: true });
      const run = await plan({ script: [makePlanProposal()], callbacks: { onApprovalNeeded } });

      const warnings = run.events.filter(
        (event) => event.type === 'warning' && event.message.startsWith('The edited plan'),
      );
      expect(warnings).toHaveLength(1);
      expect(JSON.stringify(warnings)).not.toContain('uncovered-criterion');
      expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
      expect(parsePlanJson(readSpecFileOrEmpty(run, PLAN_JSON_FILE))).toEqual({
        plan: makePlanProposal(),
      });
      expect(run.result.state.plan?.summary).toBe('Greet people by name');
      expect(run.result.disposition).toBe('ready-for-tasks');
    },
  );

  it('turns a message still queued at the card into a correction', async () => {
    let projectDir = '';
    const onApprovalNeeded = vi
      .fn()
      .mockImplementationOnce(async () => {
        const ref = { projectDir, sessionId: 'sess-planning' };
        const saved = loadState(ref);
        if (saved === null) throw new Error('state not saved');
        enqueueUserMessage({
          ...ref,
          state: saved,
          message: plainUserMessage('Also greet by surname'),
          // Queued during the last planner call, after that call drained the queue.
          phase: 'planning',
          bus: makeBusRecorder().bus,
        });
        return { approved: false };
      })
      .mockResolvedValue({ approved: true });
    const run = await plan({
      script: [makePlanProposal(), makePlanProposal({ summary: 'Greet by full name' })],
      callbacks: { onApprovalNeeded },
      setup: (dir) => {
        projectDir = dir;
      },
    });

    expect(run.prompts).toHaveLength(2);
    expect(run.prompts[1]).toContain('Also greet by surname');
    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(run.result.state.plan?.summary).toBe('Greet by full name');
  });

  it('closes the run on End run', async () => {
    const run = await plan({
      script: [makePlanProposal()],
      callbacks: {
        onApprovalNeeded: vi.fn().mockResolvedValue({ approved: false, action: 'end-run' }),
      },
    });

    expect(run.result).toMatchObject({ disposition: 'terminal', outcome: 'closed' });
  });

  it('asks again on a superseded prompt', async () => {
    const onApprovalNeeded = vi
      .fn()
      .mockResolvedValueOnce({ approved: false })
      .mockResolvedValue({ approved: true });
    const run = await plan({ script: [makePlanProposal()], callbacks: { onApprovalNeeded } });

    expect(onApprovalNeeded).toHaveBeenCalledTimes(2);
    expect(run.prompts).toHaveLength(1);
    expect(run.result.disposition).toBe('ready-for-tasks');
  });

  const protectedPlan = makePlanProposal({
    tasks: [makeTaskSpec({ protectedOperations: [{ path: 'package.json', operation: 'write' }] })],
  });

  it('confirms the protected operations of a plan the operator approved', async () => {
    const run = await plan({ script: [protectedPlan] });

    expect(readEvidenceLedger(run)?.approvals).toEqual([
      expect.objectContaining({
        tier: 'confirm',
        actionClass: 'package_change',
        actionDescription: 'write package.json',
      }),
    ]);
  });

  it('shows the card exactly what approving it confirms, whatever plan.json now says', async () => {
    const onApprovalNeeded = vi.fn(async (_type: string, input: unknown) => {
      if (typeof input !== 'string') throw new Error('expected the plan card path');
      writeFileSync(join(dirname(input), PLAN_JSON_FILE), JSON.stringify(makePlanProposal()));
      return { approved: true as const };
    });
    const run = await plan({ script: [protectedPlan], callbacks: { onApprovalNeeded } });

    expect(onApprovalNeeded).toHaveBeenCalledWith('plan', expect.any(String), [
      'write package.json',
    ]);
    expect(
      readEvidenceLedger(run)?.approvals?.map((approval) => approval.actionDescription),
    ).toEqual(['write package.json']);
  });

  it('confirms nothing when nobody looked at the plan', async () => {
    const run = await plan({
      script: [protectedPlan],
      callbacks: {
        onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true, unattended: true }),
      },
    });

    expect(run.result.disposition).toBe('ready-for-tasks');
    expect(readEvidenceLedger(run)?.approvals ?? []).toEqual([]);
  });

  it('skips the card at approve: none and still asks for a listed protected write', async () => {
    const config = makeConfig({
      codebase: { enabled: false, tokenBudget: 4000 },
      workflow: { approve: 'none' },
    });
    const run = await plan({ script: [protectedPlan], config });

    expect(run.prompts).toHaveLength(1);
    expect(run.onApprovalNeeded).not.toHaveBeenCalled();
    expect(run.result.state.phase).toBe('implementing');
    expect(readEvidenceLedger(run)?.approvals ?? []).toEqual([]);

    const task = run.result.state.tasks[0];
    if (task === undefined) throw new Error('expected the plan to compile a task');
    const asked: string[] = [];
    const gated = await gateChangedFiles({
      changedFiles: ['package.json'],
      task,
      dependsOnFiles: [],
      projectDir: run.projectDir,
      sessionId: run.sessionId,
      phase: 'implementing',
      taskId: task.id,
      bus: makeBusRecorder().bus,
      callbacks: makeCallbacks({
        onTieredApproval: async (request) => {
          asked.push(request.actionDescription);
          return { decision: 'deny', reason: 'no' };
        },
      }).callbacks,
      config,
    });

    expect(asked).toEqual(['write package.json']);
    expect(gated.allow).toBe(false);
  });
});
