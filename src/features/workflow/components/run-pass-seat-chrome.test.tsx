import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { configStore } from '../../../stores/project/config.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { markCancellationRequested } from '../../../stores/workflow/actions/interrupt.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { runSeatIdentity } from '../../../core/providers/seat-identity.js';
import { seatAxisWords } from '../../../core/runners/effort-channel.js';
import { taskId } from '../../../core/schemas/task.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import type { RunnerConfig } from '../../../core/config/accessors/runner-config.js';
import type { Config } from '../../../core/schemas/config.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { PLANNER_INHERITANCE } from '../../../core/crew/identity.js';
import { buildPromptCallbacks } from '../prompt-callbacks.js';
import { requestSteer, resumeParkedRun } from '../handlers.js';
import { Header } from './header.js';
import { Sidebar } from './sidebar.js';

type Overrides = NonNullable<Parameters<typeof makeConfig>[0]>;
/** A crew; `reviewer: null` is a crew whose planner holds the review seat. */
type Crew = Omit<Overrides, 'reviewer'> & { reviewer?: Overrides['reviewer'] | null };

const CLAUDE = { kind: 'cli' as const, tool: 'claude-code' as const, model: 'claude-3-5-sonnet' };
const CODEX = { kind: 'cli' as const, tool: 'codex' as const, model: 'gpt-5-codex' };

/** Each kind of PLAN save: the seat the run pass holds, then the seat the user saves. */
const PLAN_SAVES: readonly { save: string; pass: RunnerConfig; saved: RunnerConfig }[] = [
  { save: 'tool change', pass: CODEX, saved: CLAUDE },
  { save: 'model-only', pass: { ...CLAUDE, model: 'claude-3-opus' }, saved: CLAUDE },
  {
    save: 'effort-only',
    pass: { ...CLAUDE, effort: 'high' },
    saved: { ...CLAUDE, effort: 'low' },
  },
  {
    save: 'api pass seat',
    pass: {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'llama3',
    },
    saved: CLAUDE,
  },
  {
    save: 'shell pass seat',
    pass: { kind: 'shell', command: './plan.sh', model: 'auto' },
    saved: CLAUDE,
  },
];

function crewConfig(crew: Crew): Config {
  const { reviewer = CLAUDE, ...seats } = crew;
  return makeConfig({
    planner: CLAUDE,
    implementer: CLAUDE,
    ...seats,
    ...(reviewer !== null && { reviewer }),
  });
}

function save(crew: Crew): void {
  configStore.__testReset({ projectDir: '/tmp/project', config: crewConfig(crew) });
}

/** The run pass the engine announces, from the same identity it prices the run with. */
function passConfig(ts: number, phase: string, config: Config): EngineEvent {
  return {
    type: 'workflow_config',
    ts,
    phase,
    ...runSeatIdentity(config),
  } as unknown as EngineEvent;
}

function recordedName(runner: RunnerConfig): string {
  switch (runner.kind) {
    case 'cli':
      return runner.tool;
    case 'api':
      return runner.provider;
    default:
      return runner.command;
  }
}

function call(
  type: 'runner_call_started' | 'runner_call_completed',
  callId: string,
  ts: number,
  role: string,
  phase: string,
  runner: RunnerConfig,
  extra: object = {},
): EngineEvent {
  return {
    type,
    ts,
    phase,
    callId,
    role,
    backendKind: runner.kind,
    runnerName: recordedName(runner),
    model: 'model' in runner ? runner.model : undefined,
    axes: seatAxisWords(runner),
    attempt: 0,
    ...(type === 'runner_call_completed' && {
      startedAt: ts - 100,
      endedAt: ts,
      durationMs: 100,
      usage: null,
      nativeSessionId: null,
    }),
    ...extra,
  } as unknown as EngineEvent;
}

function plannerStatus(ts: number, phase: string, runner: RunnerConfig): EngineEvent {
  return {
    type: 'planner_status',
    ts,
    phase,
    status: 'running',
    tool: recordedName(runner),
    model: 'model' in runner ? runner.model : undefined,
  } as EngineEvent;
}

function taskStarted(
  ts: number,
  id: string,
  runner: RunnerConfig,
  extra: object = {},
): EngineEvent {
  return {
    type: 'task_started',
    ts,
    phase: 'implementing',
    taskId: id,
    title: id,
    index: 0,
    total: 2,
    file: 'a.ts',
    action: 'modify',
    tool: recordedName(runner),
    model: 'model' in runner ? runner.model : undefined,
    axes: seatAxisWords(runner),
    backendKind: runner.kind,
    lineageAttempt: 1,
    attemptAllowance: 8,
    ...extra,
  } as unknown as EngineEvent;
}

const TASKS_PLANNED = {
  type: 'tasks_planned',
  ts: 6_100,
  phase: 'planning',
  tasks: [
    { id: 'T001', title: 'A', index: 0, file: 'a.ts', action: 'modify' },
    { id: 'T002', title: 'B', index: 1, file: 'b.ts', action: 'modify' },
  ],
  total: 2,
} as unknown as EngineEvent;

async function frames(): Promise<{ header: string; sidebar: string }> {
  terminalSizeStore.__testReset({ cols: 160, rows: 24, isSmall: false });
  const header = renderFeature(<Header />);
  await tick();
  const headerText = stripAnsiStyles(header.lastFrame() ?? '');
  header.unmount();
  const sidebar = renderFeature(<Sidebar width={50} />);
  await tick();
  const sidebarText = stripAnsiStyles(sidebar.lastFrame() ?? '');
  sidebar.unmount();
  return { header: headerText, sidebar: sidebarText };
}

type Frames = Awaited<ReturnType<typeof frames>>;

/** The chrome a crew of `seen` gets in this exact state, read back with `saved` as the saved crew. */
async function chromeWith(saved: Crew, seen: Crew): Promise<{ actual: Frames; expected: Frames }> {
  save(seen);
  const expected = await frames();
  save(saved);
  const actual = await frames();
  return { actual, expected };
}

function seatRow(frame: string, label: string): string {
  return frame
    .split('\n')
    .filter((line) => line.includes(label))
    .join(' ');
}

/** The seat words of a frame pair: the seat half of the header line and the sidebar seat rows. */
function seatWords(frame: Frames): { header: string; sidebar: string[] } {
  const line = frame.header.split('\n').find((l) => l.includes('PLAN ')) ?? '';
  return {
    header: line.slice(line.indexOf('PLAN ')).trim(),
    sidebar: ['PLAN', 'BUILD', 'REVIEW'].map((label) => seatRow(frame.sidebar, label)),
  };
}

/** The seat words the saved crew alone reads, with no run pass, brief or call. Ends the test state. */
async function savedSeatWords(saved: Crew): Promise<ReturnType<typeof seatWords>> {
  resetAllStores();
  hydrateCatalog();
  save(saved);
  addEvent({ type: 'workflow_started', ts: 800, phase: 'planning', feature: 'f' } as EngineEvent);
  return seatWords(await frames());
}

function hydrateCatalog(): void {
  modelCacheStore.reset();
  modelCacheStore.hydrateDetection({
    providers: [],
    cliTools: [],
    fetchedAt: 1,
    validatedAt: 1,
    generation: 0,
    requestId: 0,
    contexts: { readiness: 'readiness', modelsDev: 'catalog', cliModels: 'tools' },
    cliCatalogs: [
      { tool: 'codex', probedAt: 1, models: [{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex' }] },
      {
        tool: 'claude-code',
        probedAt: 1,
        models: [
          { id: 'claude-3-5-sonnet', displayName: 'Claude 3.5 Sonnet' },
          { id: 'claude-3-opus', displayName: 'Claude 3 Opus' },
        ],
      },
    ],
  });
}

beforeEach(() => {
  resetAllStores();
  hydrateCatalog();
});

afterEach(() => resetAllStores());

describe.each(PLAN_SAVES)('PLAN saved during the run ($save)', ({ pass, saved }) => {
  const passCrew: Crew = { planner: pass };
  const savedCrew: Crew = { planner: saved };

  function startPlanning(): void {
    save(passCrew);
    addEvent({ type: 'workflow_started', ts: 800, phase: 'planning', feature: 'f' } as EngineEvent);
    addEvent(plannerStatus(805, 'planning', pass));
    addEvent(passConfig(810, 'planning', crewConfig(passCrew)));
    save(savedCrew);
  }

  function planUntilCard(): void {
    startPlanning();
    addEvent(call('runner_call_started', 'p-1', 1_000, 'planner', 'planning', pass));
    addEvent(call('runner_call_completed', 'p-1', 2_000, 'planner', 'planning', pass));
    addEvent(TASKS_PLANNED);
    addEvent(plannerStatus(6_200, 'reviewing-plan', pass));
  }

  function startFirstBrief(): void {
    planUntilCard();
    addEvent({ type: 'plan_approved', ts: 7_000, phase: 'reviewing-plan' } as EngineEvent);
    addEvent(taskStarted(7_100, 'T001', CLAUDE));
    addEvent(
      call('runner_call_started', 'b-1', 7_200, 'implementer', 'implementing', CLAUDE, {
        taskId: 'T001',
      }),
    );
  }

  it('the status before call 1 names the run pass seat', async () => {
    startPlanning();
    const { actual, expected } = await chromeWith(savedCrew, passCrew);
    expect(actual).toEqual(expected);
  });

  it('a planner call names the run pass seat', async () => {
    startPlanning();
    addEvent(call('runner_call_started', 'p-1', 1_000, 'planner', 'planning', pass));
    const { actual, expected } = await chromeWith(savedCrew, passCrew);
    expect(actual).toEqual(expected);
  });

  it.each([1, 2])('the question wait of round %i names the run pass seat', async (round) => {
    startPlanning();
    for (let i = 1; i <= round; i += 1) {
      addEvent(call('runner_call_started', `p-${i}`, i * 1_000, 'planner', 'planning', pass));
      addEvent(
        call('runner_call_completed', `p-${i}`, i * 1_000 + 500, 'planner', 'planning', pass),
      );
      addEvent({
        type: 'planner_text',
        ts: i * 1_000 + 600,
        phase: 'planning',
        text: `Questions before the plan · round ${i} of 2`,
        role: 'planner',
        content: 'plain',
      } as EngineEvent);
    }
    const { actual, expected } = await chromeWith(savedCrew, passCrew);
    expect(actual).toEqual(expected);
  });

  it('the plan checks and the repair gap name the run pass seat', async () => {
    startPlanning();
    addEvent(call('runner_call_started', 'p-1', 1_000, 'planner', 'planning', pass));
    addEvent(call('runner_call_completed', 'p-1', 2_000, 'planner', 'planning', pass));
    addEvent({
      type: 'warning',
      ts: 2_100,
      phase: 'planning',
      message: 'The plan failed its checks; the planner repairs it once.',
    } as EngineEvent);
    const { actual, expected } = await chromeWith(savedCrew, passCrew);
    expect(actual).toEqual(expected);
  });

  it('the plan card names the run pass seat', async () => {
    planUntilCard();
    const { actual, expected } = await chromeWith(savedCrew, passCrew);
    expect(actual).toEqual(expected);
  });

  it('the plan card after an edit of plan.json names the run pass seat', async () => {
    planUntilCard();
    addEvent({
      type: 'plan_regenerated',
      ts: 6_500,
      phase: 'reviewing-plan',
      comment: '(edited plan.json)',
    } as EngineEvent);
    const { actual, expected } = await chromeWith(savedCrew, passCrew);
    expect(actual).toEqual(expected);
  });

  it('a Request changes call names the run pass seat', async () => {
    planUntilCard();
    addEvent(call('runner_call_started', 'p-9', 6_600, 'planner', 'reviewing-plan', pass));
    const { actual, expected } = await chromeWith(savedCrew, passCrew);
    expect(actual).toEqual(expected);
  });

  it('the first brief, with PLAN idle, names the run pass seat', async () => {
    startFirstBrief();
    const { actual, expected } = await chromeWith(savedCrew, passCrew);
    expect(actual).toEqual(expected);
  });

  it('a consult call inside the first brief names the run pass seat', async () => {
    startFirstBrief();
    addEvent(
      call('runner_call_completed', 'b-1', 8_000, 'implementer', 'implementing', CLAUDE, {
        taskId: 'T001',
      }),
    );
    addEvent(
      call('runner_call_started', 'e-1', 8_100, 'escalation', 'escalating', pass, {
        taskId: 'T001',
      }),
    );
    const { actual, expected } = await chromeWith(savedCrew, passCrew);
    expect(actual).toEqual(expected);
  });

  it('the next run pass after the brief names its own seat, the one saved', async () => {
    startFirstBrief();
    addEvent(
      call('runner_call_completed', 'b-1', 8_000, 'implementer', 'implementing', CLAUDE, {
        taskId: 'T001',
      }),
    );
    addEvent({
      type: 'task_completed',
      ts: 8_500,
      phase: 'implementing',
      taskId: 'T001',
      title: 'T001',
      method: 'local',
    } as unknown as EngineEvent);
    addEvent({ type: 'workflow_resumed', ts: 9_000, phase: 'implementing' } as EngineEvent);
    addEvent(passConfig(9_010, 'implementing', crewConfig(savedCrew)));
    const { actual, expected } = await chromeWith(savedCrew, passCrew);
    expect(expected).toEqual(actual);
  });

  it('a stop names the saved seat', async () => {
    planUntilCard();
    markCancellationRequested();
    const { actual } = await chromeWith(savedCrew, passCrew);
    expect(seatWords(actual)).toEqual(await savedSeatWords(savedCrew));
  });

  it('a halt names the saved seat', async () => {
    planUntilCard();
    recoveryNoticeStore.open({
      seat: null,
      resetAt: null,
      issue: makeRecoveryIssue({ seat: 'plan' }),
      at: { kind: 'planner', call: 'plan' },
    });
    const { actual } = await chromeWith(savedCrew, passCrew);
    expect(seatWords(actual)).toEqual(await savedSeatWords(savedCrew));
  });

  it('a run at rest after a stop names the saved seat', async () => {
    planUntilCard();
    // The run loop ended on the stop: the screen marks the run paused and parks it with no resolver.
    lifecycleStore.__testReset({ ...lifecycleStore.get(), status: 'paused' });
    stopStore.park('mid-brief', null, null);
    const { actual } = await chromeWith(savedCrew, passCrew);
    expect(seatWords(actual)).toEqual(await savedSeatWords(savedCrew));
  });
});

describe('BUILD saved during planning', () => {
  const passCrew: Crew = { implementer: CODEX };
  const savedCrew: Crew = {};

  function startPlanning(): void {
    save(passCrew);
    addEvent({ type: 'workflow_started', ts: 800, phase: 'planning', feature: 'f' } as EngineEvent);
    addEvent(passConfig(810, 'planning', crewConfig(passCrew)));
    addEvent(call('runner_call_started', 'p-1', 1_000, 'planner', 'planning', CLAUDE));
    save(savedCrew);
  }

  it('a planner call names the run pass BUILD seat', async () => {
    startPlanning();
    const { actual, expected } = await chromeWith(savedCrew, passCrew);
    expect(actual).toEqual(expected);
  });

  it('the gap between planner calls names the run pass BUILD seat', async () => {
    startPlanning();
    addEvent(call('runner_call_completed', 'p-1', 2_000, 'planner', 'planning', CLAUDE));
    const { actual, expected } = await chromeWith(savedCrew, passCrew);
    expect(actual).toEqual(expected);
  });

  it('the plan card names the run pass BUILD seat', async () => {
    startPlanning();
    addEvent(call('runner_call_completed', 'p-1', 2_000, 'planner', 'planning', CLAUDE));
    addEvent(TASKS_PLANNED);
    addEvent(plannerStatus(6_200, 'reviewing-plan', CLAUDE));
    const { actual, expected } = await chromeWith(savedCrew, passCrew);
    expect(actual).toEqual(expected);
  });

  it('brief 1 on the run pass seat names it without a flip', async () => {
    startPlanning();
    addEvent(call('runner_call_completed', 'p-1', 2_000, 'planner', 'planning', CLAUDE));
    addEvent(TASKS_PLANNED);
    addEvent({ type: 'plan_approved', ts: 7_000, phase: 'reviewing-plan' } as EngineEvent);
    addEvent(taskStarted(7_100, 'T001', CODEX));
    const { actual, expected } = await chromeWith(savedCrew, passCrew);
    expect(actual).toEqual(expected);
  });

  it('a brief that profile routing puts on another profile names that profile seat', async () => {
    startPlanning();
    addEvent(call('runner_call_completed', 'p-1', 2_000, 'planner', 'planning', CLAUDE));
    addEvent(TASKS_PLANNED);
    addEvent({ type: 'plan_approved', ts: 7_000, phase: 'reviewing-plan' } as EngineEvent);
    const routed = { ...CLAUDE, model: 'claude-3-opus' };
    addEvent(taskStarted(7_100, 'T001', routed, { implementerProfile: 'large' }));
    const { actual } = await chromeWith(savedCrew, passCrew);
    const { actual: onRouted } = await chromeWith(savedCrew, { implementer: routed });
    expect(actual).toEqual(onRouted);
  });
});

describe('REVIEW while it is idle', () => {
  it('follows PLAN as = PLAN on both surfaces when PLAN is saved during planning', async () => {
    const passCrew: Crew = { planner: CODEX, reviewer: null };
    const savedCrew: Crew = { planner: CLAUDE, reviewer: null };
    save(passCrew);
    addEvent({ type: 'workflow_started', ts: 800, phase: 'planning', feature: 'f' } as EngineEvent);
    addEvent(passConfig(810, 'planning', crewConfig(passCrew)));
    save(savedCrew);

    const { actual, expected } = await chromeWith(savedCrew, passCrew);
    expect(actual).toEqual(expected);
    expect(seatRow(actual.header, 'REVIEW')).toContain(`REVIEW ${PLANNER_INHERITANCE.mark}`);
    expect(seatRow(actual.sidebar, 'REVIEW')).toContain(PLANNER_INHERITANCE.mark);
  });

  it('names the run pass REVIEW seat when its own seat is saved before its first call', async () => {
    const passCrew: Crew = { reviewer: CODEX };
    const savedCrew: Crew = { reviewer: CLAUDE };
    save(passCrew);
    addEvent({ type: 'workflow_started', ts: 800, phase: 'planning', feature: 'f' } as EngineEvent);
    addEvent(passConfig(810, 'planning', crewConfig(passCrew)));
    save(savedCrew);

    const { actual, expected } = await chromeWith(savedCrew, passCrew);
    expect(actual).toEqual(expected);
  });

  it('names the run pass planner when the pass had no REVIEW seat and one is saved', async () => {
    const passCrew: Crew = { planner: CODEX, reviewer: null };
    save(passCrew);
    addEvent({ type: 'workflow_started', ts: 800, phase: 'planning', feature: 'f' } as EngineEvent);
    addEvent(passConfig(810, 'planning', crewConfig(passCrew)));
    save({ planner: CODEX, reviewer: CLAUDE });

    const { sidebar } = await frames();
    expect(seatRow(sidebar, 'REVIEW')).toContain('OpenAI Codex CLI');
  });
});

describe('a log written before run pass seats were kept', () => {
  it('names the saved seat while the run is live', async () => {
    save({ planner: CODEX });
    addEvent({ type: 'workflow_started', ts: 800, phase: 'planning', feature: 'f' } as EngineEvent);
    addEvent({
      type: 'workflow_config',
      ts: 810,
      phase: 'planning',
      plannerTool: 'codex',
      plannerModel: 'gpt-5-codex',
      implementerTool: 'claude-code',
      implementerModel: 'claude-3-5-sonnet',
      reviewerTool: 'claude-code',
      reviewerModel: 'claude-3-5-sonnet',
    } as EngineEvent);
    save({});

    expect(seatRow((await frames()).sidebar, 'PLAN')).toContain('Claude Code CLI');
  });
});

it('a halt on the brief names the saved BUILD seat over the run pass seat', async () => {
  save({ implementer: CODEX });
  addEvent({
    type: 'workflow_started',
    ts: 800,
    phase: 'implementing',
    feature: 'f',
  } as EngineEvent);
  addEvent(passConfig(810, 'implementing', crewConfig({ implementer: CODEX })));
  save({});
  recoveryNoticeStore.open({
    seat: null,
    resetAt: null,
    issue: makeRecoveryIssue({ taskId: taskId('T001') }),
    at: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
  });

  expect(seatRow((await frames()).sidebar, 'BUILD')).toContain('Claude Code CLI');
});

describe('a stop inside a call', () => {
  const OLLAMA = {
    kind: 'api' as const,
    provider: 'ollama',
    service: 'ollama' as const,
    offering: 'local' as const,
    apiBase: 'http://localhost:11434/v1',
    model: 'llama3',
  };
  const CUT_KINDS = [
    { kind: 'cli', runner: CODEX },
    { kind: 'api', runner: OLLAMA },
    { kind: 'shell', runner: { kind: 'shell' as const, command: './impl.sh', model: 'auto' } },
    { kind: 'agent', runner: { kind: 'agent' as const, command: './agent.sh', model: 'auto' } },
  ];

  /** The run is planned and approved; brief T001 runs its call on `runner`. */
  function runBrief(pass: Crew, runner: RunnerConfig, route: object = {}): void {
    save(pass);
    addEvent({ type: 'workflow_started', ts: 800, phase: 'planning', feature: 'f' } as EngineEvent);
    addEvent(passConfig(810, 'planning', crewConfig(pass)));
    addEvent(TASKS_PLANNED);
    addEvent({ type: 'plan_approved', ts: 7_000, phase: 'reviewing-plan' } as EngineEvent);
    addEvent(taskStarted(7_100, 'T001', runner, route));
    addEvent(
      call('runner_call_started', 'b-1', 7_200, 'implementer', 'implementing', runner, {
        taskId: 'T001',
      }),
    );
  }

  /** The engine cuts the running call and the screen parks the run on it, as Esc Esc does. */
  function stopInside(
    step: object,
    source: 'user' | 'watchdog' = 'user',
  ): Promise<unknown> | undefined {
    if (source === 'user') stopStore.request('stop-now');
    addEvent({
      type: 'turn_interrupted',
      ts: 7_500,
      phase: lifecycleStore.get().phase,
      source,
      at: 'mid-step',
      step,
    } as unknown as EngineEvent);
    return buildPromptCallbacks({
      inputMode: {} as never,
      abortedRef: { current: false },
      controller: new AbortController(),
    }).onContinuationNeeded?.('', 'mid-step', []);
  }

  const BRIEF_STEP = { kind: 'brief', taskId: 'T001', attempt: 0 };

  describe.each(CUT_KINDS)('the cut brief runs on a $kind seat', ({ runner }) => {
    it('names the cut seat while parked, BUILD saved before the stop', async () => {
      runBrief({ implementer: runner }, runner);
      save({});
      void stopInside(BRIEF_STEP);
      const { actual, expected } = await chromeWith({}, { implementer: runner });
      expect(actual).toEqual(expected);
    });
  });

  it('names a named profile seat while parked, with no save', async () => {
    runBrief({}, CODEX, { implementerProfile: 'large' });
    void stopInside(BRIEF_STEP);
    const { actual, expected } = await chromeWith({}, { implementer: CODEX });
    expect(actual).toEqual(expected);
  });

  it('names the retry profile seat of a later attempt while parked', async () => {
    runBrief({}, CLAUDE);
    addEvent(
      call('runner_call_completed', 'b-1', 7_300, 'implementer', 'implementing', CLAUDE, {
        taskId: 'T001',
      }),
    );
    addEvent(
      taskStarted(7_400, 'T001', CODEX, { implementerProfile: 'bigger', lineageAttempt: 2 }),
    );
    addEvent(
      call('runner_call_started', 'b-2', 7_450, 'implementer', 'implementing', CODEX, {
        taskId: 'T001',
      }),
    );
    void stopInside({ ...BRIEF_STEP, attempt: 1 });
    const { actual, expected } = await chromeWith({}, { implementer: CODEX });
    expect(actual).toEqual(expected);
  });

  it.each([
    { round: 'question round 1', rounds: 0, call: 'clarify' },
    { round: 'question round 2', rounds: 1, call: 'clarify' },
    { round: 'plan round', rounds: 2, call: 'plan' },
  ])('names the run pass PLAN seat while parked in the $round', async ({ rounds, call: step }) => {
    save({ planner: CODEX });
    addEvent({ type: 'workflow_started', ts: 800, phase: 'planning', feature: 'f' } as EngineEvent);
    addEvent(passConfig(810, 'planning', crewConfig({ planner: CODEX })));
    for (let i = 1; i <= rounds; i += 1) {
      addEvent(call('runner_call_started', `p-${i}`, i * 1_000, 'planner', 'planning', CODEX));
      addEvent(
        call('runner_call_completed', `p-${i}`, i * 1_000 + 500, 'planner', 'planning', CODEX),
      );
    }
    addEvent(call('runner_call_started', 'p-9', 5_000, 'planner', 'planning', CODEX));
    save({});
    void stopInside({ kind: 'planner', call: step });
    const { actual, expected } = await chromeWith({}, { planner: CODEX });
    expect(actual).toEqual(expected);
  });

  it('names the run pass REVIEW seat while parked in the final review call', async () => {
    save({ reviewer: CODEX });
    addEvent({
      type: 'workflow_started',
      ts: 800,
      phase: 'final-review',
      feature: 'f',
    } as EngineEvent);
    addEvent(passConfig(810, 'final-review', crewConfig({ reviewer: CODEX })));
    addEvent(call('runner_call_started', 'r-1', 1_000, 'review', 'final-review', CODEX));
    save({});
    void stopInside({ kind: 'review', cycle: 0 });
    const { actual, expected } = await chromeWith({}, { reviewer: CODEX });
    expect(actual).toEqual(expected);
  });

  it('names the cut seat while the idle watchdog parks the brief', async () => {
    runBrief({ implementer: CODEX }, CODEX);
    save({});
    void stopInside(BRIEF_STEP, 'watchdog');
    const { actual, expected } = await chromeWith({}, { implementer: CODEX });
    expect(actual).toEqual(expected);
  });

  it('names the cut seat after an interrupt that has not parked yet', async () => {
    runBrief({ implementer: CODEX }, CODEX);
    save({});
    addEvent({
      type: 'turn_interrupted',
      ts: 7_500,
      phase: 'implementing',
      source: 'user',
      at: 'mid-step',
      step: BRIEF_STEP,
    } as unknown as EngineEvent);
    const { actual, expected } = await chromeWith({}, { implementer: CODEX });
    expect(actual).toEqual(expected);
  });

  it('names the saved seat at a boundary park', async () => {
    runBrief({ implementer: CODEX }, CODEX);
    addEvent(
      call('runner_call_completed', 'b-1', 7_300, 'implementer', 'implementing', CODEX, {
        taskId: 'T001',
      }),
    );
    addEvent({
      type: 'task_completed',
      ts: 7_400,
      phase: 'implementing',
      taskId: 'T001',
      title: 'T001',
      method: 'local',
    } as unknown as EngineEvent);
    save({});
    stopStore.request('pause-after-brief');
    void buildPromptCallbacks({
      inputMode: {} as never,
      abortedRef: { current: false },
      controller: new AbortController(),
    }).onContinuationNeeded?.('', 'boundary', []);
    const { actual } = await chromeWith({}, { implementer: CODEX });
    expect(seatWords(actual)).toEqual(await savedSeatWords({}));
  });

  it('names the cut seat when BUILD is saved during the park', async () => {
    runBrief({ implementer: CODEX }, CODEX);
    void stopInside(BRIEF_STEP);
    save({});
    const { actual, expected } = await chromeWith({}, { implementer: CODEX });
    expect(actual).toEqual(expected);
  });

  it('names the cut seat effort when only the effort is saved', async () => {
    const high = { ...CLAUDE, effort: 'high' as const };
    const low = { ...CLAUDE, effort: 'low' as const };
    runBrief({ implementer: high }, high);
    save({ implementer: low });
    void stopInside(BRIEF_STEP);
    const { actual, expected } = await chromeWith({ implementer: low }, { implementer: high });
    expect(actual).toEqual(expected);
  });

  it('names the cut seat when the seat is saved and then saved back during the park', async () => {
    runBrief({ implementer: CODEX }, CODEX);
    void stopInside(BRIEF_STEP);
    save({});
    save({ implementer: CODEX });
    const { actual, expected } = await chromeWith({ implementer: CODEX }, { implementer: CODEX });
    expect(actual).toEqual(expected);
    expect(seatRow(actual.sidebar, 'BUILD')).toContain('OpenAI Codex CLI');
  });

  it('names the run pass BUILD seat when BUILD is saved during a planner park', async () => {
    save({ implementer: CODEX });
    addEvent({ type: 'workflow_started', ts: 800, phase: 'planning', feature: 'f' } as EngineEvent);
    addEvent(passConfig(810, 'planning', crewConfig({ implementer: CODEX })));
    addEvent(call('runner_call_started', 'p-1', 1_000, 'planner', 'planning', CLAUDE));
    void stopInside({ kind: 'planner', call: 'plan' });
    save({});
    const { actual, expected } = await chromeWith({}, { implementer: CODEX });
    expect(actual).toEqual(expected);
  });

  it.each([
    { exit: 'a bare Resume', go: () => resumeParkedRun(plainUserMessage('')) },
    { exit: 'a Resume with a steer', go: () => resumeParkedRun(plainUserMessage('use zod')) },
    { exit: '/steer', go: () => requestSteer(plainUserMessage('use zod')) },
  ])(
    'names the cut seat after $exit, then the run pass seat, then the saved one',
    async ({ go }) => {
      runBrief({ implementer: CODEX }, CODEX);
      save({});
      const parked = stopInside(BRIEF_STEP);
      expect(go()).toBe(true);
      await parked;
      const resumed = await chromeWith({}, { implementer: CODEX });
      expect(resumed.actual).toEqual(resumed.expected);

      addEvent(
        call('runner_call_started', 'b-2', 8_000, 'implementer', 'implementing', CODEX, {
          taskId: 'T001',
        }),
      );
      addEvent(
        call('runner_call_completed', 'b-2', 8_400, 'implementer', 'implementing', CODEX, {
          taskId: 'T001',
        }),
      );
      addEvent({
        type: 'task_completed',
        ts: 8_500,
        phase: 'implementing',
        taskId: 'T001',
        title: 'T001',
        method: 'local',
      } as unknown as EngineEvent);
      const ended = await chromeWith({}, { implementer: CODEX });
      expect(ended.actual).toEqual(ended.expected);

      addEvent({ type: 'workflow_resumed', ts: 9_000, phase: 'implementing' } as EngineEvent);
      addEvent(passConfig(9_010, 'implementing', crewConfig({})));
      const next = await chromeWith({}, { implementer: CODEX });
      expect(seatWords(next.actual)).toEqual(await savedSeatWords({}));
    },
  );

  it.each(['Back to sessions', 'quit'])(
    'names the saved seat once %s takes the parked run down',
    async () => {
      runBrief({ implementer: CODEX }, CODEX);
      save({});
      void stopInside(BRIEF_STEP);
      // Leaving drains the park as a stop, then the loop settles the run at rest.
      stopStore.request('stop-now');
      const leaving = await chromeWith({}, { implementer: CODEX });
      stopStore.park('mid-brief', null, null);
      const atRest = await chromeWith({}, { implementer: CODEX });
      const saved = await savedSeatWords({});
      expect(seatWords(leaving.actual)).toEqual(saved);
      expect(seatWords(atRest.actual)).toEqual(saved);
    },
  );

  it('names the saved seat when the run continues from rest', async () => {
    runBrief({ implementer: CODEX }, CODEX);
    save({});
    void stopInside(BRIEF_STEP);
    stopStore.park('mid-brief', null, null);
    addEvent({ type: 'workflow_resumed', ts: 9_000, phase: 'implementing' } as EngineEvent);
    addEvent(passConfig(9_010, 'implementing', crewConfig({})));
    const { actual } = await chromeWith({}, { implementer: CODEX });
    expect(seatWords(actual)).toEqual(await savedSeatWords({}));
  });

  it('names the saved seat when End run takes the parked run down', async () => {
    runBrief({ implementer: CODEX }, CODEX);
    save({});
    void stopInside(BRIEF_STEP);
    stopStore.request('end-run');
    const ending = await chromeWith({}, { implementer: CODEX });
    stopStore.end();
    const ended = await chromeWith({}, { implementer: CODEX });
    const saved = await savedSeatWords({});
    expect(seatWords(ending.actual)).toEqual(saved);
    expect(seatWords(ended.actual)).toEqual(saved);
  });

  it('names the saved seat after a failed stop and its Retry stop', async () => {
    runBrief({ implementer: CODEX }, CODEX);
    save({});
    void stopInside(BRIEF_STEP);
    stopStore.request('stop-now');
    stopStore.fail('Could not save state.json: disk full');
    const failed = await chromeWith({}, { implementer: CODEX });
    stopStore.request('stop-now');
    stopStore.park('mid-brief', null, null);
    const retried = await chromeWith({}, { implementer: CODEX });
    const saved = await savedSeatWords({});
    expect(seatWords(failed.actual)).toEqual(saved);
    expect(seatWords(retried.actual)).toEqual(saved);
  });

  it('keeps the saved seat when a Resume finds no park to settle', async () => {
    runBrief({ implementer: CODEX }, CODEX);
    save({});
    void stopInside(BRIEF_STEP);
    stopStore.park('mid-brief', null, null);
    expect(resumeParkedRun(plainUserMessage(''))).toBe(false);
    const { actual } = await chromeWith({}, { implementer: CODEX });
    expect(seatWords(actual)).toEqual(await savedSeatWords({}));
  });

  it('names the saved seat when a halt arrives while parked', async () => {
    runBrief({ implementer: CODEX }, CODEX);
    save({});
    void stopInside(BRIEF_STEP);
    recoveryNoticeStore.open({
      seat: null,
      resetAt: null,
      issue: makeRecoveryIssue({ taskId: taskId('T001') }),
      at: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
    });
    const { actual } = await chromeWith({}, { implementer: CODEX });
    expect(seatWords(actual)).toEqual(await savedSeatWords({}));
  });
});
