import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import {
  fakeDeps,
  getStartCommandTmp,
  prepareExecutionMock,
  setupStartCommandIntegration,
  writeReadyReadinessFixtures,
} from '#testing/helpers/start-command.js';
import { makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { typedCallFromTasks } from '#testing/helpers/typed-planner.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { registerStartCommand } from '../../../src/cli/commands/start/register.js';
import { registerContinueCommand } from '../../../src/cli/commands/continue/register.js';
import { resumeSavedSession } from '../../../src/cli/commands/continue/resume.js';
import { registerResumeCommand } from '../../../src/cli/commands/resume.js';
import { checkSessionLiveness } from '../../../src/core/sessions/lock/file.js';
import { setupWorkflow } from '../../../src/cli/setup.js';
import { runHeadless } from '../../../src/cli/headless/run.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { ensureSessionDir } from '../../../src/core/sessions/spec-files.js';
import { readActive, writeActive } from '../../../src/core/sessions/active-pointer.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import { transition } from '../../../src/core/state/machine.js';
import { buildRetryExhaustedRecoveryIssue } from '../../../src/engine/orchestrator/recovery/builders/retry.js';

const TARGET_FILE = 'src/loop.ts';
const DISCLOSURE = 'SPLITBRIEF config declares hooks this machine has not trusted:';
const NO_TTY_REFUSAL =
  'Hook config is not trusted and no TTY available. Re-run with --allow-hooks to trust it (CI usage).';

const TASK = makeTask({
  id: 'T001',
  action: 'create',
  suggestedFiles: [TARGET_FILE],
  title: 'Hooked module',
  description: 'Create a module so the hooks have a brief to run around.',
  implementationSteps: ['Create src/loop.ts with the marker export.'],
  tests: ['the plain sink writes task T001: done'],
  scope: { inBounds: [TARGET_FILE], outOfBounds: ['unrelated files'] },
  evidence: ['the plain sink writes task T001: done'],
  typeDefs: 'export const loop: string',
});

setupStartCommandIntegration();

let marks = '';

beforeEach(() => {
  marks = createTempDir('headless-hook-trust-marks');
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDir(marks);
});

/** A ready project whose config declares one `pre_task` and one `post_task` hook that this machine never trusted. */
function hookedProject(): { tmp: string; preMark: string; postMark: string } {
  const tmp = getStartCommandTmp();
  writeReadyReadinessFixtures(tmp, { validation: true, approve: 'none' });
  const preMark = join(marks, 'pre-task');
  const postMark = join(marks, 'post-task');
  const hook = (mark: string) =>
    `    - command: node\n      args: ["-e", ${JSON.stringify(
      `require('node:fs').writeFileSync(${JSON.stringify(mark)}, '')`,
    )}]\n`;
  appendFileSync(
    join(tmp, '.splitbrief', 'config.yaml'),
    `\nhooks:\n  pre_task:\n${hook(preMark)}  post_task:\n${hook(postMark)}`,
  );
  return { tmp, preMark, postMark };
}

function captureOutput(): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  return { stdout, stderr };
}

function seats() {
  const planner = makePlanner({
    typedCall: typedCallFromTasks([TASK], { inputTokens: 140, outputTokens: 90 }),
    review: vi.fn().mockResolvedValue({
      text: '# Final review\n\nPassed validation.\n\n### Verdict\npass\n',
      usage: { inputTokens: 60, outputTokens: 30 },
    }),
  });
  const implement = vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
    const target = join(opts.projectDir, TARGET_FILE);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'export const loop = "hooked";\n', 'utf-8');
    return { success: true, output: 'code', usage: { inputTokens: 100, outputTokens: 50 } };
  });
  return { planner, implement, implementer: makeImplementer({ implement }) };
}

function startProgram(run: ReturnType<typeof seats>): Command {
  const program = new Command();
  program.exitOverride();
  registerStartCommand(program, {
    ...fakeDeps,
    runHeadless: (options) =>
      runHeadless({ ...options, _planner: run.planner, _implementer: run.implementer }),
  });
  return program;
}

function continueProgram(run: ReturnType<typeof seats>): Command {
  const program = new Command();
  program.exitOverride();
  registerContinueCommand(program, {
    initStores: fakeDeps.initStores,
    renderApp: fakeDeps.renderApp,
    setupWorkflow,
    prepareExecution: prepareExecutionMock,
    runHeadless: (options) =>
      runHeadless({ ...options, _planner: run.planner, _implementer: run.implementer }),
  });
  return program;
}

/** `splitbrief resume`, whose resume of the saved run is the real one with the seats injected. */
function resumeProgram(run: ReturnType<typeof seats>): Command {
  const program = new Command();
  program.exitOverride();
  registerResumeCommand(program, {
    checkSessionLiveness,
    resumeSavedSession: (args) =>
      resumeSavedSession({
        ...args,
        deps: {
          initStores: fakeDeps.initStores,
          renderApp: fakeDeps.renderApp,
          setupWorkflow,
          prepareExecution: prepareExecutionMock,
          runHeadless: (options) =>
            runHeadless({ ...options, _planner: run.planner, _implementer: run.implementer }),
        },
      }),
  });
  return program;
}

/** A run that stopped before its one brief began, saved the way a stopped headless run leaves it. */
function pausedRun(tmp: string): string {
  const sessionId = 'sess-hooked-paused';
  ensureSessionDir(tmp, sessionId);
  writeActive({ projectDir: tmp, sessionId });
  saveState(
    { projectDir: tmp, sessionId },
    makeImplState([TASK], { feature: 'run the hooked brief', implementerTool: 'ollama' }),
  );
  return sessionId;
}

/** A run halted on its one brief after the retries ran out, with a retry on offer. */
function haltedRun(tmp: string): string {
  const sessionId = 'sess-hooked-halted';
  ensureSessionDir(tmp, sessionId);
  writeActive({ projectDir: tmp, sessionId });
  saveState(
    { projectDir: tmp, sessionId },
    transition(
      makeImplState([TASK], { feature: 'run the hooked brief', implementerTool: 'ollama' }),
      {
        type: 'SET_PENDING_RECOVERY',
        issue: buildRetryExhaustedRecoveryIssue({
          task: TASK,
          validationSummary: 'npm test failed',
          attempts: 2,
          allowRetryOverride: true,
          createdAt: '2026-04-29T00:00:00.000Z',
        }),
      },
    ),
  );
  return sessionId;
}

describe('headless runs with workflow hooks this machine has not trusted', {
  timeout: 90_000,
}, () => {
  it('start --plain --allow-hooks trusts the hooks and runs them around the brief', async () => {
    const { tmp, preMark, postMark } = hookedProject();
    const output = captureOutput();
    const run = seats();

    await startProgram(run).parseAsync([
      'node',
      'splitbrief',
      'start',
      '--plain',
      '--allow-hooks',
      'run the hooked brief',
      '--project',
      tmp,
    ]);

    const stderr = output.stderr.join('');
    expect(stderr).toContain(DISCLOSURE);
    expect(stderr).not.toContain('blocked');
    expect(run.implement).toHaveBeenCalledOnce();
    expect(existsSync(preMark)).toBe(true);
    expect(existsSync(postMark)).toBe(true);
    expect(output.stdout.join('')).toContain('task T001: done');
  });

  it('start --plain without --allow-hooks and without a terminal refuses before the planner runs', async () => {
    const { tmp, preMark } = hookedProject();
    process.stdin.isTTY = false;
    captureOutput();
    const run = seats();

    await expect(
      startProgram(run).parseAsync([
        'node',
        'splitbrief',
        'start',
        '--plain',
        'run the hooked brief',
        '--project',
        tmp,
      ]),
    ).rejects.toMatchObject({ exitCode: 1, message: NO_TTY_REFUSAL });

    expect(run.planner.typedCall).not.toHaveBeenCalled();
    expect(run.implement).not.toHaveBeenCalled();
    expect(existsSync(preMark)).toBe(false);
    expect(readActive(tmp)).toBeNull();
    expect(existsSync(sessionsRoot(tmp)) ? readdirSync(sessionsRoot(tmp)) : []).toEqual([]);
  });

  it('start --json --allow-hooks writes the disclosure on stderr and keeps stdout to JSON records', async () => {
    const { tmp, preMark } = hookedProject();
    const output = captureOutput();
    const run = seats();

    await startProgram(run).parseAsync([
      'node',
      'splitbrief',
      'start',
      '--json',
      '--allow-hooks',
      'run the hooked brief',
      '--project',
      tmp,
    ]);

    const stderr = output.stderr.join('');
    expect(stderr).toContain(DISCLOSURE);
    expect(stderr).not.toContain('blocked');
    expect(existsSync(preMark)).toBe(true);
    const lines = output.stdout.join('').trimEnd().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(output.stdout.join('')).not.toContain(DISCLOSURE);
  });

  it('continue --plain --allow-hooks trusts the hooks and runs them around the brief', async () => {
    const { tmp, preMark, postMark } = hookedProject();
    const sessionId = pausedRun(tmp);
    const output = captureOutput();
    const run = seats();

    await continueProgram(run).parseAsync([
      'node',
      'splitbrief',
      'continue',
      sessionId,
      '--plain',
      '--allow-hooks',
      '--project',
      tmp,
    ]);

    const stderr = output.stderr.join('');
    expect(stderr).toContain(DISCLOSURE);
    expect(stderr).not.toContain('blocked');
    expect(run.implement).toHaveBeenCalledOnce();
    expect(existsSync(preMark)).toBe(true);
    expect(existsSync(postMark)).toBe(true);
  });

  it('continue --plain without --allow-hooks and without a terminal refuses before the run resumes', async () => {
    const { tmp, preMark } = hookedProject();
    const sessionId = pausedRun(tmp);
    process.stdin.isTTY = false;
    captureOutput();
    const run = seats();

    await expect(
      continueProgram(run).parseAsync([
        'node',
        'splitbrief',
        'continue',
        sessionId,
        '--plain',
        '--project',
        tmp,
      ]),
    ).rejects.toMatchObject({ exitCode: 1, message: NO_TTY_REFUSAL });

    expect(run.implement).not.toHaveBeenCalled();
    expect(existsSync(preMark)).toBe(false);
    expect(loadState({ projectDir: tmp, sessionId })?.tasks[0]?.status).toBe('pending');
  });

  it('continue --plain --action retry without --allow-hooks and without a terminal keeps the halt for the same command with the flag', async () => {
    const { tmp, preMark, postMark } = hookedProject();
    const sessionId = haltedRun(tmp);
    const continueArgs = [
      'node',
      'splitbrief',
      'continue',
      sessionId,
      '--plain',
      '--action',
      'retry',
    ];
    process.stdin.isTTY = false;
    captureOutput();
    const refused = seats();

    await expect(
      continueProgram(refused).parseAsync([...continueArgs, '--project', tmp]),
    ).rejects.toMatchObject({ exitCode: 1, message: NO_TTY_REFUSAL });

    expect(refused.implement).not.toHaveBeenCalled();
    expect(loadState({ projectDir: tmp, sessionId })?.pendingRecovery?.reason).toBe(
      'retry-exhausted',
    );

    vi.restoreAllMocks();
    const output = captureOutput();
    const run = seats();
    await continueProgram(run).parseAsync([...continueArgs, '--allow-hooks', '--project', tmp]);

    expect(output.stderr.join('').split(DISCLOSURE)).toHaveLength(2);
    expect(run.implement).toHaveBeenCalledOnce();
    expect(existsSync(preMark)).toBe(true);
    expect(existsSync(postMark)).toBe(true);
  });

  it.each(['--json', '--plain'])(
    'resume %s --allow-hooks trusts the hooks and runs them around the brief',
    async (flag) => {
      const { tmp, preMark, postMark } = hookedProject();
      pausedRun(tmp);
      const output = captureOutput();
      const run = seats();

      await resumeProgram(run).parseAsync([
        'node',
        'splitbrief',
        'resume',
        flag,
        '--allow-hooks',
        '--project',
        tmp,
      ]);

      const stderr = output.stderr.join('');
      expect(stderr).toContain(DISCLOSURE);
      expect(stderr).not.toContain('blocked');
      expect(run.implement).toHaveBeenCalledOnce();
      expect(existsSync(preMark)).toBe(true);
      expect(existsSync(postMark)).toBe(true);
    },
  );

  it.each(['--json', '--plain'])(
    'resume %s without --allow-hooks and without a terminal refuses before the run resumes',
    async (flag) => {
      const { tmp, preMark } = hookedProject();
      const sessionId = pausedRun(tmp);
      process.stdin.isTTY = false;
      captureOutput();
      const run = seats();

      await expect(
        resumeProgram(run).parseAsync(['node', 'splitbrief', 'resume', flag, '--project', tmp]),
      ).rejects.toMatchObject({ exitCode: 1, message: NO_TTY_REFUSAL });

      expect(run.implement).not.toHaveBeenCalled();
      expect(existsSync(preMark)).toBe(false);
      expect(loadState({ projectDir: tmp, sessionId })?.tasks[0]?.status).toBe('pending');
    },
  );
});
