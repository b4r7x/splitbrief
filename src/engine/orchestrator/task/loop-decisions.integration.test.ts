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
  makeWorktreeIsolation,
  openRunWorkspace,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { consultCallAnswering } from '#testing/helpers/typed-planner.js';
import { error } from '../../../utils/error.js';
import { loadState } from '../../../core/state/persistence.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import type { ConsultAnswer, ReportedDecision } from '../../../core/schemas/consult.js';
import type { Task } from '../../../core/schemas/task.js';
import type { LineageRecord, WorkflowState } from '../../../core/schemas/workflow.js';
import type { EngineEvent } from '../../events/types.js';
import type { ImplementerOptions, RetryOptions } from '../../implementers/types.js';
import type { Validator } from '../validation/types.js';
import { processError } from '../../../lib/process/errors.js';
import * as commandRunner from '../../../lib/process/spawn/run-command.js';
import { applyRecoveryAction } from '../recovery/actions.js';
import { enqueueUserMessage } from '../queue/submit.js';
import { runTaskLoop } from './loop.js';
import { createSnapshot } from '../../snapshots/create.js';
import { ABSENT_INPUT_HASH } from './stale-inputs.js';
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

function lineage(overrides: Partial<LineageRecord>): LineageRecord {
  return {
    consults: 0,
    attempts: 0,
    consultAllowance: 2,
    attemptAllowance: 8,
    staleConsultedRevision: {},
    dispatchedRevision: {},
    consultRecords: [],
    replacedParents: [],
    notes: [],
    ...overrides,
  };
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

/** A planner whose every call fails: the failed consult and the stale consult halt the brief. */
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
    if (event.type === 'consult_bound_spent') return ['bound-spent'];
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
    expect(result.state.plannerCalls?.used ?? 0).toBe(0);
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
    expect(result.state.plannerCalls?.used).toBe(1);
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

  /** T001 has spent its consults, so its ladder halts with the files of its last attempt. */
  function spentConsults(): Partial<WorkflowState> {
    return { lineages: { T001: lineage({ consults: 2 }) } };
  }

  describe('Skip on a consult-bound halt', () => {
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

    it("takes back the brief's file when its consults are spent", async () => {
      const { projectDir, sessionId } = setupProjectWithUserWork();
      const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
      const { bus, events } = makeBusRecorder();

      const halted = await runLoop({
        projectDir,
        sessionId,
        state: stateWithPlan([task], spentConsults()),
        implementer: writingImplementer(['src/a.ts']),
        validator: redValidator(),
        planner: failingPlanner(),
        bus,
      });
      expect(halted.state.pendingRecovery?.reason).toBe('consult-bound-spent');
      expect(existsSync(join(projectDir, 'src/a.ts'))).toBe(true);
      expect(bookedFiles(projectDir, sessionId, 'T001')).toEqual(['src/a.ts']);
      // The ledger keeps the decisions of the attempts that failed validation.
      expect(halted.state.plan?.decisions).toEqual([
        { text: `${HOW.what} — ${HOW.why}`, taskId: 'T001' },
        { text: `${HOW_TOO.what} — ${HOW_TOO.why}`, taskId: 'T001' },
      ]);

      const skipped = await skip(projectDir, sessionId, halted.state, bus);

      expect(skipped.tasks[0]?.status).toBe('skipped');
      expect(existsSync(join(projectDir, 'src/a.ts'))).toBe(false);
      expect(bookedFiles(projectDir, sessionId, 'T001')).toEqual([]);
      expect(restoreWarnings(events)).toEqual([expect.stringContaining('src/a.ts')]);
      // The warning follows the Skip's outcome, so the transcript shows one Recovery row.
      const resolvedAt = events.findIndex((event) => event.type === 'recovery_resolved');
      expect(resolvedAt).toBeGreaterThan(-1);
      expect(
        events.findIndex((event) => event.type === 'warning' && event.message.startsWith(RESTORED)),
      ).toBeGreaterThan(resolvedAt);
      expect(readFileSync(join(projectDir, USER_FILE), 'utf-8')).toBe(USER_WORK);
    });

    it('takes back the files of every attempt after a Continue', async () => {
      const { projectDir, sessionId } = setupProjectWithUserWork();
      const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts', 'src/b.ts'] });
      const implementer = writingImplementer(['src/a.ts', 'src/b.ts']);
      // The consult that Continue grants answers, and the next failure spends the bound again.
      const { planner } = scriptedPlanner({ consult: guidance });
      const validator = redValidator();
      const { bus, events } = makeBusRecorder();

      const first = await runLoop({
        projectDir,
        sessionId,
        state: stateWithPlan([task], spentConsults()),
        implementer,
        validator,
        planner,
        bus,
      });
      expect(first.state.pendingRecovery?.reason).toBe('consult-bound-spent');
      const continued = await applyRecoveryAction({
        projectDir,
        sessionId,
        state: first.state,
        action: 'continue',
        bus,
      });
      expect(continued.ok).toBe(true);
      const second = await runLoop({
        projectDir,
        sessionId,
        state: continued.state,
        implementer,
        validator,
        planner,
        bus,
      });
      expect(second.state.pendingRecovery?.reason).toBe('consult-bound-spent');
      expect(existsSync(join(projectDir, 'src/a.ts'))).toBe(true);
      expect(existsSync(join(projectDir, 'src/b.ts'))).toBe(true);

      await skip(projectDir, sessionId, second.state, bus);

      expect(existsSync(join(projectDir, 'src/a.ts'))).toBe(false);
      expect(existsSync(join(projectDir, 'src/b.ts'))).toBe(false);
      expect(bookedFiles(projectDir, sessionId, 'T001')).toEqual([]);
      expect(restoreWarnings(events)).toEqual([
        expect.stringMatching(/src\/a\.ts.*src\/b\.ts|src\/b\.ts.*src\/a\.ts/),
      ]);
      expect(readFileSync(join(projectDir, USER_FILE), 'utf-8')).toBe(USER_WORK);
    });

    it('restores nothing of the skipped brief when the next brief halts on its stale consult', async () => {
      const { projectDir, sessionId } = setupProjectWithUserWork();
      const first = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
      const next = makeTask({
        id: 'T002',
        suggestedFiles: ['src/d.ts'],
        inputHashes: { 'src/c.ts': ABSENT_INPUT_HASH },
      });
      const implementer = writingImplementer(['src/a.ts']);
      const planner = failingPlanner();
      const validator = redValidator();
      const { bus, events } = makeBusRecorder();

      const halted = await runLoop({
        projectDir,
        sessionId,
        state: stateWithPlan([first, next], spentConsults()),
        implementer,
        validator,
        planner,
        bus,
      });
      const skipped = await skip(projectDir, sessionId, halted.state, bus);
      expect(restoreWarnings(events)).toHaveLength(1);
      // The user writes the skipped brief's file and the next brief's input during the halt.
      writeFileSync(join(projectDir, 'src/a.ts'), "the user's a\n");
      writeFileSync(join(projectDir, 'src/c.ts'), "the user's c\n");

      const stale = await runLoop({
        projectDir,
        sessionId,
        state: skipped,
        implementer,
        validator,
        planner,
        bus,
      });
      expect(stale.state.pendingRecovery).toMatchObject({
        reason: 'planner-call-failed',
        taskId: 'T002',
      });
      expect(implementer.implement).toHaveBeenCalledTimes(1);

      await skip(projectDir, sessionId, stale.state, bus);

      expect(restoreWarnings(events)).toHaveLength(1);
      expect(readFileSync(join(projectDir, 'src/a.ts'), 'utf-8')).toBe("the user's a\n");
      expect(readFileSync(join(projectDir, 'src/c.ts'), 'utf-8')).toBe("the user's c\n");
      expect(readFileSync(join(projectDir, USER_FILE), 'utf-8')).toBe(USER_WORK);
    });

    it("gives back the user's own bytes of a file the user changed before the run", async () => {
      const { projectDir, sessionId } = setupProjectWithUserWork();
      const task = makeTask({ id: 'T001', suggestedFiles: [USER_FILE] });
      const { bus, events } = makeBusRecorder();

      const halted = await runLoop({
        projectDir,
        sessionId,
        state: stateWithPlan([task], spentConsults()),
        implementer: writingImplementer([USER_FILE]),
        validator: redValidator(),
        planner: failingPlanner(),
        bus,
      });
      expect(readFileSync(join(projectDir, USER_FILE), 'utf-8')).toBe('attempt 2\n');

      await skip(projectDir, sessionId, halted.state, bus);

      expect(readFileSync(join(projectDir, USER_FILE), 'utf-8')).toBe(USER_WORK);
      expect(restoreWarnings(events)).toEqual([expect.stringContaining(USER_FILE)]);
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

    it("takes back the brief's file when a pre_task hook denies its Continue", async () => {
      const { projectDir, sessionId } = setupProjectWithUserWork();
      // The check passes before the brief wrote its file and fails on the brief's edit.
      const hooks = trustedHooks(projectDir, 'pre_task', [
        "import { existsSync, readFileSync } from 'node:fs';",
        "const file = JSON.parse(input).workspaceDir + '/src/a.ts';",
        "if (existsSync(file) && readFileSync(file, 'utf8').startsWith('attempt')) process.exit(1);",
      ]);
      const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
      const implementer = writingImplementer(['src/a.ts']);
      const planner = failingPlanner();
      const validator = redValidator();
      const { bus, events } = makeBusRecorder();

      const first = await runLoop({
        projectDir,
        sessionId,
        state: stateWithPlan([task], spentConsults()),
        implementer,
        validator,
        planner,
        bus,
        hooks,
      });
      expect(first.state.pendingRecovery?.reason).toBe('consult-bound-spent');
      expect(bookedFiles(projectDir, sessionId, 'T001')).toEqual(['src/a.ts']);
      const continued = await applyRecoveryAction({
        projectDir,
        sessionId,
        state: first.state,
        action: 'continue',
        bus,
      });
      expect(continued.ok).toBe(true);

      const second = await runLoop({
        projectDir,
        sessionId,
        state: continued.state,
        implementer,
        validator,
        planner,
        bus,
        hooks,
      });

      expect(second.state.tasks[0]?.status).toBe('skipped');
      expect(implementer.implement).toHaveBeenCalledTimes(1);
      // Only the local retry of the first run: the hook denied the Continue before its attempt.
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

  it.each([
    ['consult-bound-spent', { lineages: { T001: lineage({ consults: 2 }) } }],
    ['planner-calls-spent', { plannerCalls: { used: 10, allowance: 10 } }],
  ] as const)(
    'restarts a brief continued past %s with the last failing output',
    async (reason, bounds) => {
      const { projectDir, sessionId } = setupProject();
      const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
      const implementer = decidingImplementer([]);
      const validator = scriptedValidator({ T001: [TS_ERROR, LINT_ERROR, null] });
      const { planner } = scriptedPlanner({});
      const { bus, events } = makeBusRecorder();

      const halted = await runLoop({
        projectDir,
        sessionId,
        state: stateWithPlan([task], bounds),
        implementer,
        validator,
        planner,
        bus,
      });
      expect(halted.state.pendingRecovery?.reason).toBe(reason);
      expect(eventTypes(events)).toEqual(['retry', 'bound-spent']);

      const applied = await applyRecoveryAction({
        projectDir,
        sessionId,
        state: halted.state,
        action: 'continue',
        bus,
      });
      expect(applied.ok).toBe(true);
      if (!applied.ok) return;
      expect(applied.state.lineages?.T001?.carriedFailure).toContain(LINT_ERROR);

      const resumed = await runLoop({
        projectDir,
        sessionId,
        state: applied.state,
        implementer,
        validator,
        planner,
        bus,
      });

      expect(resumed.state.pendingRecovery).toBeUndefined();
      expect(resumed.status).toBe('complete');
      // The restart is a retry carrying the last failing output, never a bare re-implement.
      expect(implementer.implement).toHaveBeenCalledTimes(1);
      const retries = vi.mocked(implementer.retry).mock.calls.map(([opts]) => opts);
      expect(retries).toHaveLength(2);
      expect(retries[0]?.error).toContain(TS_ERROR);
      expect(retries[1]?.error).toContain(LINT_ERROR);
      expect(resumed.state.lineages?.T001?.carriedFailure).toBeUndefined();
    },
  );

  it('continues a brief past consult-bound-spent from the files its last attempt left', async () => {
    const { projectDir, sessionId } = setupProject();
    // Compile records the hashes of the brief's inputs; both files are absent then.
    const task = makeTask({
      id: 'T001',
      suggestedFiles: ['src/a.ts', 'src/b.ts'],
      inputHashes: { 'src/a.ts': ABSENT_INPUT_HASH, 'src/b.ts': ABSENT_INPUT_HASH },
    });
    const usage = { inputTokens: 10, outputTokens: 5 };
    let continued = false;
    const seenByReplay: string[] = [];
    const implementer = makeImplementer({
      implement: vi.fn(async (opts: ImplementerOptions) => {
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(join(opts.projectDir, 'src/a.ts'), 'export const a = 1;\n');
        return { success: true, output: 'implemented', usage };
      }),
      retry: vi.fn(async (opts: RetryOptions) => {
        if (continued) {
          seenByReplay.push(readFileSync(join(opts.projectDir, 'src/a.ts'), 'utf-8'));
          writeFileSync(join(opts.projectDir, 'src/b.ts'), 'export const b = 1;\n');
        } else {
          writeFileSync(join(opts.projectDir, 'src/a.ts'), 'export const a = 2;\n');
        }
        return { success: true, output: 'implemented', usage };
      }),
    });
    const validator = scriptedValidator({ T001: [TS_ERROR, LINT_ERROR, null] });
    const { planner, prompts } = scriptedPlanner({});
    const { bus, events } = makeBusRecorder();
    const wctx = await openRunWorkspace(
      makeWctx({
        projectDir,
        sessionId,
        config: makeNoValidationConfig({ workflow: { review: 'task' } }),
        callbacks: makeCallbacks({ onPlannerReply: vi.fn() }).callbacks,
        isolation: makeWorktreeIsolation({ projectDir, sessionId }),
        planner,
        implementer,
        validator,
        bus,
      }),
    );
    const loop = (initialState: WorkflowState) =>
      runTaskLoop({ wctx, initialState, setTrackedState: vi.fn(), setCurrentTask: vi.fn() });
    // The run base the task review compares the worktree with, recorded as a run records it.
    await createSnapshot({ projectDir, sessionId, phase: 'manual', name: 'run-baseline' });
    const base = await createSnapshot({
      projectDir,
      sessionId,
      phase: 'manual',
      name: 'workspace-base',
    });
    const workspace = {
      kind: 'worktree' as const,
      path: wctx.workspaceDir,
      base: { snapshotId: base.manifest.id, head: null },
    };

    const halted = await loop(
      stateWithPlan([task], { lineages: { T001: lineage({ consults: 2 }) }, workspace }),
    );
    expect(halted.state.pendingRecovery?.reason).toBe('consult-bound-spent');
    expect(readFileSync(join(wctx.workspaceDir, 'src/a.ts'), 'utf-8')).toBe(
      'export const a = 2;\n',
    );

    const applied = await applyRecoveryAction({
      projectDir,
      sessionId,
      state: halted.state,
      action: 'continue',
      bus,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    continued = true;
    const resumed = await loop(applied.state);

    expect(resumed.state.pendingRecovery).toBeUndefined();
    expect(resumed.status).toBe('complete');
    // The replay is a retry on the last attempt's files, not a rebuild from the pre-task state.
    expect(seenByReplay).toEqual(['export const a = 2;\n']);
    // The files the brief wrote itself are not inputs that moved under it: no stale consult.
    expect(prompts).toEqual([]);
    expect(eventTypes(events).filter((type) => type.startsWith('consult:'))).toEqual([]);
    // Its validation reads every file the brief changed since it first started.
    const replayValidation = vi.mocked(validator.formatChangedFiles).mock.calls.at(-1)?.[0];
    expect(replayValidation?.changedFiles).toEqual(
      expect.arrayContaining(['src/a.ts', 'src/b.ts']),
    );
  });

  it('keeps the carried failure across a stop, and drops it once the carrying attempt returns', async () => {
    const { projectDir, sessionId } = setupProject();
    const task = makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] });
    const validator = scriptedValidator({ T001: [LINT_ERROR] });
    const { planner } = scriptedPlanner({ consult: guidance });
    const { bus } = makeBusRecorder();
    const controller = new AbortController();
    const stopping = makeImplementer({
      retry: vi.fn(async () => {
        controller.abort();
        return { success: false, output: '', outcome: 'user-abort' as const, error: 'Aborted' };
      }),
    });
    const carried = stateWithPlan([task], {
      lineages: { T001: lineage({ consults: 2, carriedFailure: LINT_ERROR }) },
    });

    const stopped = await runLoop({
      projectDir,
      sessionId,
      state: carried,
      implementer: stopping,
      validator,
      planner,
      bus,
      signal: controller.signal,
    });
    expect(vi.mocked(stopping.retry).mock.calls[0]?.[0].error).toContain(LINT_ERROR);
    expect(stopped.state.lineages?.T001?.carriedFailure).toBe(LINT_ERROR);

    // The resumed attempt still carries it; it fails validation once, and the
    // ladder's own retry no longer replays the carried text.
    const implementer = decidingImplementer([]);
    const resumed = await runLoop({
      projectDir,
      sessionId,
      state: stopped.state,
      implementer,
      validator: scriptedValidator({ T001: [TS_ERROR, null] }),
      planner,
      bus,
    });
    expect(resumed.status).toBe('complete');
    const retries = vi.mocked(implementer.retry).mock.calls.map(([opts]) => opts);
    expect(retries[0]?.error).toContain(LINT_ERROR);
    expect(retries[1]?.error).toContain(TS_ERROR);
    expect(retries[1]?.error).not.toContain(LINT_ERROR);
    expect(resumed.state.lineages?.T001?.carriedFailure).toBeUndefined();
  });
});
