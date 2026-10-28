import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import {
  fakeDeps,
  getStartCommandTmp,
  setupStartCommandIntegration,
  writeReadyReadinessFixtures,
} from '#testing/helpers/start-command.js';
import { makeImplementer, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import {
  preparedHeadlessExecution,
  writeMinimalHeadlessConfigYaml,
} from '#testing/helpers/headless-project.js';
import { registerStartCommand } from '../../../src/cli/commands/start/register.js';
import type { StartDeps } from '../../../src/cli/commands/start/types.js';
import { runHeadless } from '../../../src/cli/headless.js';
import type { ImplementerOptions } from '../../../src/engine/implementers/types.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
import { createInitialState, transition } from '../../../src/core/state/machine.js';
import { saveState } from '../../../src/core/state/persistence.js';
import { writeActive } from '../../../src/core/sessions/active-pointer.js';
import { buildRetryExhaustedRecoveryIssue } from '../../../src/engine/orchestrator/recovery/builders/task.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import type { RunWorkflowOptions } from '../../../src/engine/orchestrator/run/init.js';
import {
  planFromTasks,
  typedCallAnswering,
  typedCallFromTasks,
} from '#testing/helpers/typed-planner.js';
import { sessionsRoot } from '../../../src/core/paths.js';
import { PLAIN_LINE } from '../../e2e/helpers/run-dir-assertions.js';

const mocks = vi.hoisted(() => ({
  runWorkflow: vi.fn<(opts: RunWorkflowOptions) => Promise<Summary>>(),
}));

// `--skills` is only threaded correctly if the ids the CLI resolved arrive as
// `RunWorkflowOptions.selectedSkills`; the orchestrator itself is not under test
// here, so the real implementation stays the default and one case replaces it.
vi.mock('../../../src/engine/orchestrator/run/workflow.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/engine/orchestrator/run/workflow.js')>();
  const { trackWorkflow } = await import('#testing/helpers/tracked-workflow.js');
  mocks.runWorkflow.mockImplementation((opts) => trackWorkflow(actual.runWorkflow, opts));
  return { ...actual, runWorkflow: mocks.runWorkflow };
});

const TARGET_FILE = 'src/loop.ts';

function isNdjsonRecord(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

setupStartCommandIntegration();

describe('splitbrief start --plain', { timeout: 90_000 }, () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.runWorkflow.mockClear();
  });

  it('renders the run as plain lines and puts no NDJSON record on the same stdout', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp, { validation: false, codebase: false, approve: 'none' });

    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const task = makeTask({
      id: 'T001',
      action: 'create',
      suggestedFiles: [TARGET_FILE],
      title: 'Plain output backed module',
      description: 'Create a module so the plain sink has a task to report.',
      implementationSteps: ['Create src/loop.ts with the marker export.'],
      tests: ['the plain sink writes task T001: done'],
      scope: { inBounds: [TARGET_FILE], outOfBounds: ['unrelated files'] },
      evidence: ['the plain sink writes task T001: done'],
      typeDefs: 'export const loop: string',
    });

    const planner = makePlanner({
      typedCall: typedCallFromTasks([task], { inputTokens: 140, outputTokens: 90 }),
      review: vi.fn().mockResolvedValue({
        text: '# Final review\n\nPassed validation.\n\n### Verdict\npass\n',
        usage: { inputTokens: 60, outputTokens: 30 },
      }),
    });

    // The implementer writes into the dir the orchestrator hands it, which is
    // the staged copy when isolation is on.
    const implementer = makeImplementer({
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        const target = join(opts.projectDir, TARGET_FILE);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, 'export const loop = "plain";\n', 'utf-8');
        return { success: true, output: 'code', usage: { inputTokens: 100, outputTokens: 50 } };
      }),
    });

    // The seats are injected rather than spawned: this test is about which
    // stdout rendering `--plain` installs, and a real subprocess would add an
    // auth-channel gate that has nothing to do with that contract.
    const realHeadlessDeps: StartDeps = {
      ...fakeDeps,
      runHeadless: (options) =>
        runHeadless({ ...options, _planner: planner, _implementer: implementer }),
    };

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, realHeadlessDeps);
    await program.parseAsync([
      'node',
      'splitbrief',
      'start',
      '--plain',
      'run a plain-output loop',
      '--project',
      tmp,
    ]);

    const stdout = chunks.join('');
    expect(stdout).toContain('phase: planning');
    expect(stdout).toContain('task T001: done');
    expect(stdout).toContain(
      'plan check T001-K1: not run (no test command for an unrecognised stack; set validation.test_command)',
    );

    const lines = stdout.trimEnd().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(PLAIN_LINE);
      // The guarantee under test: `--plain` and `--json` never share a stream,
      // so not one line here is a public NDJSON record — not the
      // `readiness_report` the JSON rendering opens with, and not a terminal
      // `error` / `recovery_required` record either.
      expect(isNdjsonRecord(line)).toBe(false);
    }
  });

  it('prints the cause of a failed workflow on stderr before the pointer to it', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp, { validation: false, codebase: false, approve: 'none' });

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

    // A file where the session's snapshot folder belongs makes the run
    // baseline impossible, so the workflow throws after planning.
    const planner = makePlanner({
      typedCall: typedCallAnswering(() => {
        const root = sessionsRoot(tmp);
        const [sessionId = ''] = readdirSync(root);
        writeFileSync(join(root, sessionId, 'snapshots'), 'not a folder\n', 'utf-8');
        return planFromTasks([makeTask({ id: 'T001', suggestedFiles: [TARGET_FILE] })]);
      }),
    });

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, {
      ...fakeDeps,
      runHeadless: (options) =>
        runHeadless({ ...options, _planner: planner, _implementer: makeImplementer() }),
    });

    await expect(
      program.parseAsync([
        'node',
        'splitbrief',
        'start',
        '--plain',
        'fail after planning',
        '--project',
        tmp,
      ]),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: 'Workflow failed — see the error output above.',
    });

    expect(stderr).toContain(
      'The run baseline snapshot could not be initialized; workspace acquisition stopped.\n',
    );
    for (const line of stdout.join('').trimEnd().split('\n').filter(Boolean)) {
      expect(line).toMatch(PLAIN_LINE);
    }
  });

  it('keeps the terminal recovery record off a plain stdout while still failing the run', async () => {
    const tmp = getStartCommandTmp();
    writeMinimalHeadlessConfigYaml(tmp);
    const sessionId = 'sess-plain-recovery';
    ensureSessionDir(tmp, sessionId);
    writeActive({ projectDir: tmp, sessionId });

    const task = makeTask({ id: 'T001' });
    const state = transition(
      {
        ...createInitialState('recover me'),
        phase: 'implementing',
        tasks: [task],
        plannerTool: 'claude-code',
        implementerTool: 'ollama',
      },
      {
        type: 'SET_PENDING_RECOVERY',
        issue: buildRetryExhaustedRecoveryIssue({
          task,
          validationSummary: 'npm test failed',
          attempts: 2,
          createdAt: '2026-04-29T00:00:00.000Z',
        }),
      },
    );
    saveState({ projectDir: tmp, sessionId }, state);

    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // The JSON rendering answers this halt with a `recovery_required` record on
    // stdout. Under `--plain` the same halt must reach the operator only
    // through the thrown error's stderr message, or the two renderings would
    // share one stream after all.
    await expect(
      runHeadless({
        prepared: preparedHeadlessExecution({
          projectDir: tmp,
          sessionId,
          feature: 'recover me',
          resumeState: state,
        }),
        plain: true,
      }),
    ).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('Needs you ('),
    });

    const stdout = chunks.join('');
    expect(stdout).not.toContain('recovery_required');
    for (const line of stdout.trimEnd().split('\n').filter(Boolean)) {
      expect(isNdjsonRecord(line)).toBe(false);
    }
  });

  it('--skills threads into runWorkflow', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp, { validation: false, codebase: false });
    const skillDir = join(tmp, '.claude', 'skills', 'house-style');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: House style\ndescription: The house idiom\n---\n\nUse tabs.\n',
      'utf-8',
    );
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.runWorkflow.mockImplementationOnce(async () => makeSummary());

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, { ...fakeDeps, runHeadless });
    await program.parseAsync([
      'node',
      'splitbrief',
      'start',
      '--plain',
      '--skills',
      'house-style',
      'attach a skill',
      '--project',
      tmp,
    ]);

    expect(mocks.runWorkflow).toHaveBeenCalledOnce();
    expect(mocks.runWorkflow.mock.calls[0]?.[0].selectedSkills).toEqual([
      expect.objectContaining({ id: 'house-style', name: 'House style' }),
    ]);
  });

  it('unknown --skills id exits 2 with Unknown skill:', async () => {
    const tmp = getStartCommandTmp();
    writeReadyReadinessFixtures(tmp, { validation: false, codebase: false });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const program = new Command();
    program.exitOverride();
    registerStartCommand(program, fakeDeps);

    await expect(
      program.parseAsync([
        'node',
        'splitbrief',
        'start',
        '--plain',
        '--skills',
        'no-such-skill',
        'attach a skill',
        '--project',
        tmp,
      ]),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('Unknown skill: no-such-skill (scanned: '),
    });
    expect(mocks.runWorkflow).not.toHaveBeenCalled();
  });
});
