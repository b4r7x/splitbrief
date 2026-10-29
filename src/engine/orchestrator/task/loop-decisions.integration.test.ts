import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
  makeWctx,
  openRunWorkspace,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { consultCallAnswering } from '#testing/helpers/typed-planner.js';
import { error } from '../../../utils/error.js';
import { loadState } from '../../../core/state/persistence.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import type { ConsultAnswer, ReportedDecision } from '../../../core/schemas/consult.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { EngineEvent } from '../../events/types.js';
import type { ImplementerOptions, RetryOptions } from '../../implementers/types.js';
import type { Validator } from '../validation/types.js';
import { processError } from '../../../lib/process/errors.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { enqueueUserMessage } from '../queue/submit.js';
import { runTaskLoop } from './loop.js';
import { readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import { useTrustHome } from '#testing/helpers/trust-home.js';
import { markHooksConfigTrusted } from '../../../core/hooks/trust.js';
import type { HooksConfig } from '../../../core/schemas/hooks.js';

type Decision = ReportedDecision;

const HOW: Decision = {
  what: 'Imported ReviewRecord from schemas/workflow.ts',
  why: 'The brief named a module that does not export it',
};
const HOW_TOO: Decision = {
  what: 'Kept the helper private to the module',
  why: 'Only one caller reads it',
};
const UNREASONED: Decision = { what: 'Kept the old helper name', why: null };
const TS_ERROR =
  "src/engine/orchestrator/task/loop.ts(5,15): error TS2305: Module '../../../core/schemas/review.js' has no exported member 'ReviewRecord'.";
const LINT_ERROR = 'prior-run.test.ts:224 Formatter would have printed different content.';

let dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const { projectDir, sessionId } = setupGitSessionProject({
    prefix: 'task-loop-decisions',
    sessionId: 'sess-loop-decisions',
  });
  dirs.push(projectDir);
  return { projectDir, sessionId };
}

/** Each brief carries one required check, `K-<task id>`, so the brief gate runs it. */
function stateWithPlan(tasks: Task[], overrides?: Partial<WorkflowState>): WorkflowState {
  const checked = tasks.map((task) => ({
    ...task,
    checks: [{ id: `K-${task.id}`, kind: 'cmd' as const, value: 'tsc --noEmit', required: true }],
  }));
  return makeImplState(checked, {
    plan: {
      summary: 'Finish the review pipeline.',
      decisions: [],
      criteria: [],
      checks: [],
      validation: null,
    },
    ...overrides,
  });
}

function doneReport(decisions: readonly Decision[], file: string) {
  return {
    status: 'done' as const,
    filesChanged: [file],
    touchedNotSuggested: [],
    notes: null,
    decisions: [...decisions],
  };
}

/** An implementer that writes the brief's file and hands back the decisions each call reports. */
function decidingImplementer(decisionsPerCall: readonly (readonly Decision[])[]) {
  const script = [...decisionsPerCall];
  const write = (projectDir: string, task: Task, marker: string) => {
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, task.suggestedFiles[0]), `${marker}\n`);
  };
  const handBack = (decisions: readonly Decision[], task: Task) => ({
    success: true,
    output: 'implemented',
    usage: { inputTokens: 10, outputTokens: 5 },
    report: doneReport(decisions, task.suggestedFiles[0]),
  });
  let calls = 0;
  return makeImplementer({
    implement: vi.fn(async (opts: ImplementerOptions) => {
      calls += 1;
      write(opts.projectDir, opts.task, `implement ${calls}`);
      return handBack(script.shift() ?? [], opts.task);
    }),
    retry: vi.fn(async (opts: RetryOptions) => {
      calls += 1;
      write(opts.projectDir, opts.task, `retry ${calls}`);
      return handBack(script.shift() ?? [], opts.task);
    }),
  });
}

/**
 * Each brief check answers from a script per task; past the script every run passes. `checkRuns`
 * records the task of every check run.
 */
function scriptedValidator(
  script: Record<string, readonly (string | null)[]>,
): Validator & { checkRuns: ReturnType<typeof vi.fn> } {
  const queues = new Map(Object.entries(script).map(([id, answers]) => [id, [...answers]]));
  const checkRuns = vi.fn();
  vi.spyOn(commandRunner, 'runCommand').mockImplementation(async (_cmd, _args, options) => {
    const id = (options?.label ?? '').replace(/^check K-/, '');
    checkRuns(id);
    const error = queues.get(id)?.shift() ?? null;
    if (error === null) return { stdout: '', stderr: '', code: 0 };
    throw processError.exitCode({ command: 'tsc', code: 2, stderr: error, output: '' });
  });
  return { formatChangedFiles: vi.fn().mockResolvedValue(undefined), checkRuns };
}

function guidance(): ConsultAnswer {
  return {
    answer: {
      diagnosis: 'The import is still wrong.',
      action: 'guidance',
      instructions: 'Import ReviewRecord from src/core/schemas/workflow.ts.',
      context: null,
    },
  };
}

/** The planner's consult prompts; with no `consult` answer, a consult fails the test. */
function scriptedPlanner(answers: { consult?: () => ConsultAnswer }) {
  const prompts: string[] = [];
  const planner = makePlanner({
    typedCall: consultCallAnswering((prompt) => {
      prompts.push(prompt);
      if (answers.consult === undefined) throw new Error('the ladder consulted the planner');
      return answers.consult();
    }),
  });
  return { planner, prompts };
}

/** A planner whose every call fails: the failed consult halts the brief. */
function failingPlanner() {
  return makePlanner({
    typedCall: consultCallAnswering(() => {
      throw error('runner-call-failed', 'Planner escalation call failed', {
        role: 'escalation',
        status: 'failed',
        error: { code: 'turn-failed', message: 'The planner process crashed.' },
      });
    }),
  });
}

/** An implementer whose call `n` writes `files[n - 1]` and reports one decision of how. */
function writingImplementer(files: readonly string[]) {
  let calls = 0;
  const attempt = async (opts: ImplementerOptions | RetryOptions) => {
    const file = files[calls] ?? files[files.length - 1] ?? '';
    calls += 1;
    mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
    writeFileSync(join(opts.projectDir, file), `attempt ${calls}\n`);
    return {
      success: true,
      output: 'implemented',
      usage: { inputTokens: 10, outputTokens: 5 },
      report: doneReport(calls === 1 ? [HOW] : [HOW_TOO], file),
    };
  };
  return makeImplementer({ implement: vi.fn(attempt), retry: vi.fn(attempt) });
}

const RESTORED = 'Restored';

function restoreWarnings(events: readonly EngineEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'warning' && event.message.startsWith(RESTORED) ? [event.message] : [],
  );
}

/** The files the run's record books against a brief. */
function bookedFiles(projectDir: string, sessionId: string, taskId: string): string[] | undefined {
  return readEvidenceLedger({ projectDir, sessionId })?.tasks.find((entry) => entry.id === taskId)
    ?.changedFiles;
}

function eventTypes(events: readonly EngineEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === 'consult_answered') return [`consult:${event.reason}:${event.action}`];
    if (event.type === 'task_retry') return ['retry'];
    return [];
  });
}

async function runLoop(opts: {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  implementer: ReturnType<typeof makeImplementer>;
  validator: Validator;
  planner: ReturnType<typeof makePlanner>;
  callbacks?: ReturnType<typeof makeCallbacks>['callbacks'];
  bus: ReturnType<typeof makeBusRecorder>['bus'];
  signal?: AbortSignal;
  hooks?: HooksConfig;
}) {
  const wctx = await openRunWorkspace(
    makeWctx({
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      config: makeNoValidationConfig({
        workflow: { review: 'task' },
        ...(opts.hooks !== undefined && { hooks: opts.hooks }),
      }),
      callbacks: opts.callbacks ?? makeCallbacks({ onPlannerReply: vi.fn() }).callbacks,
      planner: opts.planner,
      implementer: opts.implementer,
      validator: opts.validator,
      bus: opts.bus,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    }),
  );
  return runTaskLoop({
    wctx,
    initialState: opts.state,
    setTrackedState: vi.fn(),
    setCurrentTask: vi.fn(),
  });
}

describe('runTaskLoop with reported decisions', { timeout: 90_000 }, () => {
  it('records the decisions of a done report in the plan ledger with the task id, with no planner call', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    const implementer = decidingImplementer([[HOW, UNREASONED]]);
    const validator = scriptedValidator({});
    const { planner, prompts } = scriptedPlanner({});
    const { bus, events } = makeBusRecorder();

    const result = await runLoop({
      projectDir,
      sessionId,
      state: stateWithPlan([task]),
      implementer,
      validator,
      planner,
      bus,
    });

    expect(result.status).toBe('complete');
    expect(prompts).toEqual([]);
    expect(eventTypes(events)).toEqual([]);
    expect(validator.checkRuns).toHaveBeenCalledTimes(1);
    const ledger = [
      { text: `${HOW.what} — ${HOW.why}`, taskId: 'T001' },
      { text: UNREASONED.what, taskId: 'T001' },
    ];
    expect(result.state.plan?.decisions).toEqual(ledger);
    expect(loadState({ projectDir, sessionId })?.plan?.decisions).toEqual(ledger);
  });

  it('records a decision once when every retry reports it again, and retries a red validation with the exact errors', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    const implementer = decidingImplementer([[HOW], [HOW], [HOW]]);
    const validator = scriptedValidator({ T001: [TS_ERROR, LINT_ERROR, null] });
    const { planner, prompts } = scriptedPlanner({ consult: guidance });
    const { bus, events } = makeBusRecorder();

    const result = await runLoop({
      projectDir,
      sessionId,
      state: stateWithPlan([task]),
      implementer,
      validator,
      planner,
      bus,
    });

    expect(result.state.pendingRecovery).toBeUndefined();
    expect(result.status).toBe('complete');
    expect(eventTypes(events)).toEqual(['retry', 'consult:failed:guidance']);
    const retries = vi.mocked(implementer.retry).mock.calls.map(([opts]) => opts);
    expect(retries[0]?.kind).toBe('local');
    expect(retries[0]?.error).toContain(TS_ERROR);
    expect(retries[1]?.kind).toBe('consult');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('failed —');
    expect(prompts[0]).toContain(LINT_ERROR);
    expect(result.state.plan?.decisions).toEqual([
      { text: `${HOW.what} — ${HOW.why}`, taskId: 'T001' },
    ]);
    expect(result.state.lineages?.T001?.consultRecords).toHaveLength(1);
  });

  it('records a new decision a retry reports beside the decision of the attempt before it', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    const implementer = decidingImplementer([[HOW], [HOW, HOW_TOO]]);
    const validator = scriptedValidator({ T001: [TS_ERROR, null] });
    const { planner, prompts } = scriptedPlanner({});
    const { bus, events } = makeBusRecorder();

    const result = await runLoop({
      projectDir,
      sessionId,
      state: stateWithPlan([task]),
      implementer,
      validator,
      planner,
      bus,
    });

    expect(result.status).toBe('complete');
    expect(eventTypes(events)).toEqual(['retry']);
    expect(prompts).toEqual([]);
    expect(result.state.plan?.decisions).toEqual([
      { text: `${HOW.what} — ${HOW.why}`, taskId: 'T001' },
      { text: `${HOW_TOO.what} — ${HOW_TOO.why}`, taskId: 'T001' },
    ]);
  });

  it('shows a message the build absorbed under the operator instructions of the next consult', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    const note = 'also log the flag value';
    const { bus } = makeBusRecorder();
    let calls = 0;
    const attempt = async (opts: ImplementerOptions | RetryOptions) => {
      calls += 1;
      mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
      writeFileSync(join(opts.projectDir, 'src/a.ts'), `attempt ${calls}\n`);
      if (calls === 1) {
        const state = loadState({ projectDir, sessionId });
        if (state === null) throw new Error('missing state during the build call');
        enqueueUserMessage({
          projectDir,
          sessionId,
          state,
          message: plainUserMessage(note),
          phase: state.phase,
          bus,
        });
      }
      return {
        success: true,
        output: 'implemented',
        usage: { inputTokens: 10, outputTokens: 5 },
        report: doneReport([HOW], 'src/a.ts'),
      };
    };
    const implementer = makeImplementer({ implement: vi.fn(attempt), retry: vi.fn(attempt) });
    const validator = scriptedValidator({ T001: [TS_ERROR, LINT_ERROR, null] });
    const { planner, prompts } = scriptedPlanner({ consult: guidance });

    const result = await runLoop({
      projectDir,
      sessionId,
      state: stateWithPlan([task]),
      implementer,
      validator,
      planner,
      bus,
    });

    expect(result.status).toBe('complete');
    expect(implementer.implement).toHaveBeenCalledTimes(2);
    const consultPrompt = prompts[0] ?? '';
    const instructions = consultPrompt.slice(consultPrompt.indexOf('## Operator Instructions'));
    expect(consultPrompt).toContain('## Operator Instructions');
    expect(instructions).toContain(
      `[user also says during implementing]\n${note}\n[/user also says]`,
    );
  });

  const USER_FILE = 'src/mine.ts';
  const USER_WORK = 'mine before the run\n';

  /** The user's own change in the checkout before the run: no skip may touch it. */
  function setupProjectWithUserWork() {
    const project = setupProject();
    mkdirSync(join(project.projectDir, 'src'), { recursive: true });
    writeFileSync(join(project.projectDir, USER_FILE), USER_WORK);
    return project;
  }

  /** T001's check never passes, so its ladder reaches the consult after the local retry. */
  function redValidator() {
    return scriptedValidator({ T001: Array<string>(8).fill(TS_ERROR) });
  }

  describe('Skip on a halted brief', () => {
    async function skip(
      projectDir: string,
      sessionId: string,
      state: WorkflowState,
      bus: ReturnType<typeof makeBusRecorder>['bus'],
    ) {
      expect(state.pendingRecovery?.availableActions).toContain('skip-current-task');
      const applied = await applyRecoveryAction({
        projectDir,
        sessionId,
        state,
        action: 'skip-current-task',
        bus,
      });
      expect(applied.ok).toBe(true);
      return applied.state;
    }

    it("takes back the brief's file at the halt when its planner call fails", async () => {
      const { projectDir, sessionId } = setupProjectWithUserWork();
      const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
      const { bus, events } = makeBusRecorder();

      const halted = await runLoop({
        projectDir,
        sessionId,
        state: stateWithPlan([task]),
        implementer: writingImplementer(['src/a.ts']),
        validator: redValidator(),
        planner: failingPlanner(),
        bus,
      });
      expect(halted.state.pendingRecovery?.reason).toBe('planner-call-failed');
      expect(existsSync(join(projectDir, 'src/a.ts'))).toBe(false);
      expect(restoreWarnings(events)).toEqual([expect.stringContaining('src/a.ts')]);
      // The ledger keeps the decisions of the attempts that failed validation.
      expect(halted.state.plan?.decisions).toEqual([
        { text: `${HOW.what} — ${HOW.why}`, taskId: 'T001' },
        { text: `${HOW_TOO.what} — ${HOW_TOO.why}`, taskId: 'T001' },
      ]);

      const skipped = await skip(projectDir, sessionId, halted.state, bus);

      expect(skipped.tasks[0]?.status).toBe('skipped');
      expect(existsSync(join(projectDir, 'src/a.ts'))).toBe(false);
      expect(bookedFiles(projectDir, sessionId, 'T001')).toEqual([]);
      expect(readFileSync(join(projectDir, USER_FILE), 'utf-8')).toBe(USER_WORK);
    });

    it('takes back the files of the attempts before and after a Retry', async () => {
      const { projectDir, sessionId } = setupProjectWithUserWork();
      const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts', 'src/b.ts'] });
      // The attempts before the Retry write src/a.ts; the attempts after it write src/b.ts.
      const implementer = writingImplementer(['src/a.ts', 'src/a.ts', 'src/b.ts']);
      const planner = failingPlanner();
      const validator = redValidator();
      const { bus, events } = makeBusRecorder();

      const first = await runLoop({
        projectDir,
        sessionId,
        state: stateWithPlan([task]),
        implementer,
        validator,
        planner,
        bus,
      });
      expect(first.state.pendingRecovery?.reason).toBe('planner-call-failed');
      const retried = await applyRecoveryAction({
        projectDir,
        sessionId,
        state: first.state,
        action: 'retry-same-worker',
        bus,
      });
      expect(retried.ok).toBe(true);
      const second = await runLoop({
        projectDir,
        sessionId,
        state: retried.state,
        implementer,
        validator,
        planner,
        bus,
      });
      expect(second.state.pendingRecovery?.reason).toBe('planner-call-failed');
      expect(existsSync(join(projectDir, 'src/a.ts'))).toBe(false);
      expect(existsSync(join(projectDir, 'src/b.ts'))).toBe(false);
      expect(restoreWarnings(events)).toEqual([
        expect.stringContaining('src/a.ts'),
        expect.stringContaining('src/b.ts'),
      ]);

      await skip(projectDir, sessionId, second.state, bus);

      expect(bookedFiles(projectDir, sessionId, 'T001')).toEqual([]);
      expect(readFileSync(join(projectDir, USER_FILE), 'utf-8')).toBe(USER_WORK);
    });

    it("gives back the user's own bytes of a file the user changed before the run", async () => {
      const { projectDir, sessionId } = setupProjectWithUserWork();
      const task = makeTask({ id: 'T001', suggestedFiles: [USER_FILE] });
      const { bus, events } = makeBusRecorder();

      const halted = await runLoop({
        projectDir,
        sessionId,
        state: stateWithPlan([task]),
        implementer: writingImplementer([USER_FILE]),
        validator: redValidator(),
        planner: failingPlanner(),
        bus,
      });
      expect(readFileSync(join(projectDir, USER_FILE), 'utf-8')).toBe(USER_WORK);
      expect(restoreWarnings(events)).toEqual([expect.stringContaining(USER_FILE)]);

      await skip(projectDir, sessionId, halted.state, bus);

      expect(readFileSync(join(projectDir, USER_FILE), 'utf-8')).toBe(USER_WORK);
      expect(bookedFiles(projectDir, sessionId, 'T001')).toEqual([]);
    });
  });

  describe('a hook that denies the brief after an attempt', () => {
    let trust: ReturnType<typeof useTrustHome>;
    beforeEach(() => {
      trust = useTrustHome('loop-decisions-hook-skip');
    });
    afterEach(() => trust.restore());

    /** A trusted hook script; it reads the workspace from the hook payload on stdin. */
    function trustedHooks(projectDir: string, event: keyof HooksConfig, script: string[]) {
      const path = join(projectDir, `${event}.mjs`);
      writeFileSync(
        path,
        ["let input = '';", 'for await (const c of process.stdin) input += c;', ...script, ''].join(
          '\n',
        ),
      );
      const hooks: HooksConfig = {
        [event]: [
          {
            kind: 'command',
            command: 'node',
            args: [path],
            timeout_ms: 30_000,
            on_failure: 'block',
          },
        ],
      };
      markHooksConfigTrusted(projectDir, hooks);
      return hooks;
    }

    it('skips the brief with its file taken back when a pre_task hook denies its Retry', async () => {
      const { projectDir, sessionId } = setupProjectWithUserWork();
      // The hook passes the brief's first start and denies every later one.
      const markerDir = createTempDir('loop-decisions-pre-task');
      dirs.push(markerDir);
      const marker = join(markerDir, 'started');
      const hooks = trustedHooks(projectDir, 'pre_task', [
        "import { existsSync, writeFileSync } from 'node:fs';",
        `if (existsSync(${JSON.stringify(marker)})) process.exit(1);`,
        `writeFileSync(${JSON.stringify(marker)}, '');`,
      ]);
      const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
      const implementer = writingImplementer(['src/a.ts']);
      const planner = failingPlanner();
      const validator = redValidator();
      const { bus, events } = makeBusRecorder();

      const first = await runLoop({
        projectDir,
        sessionId,
        state: stateWithPlan([task]),
        implementer,
        validator,
        planner,
        bus,
        hooks,
      });
      expect(first.state.pendingRecovery?.reason).toBe('planner-call-failed');
      expect(bookedFiles(projectDir, sessionId, 'T001')).toEqual(['src/a.ts']);
      const retried = await applyRecoveryAction({
        projectDir,
        sessionId,
        state: first.state,
        action: 'retry-same-worker',
        bus,
      });
      expect(retried.ok).toBe(true);

      const second = await runLoop({
        projectDir,
        sessionId,
        state: retried.state,
        implementer,
        validator,
        planner,
        bus,
        hooks,
      });

      expect(second.state.tasks[0]?.status).toBe('skipped');
      expect(implementer.implement).toHaveBeenCalledTimes(1);
      // Only the local retry of the first run: the hook denied the Retry before its attempt.
      expect(implementer.retry).toHaveBeenCalledTimes(1);
      expect(existsSync(join(projectDir, 'src/a.ts'))).toBe(false);
      expect(bookedFiles(projectDir, sessionId, 'T001')).toEqual([]);
      expect(restoreWarnings(events)).toEqual([expect.stringContaining('src/a.ts')]);
      expect(readFileSync(join(projectDir, USER_FILE), 'utf-8')).toBe(USER_WORK);
    });

    it('books none of the restored files when a pre_validation hook denies the brief', async () => {
      const { projectDir, sessionId } = setupProjectWithUserWork();
      // The hook passes the first attempt and denies the local retry that wrote the user's file.
      const hooks = trustedHooks(projectDir, 'pre_validation', [
        "import { readFileSync } from 'node:fs';",
        `const file = JSON.parse(input).workspaceDir + '/${USER_FILE}';`,
        "if (readFileSync(file, 'utf8').startsWith('attempt')) console.log(JSON.stringify({ decision: 'deny', message: 'policy' }));",
      ]);
      const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts', USER_FILE] });
      const implementer = writingImplementer(['src/a.ts', USER_FILE]);
      const validator = scriptedValidator({ T001: [TS_ERROR] });
      const { bus } = makeBusRecorder();

      const result = await runLoop({
        projectDir,
        sessionId,
        state: stateWithPlan([task]),
        implementer,
        validator,
        planner: failingPlanner(),
        bus,
        hooks,
      });

      expect(result.state.tasks[0]?.status).toBe('skipped');
      expect(implementer.implement).toHaveBeenCalledTimes(1);
      expect(implementer.retry).toHaveBeenCalledTimes(1);
      expect(existsSync(join(projectDir, 'src/a.ts'))).toBe(false);
      expect(readFileSync(join(projectDir, USER_FILE), 'utf-8')).toBe(USER_WORK);
      expect(bookedFiles(projectDir, sessionId, 'T001')).toEqual([]);
    });
  });
});
