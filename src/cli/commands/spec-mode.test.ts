import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  activateCompatibleCliShim,
  installCompatibleCliShim,
} from '#testing/helpers/compatible-cli-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { CONFIG_FILE, READINESS_FILE, SPLITBRIEF_DIR, TASKS_FILE } from '../../core/paths.js';
import { defaultCliAuthChannel } from '../../core/runners/cli-tool-catalog.js';
import { RETIRED_WORKFLOW_MODE_NOTICE } from '../../core/schemas/enums.js';
import type { Config } from '../../core/schemas/config.js';
import type { Planner, PlannerDocumentCall, RunPhaseInput } from '../../engine/planners/types.js';
import { makePhaseCallResult } from '#testing/helpers/factories/phase-call.js';
import { registerSpecCommand } from './spec.js';

const createPlannerMock = vi.fn<(config: Config) => Promise<Planner>>();

let tmp: string;
let shimDir: string;
let restoreCompatibleCliShim: (() => void) | undefined;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = realpathSync(createTempDir('spec-mode-test'));
  createTestGitRepo(tmp);
  // The configured planner is injected, but the readiness gate still probes
  // the config's CLI tool. Without a shim these assertions depend on whether
  // the developer's own machine is signed in to Claude Code.
  shimDir = createTempDir('spec-mode-shim');
  restoreCompatibleCliShim = activateCompatibleCliShim(
    installCompatibleCliShim({
      directory: shimDir,
      tool: 'claude-code',
      authChannel: defaultCliAuthChannel('claude-code').id,
    }),
    'test-only-spec-mode-shim-key',
  );
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  createPlannerMock.mockReset();
});

afterEach(() => {
  restoreCompatibleCliShim?.();
  restoreCompatibleCliShim = undefined;
  cleanupTempDir(shimDir);
  if (tmp) cleanupTempDir(tmp);
  consoleSpy.mockRestore();
});

function sessionsRoot(): string {
  return join(tmp, SPLITBRIEF_DIR, 'sessions');
}

function writeConfig(config: Config): void {
  mkdirSync(join(tmp, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(join(tmp, SPLITBRIEF_DIR, CONFIG_FILE), JSON.stringify(config, null, 2));
}

function parseSpec(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  registerSpecCommand(program, { createPlanner: createPlannerMock });
  return program.parseAsync([
    'node',
    'splitbrief',
    'spec',
    '--project',
    tmp,
    '--allow-hooks',
    ...args,
  ]);
}

const PHASE_TEXT: Record<PlannerDocumentCall, string> = {
  research: '# Research',
  spec: '# Generated Spec',
  plan: '# Generated Plan',
  tasks: '# Generated Tasks',
};

function plannerRecordingPhases(): Planner {
  return makePlanner({
    runPhase: vi.fn(async ({ call }: RunPhaseInput) =>
      makePhaseCallResult({ call, text: PHASE_TEXT[call], ...(call === 'tasks' && { tasks: [] }) }),
    ),
  });
}

function calledPhases(planner: Planner): string[] {
  return vi.mocked(planner.runPhase).mock.calls.map((call) => call[0].call);
}

describe('spec --mode', () => {
  it('--help offers --mode with the shared wording and no other workflow flags', () => {
    const program = new Command();
    registerSpecCommand(program, { createPlanner: createPlannerMock });
    const specCommand = program.commands.find((command) => command.name() === 'spec');
    if (specCommand === undefined) throw new Error('expected the spec command to be registered');
    const help = specCommand.helpInformation();

    expect(help).toContain('--mode <mode>');
    expect(help).toContain('Workflow mode: quick, standard, or speckit');
    const flags = [...help.matchAll(/--[\w-]+/g)].map((match) => match[0]);
    expect(new Set(flags)).toEqual(
      new Set(['--mode', '--project', '--allow-hooks', '--allow-repo-runners', '--help']),
    );
  });

  it('--mode quick writes only the tasks artifact', async () => {
    const planner = plannerRecordingPhases();
    createPlannerMock.mockResolvedValue(planner);

    await parseSpec(['--mode', 'quick', 'rename the config loader']);

    expect(calledPhases(planner)).toEqual(['tasks']);
    const [session, ...rest] = readdirSync(sessionsRoot());
    expect(rest).toHaveLength(0);
    if (!session) throw new Error('expected one session folder');
    const files = readdirSync(join(sessionsRoot(), session)).sort();
    expect(files).toEqual([READINESS_FILE, TASKS_FILE]);
  });

  it('runs the quick planner call when --mode instant is given', async () => {
    const planner = plannerRecordingPhases();
    createPlannerMock.mockResolvedValue(planner);

    await parseSpec(['--mode', 'instant', 'fix the button']);

    expect(calledPhases(planner)).toEqual(['tasks']);
  });

  it('--mode standard writes research, spec, plan and tasks artifacts', async () => {
    const planner = plannerRecordingPhases();
    createPlannerMock.mockResolvedValue(planner);

    await parseSpec(['--mode', 'standard', 'add health endpoint']);

    expect(calledPhases(planner)).toEqual(['research', 'spec', 'plan', 'tasks']);
    const [session, ...rest] = readdirSync(sessionsRoot());
    expect(rest).toHaveLength(0);
    if (!session) throw new Error('expected one session folder');
    expect(readdirSync(join(sessionsRoot(), session)).sort()).toEqual([
      'plan.md',
      READINESS_FILE,
      'research.md',
      'spec.md',
      TASKS_FILE,
    ]);
  });

  it('--mode speckit writes the same artifact set as --mode standard', async () => {
    const planner = plannerRecordingPhases();
    createPlannerMock.mockResolvedValue(planner);

    await parseSpec(['--mode', 'speckit', 'replace the auth provider']);

    expect(calledPhases(planner)).toEqual(['research', 'spec', 'plan', 'tasks']);
    const [session, ...rest] = readdirSync(sessionsRoot());
    expect(rest).toHaveLength(0);
    if (!session) throw new Error('expected one session folder');
    expect(readdirSync(join(sessionsRoot(), session)).sort()).toEqual([
      'plan.md',
      READINESS_FILE,
      'research.md',
      'spec.md',
      TASKS_FILE,
    ]);
  });

  it('with no flag, a config-file workflow.mode: quick selects the single-call route', async () => {
    writeConfig(makeConfig({ workflow: { mode: 'quick' } }));
    const planner = plannerRecordingPhases();
    createPlannerMock.mockResolvedValue(planner);

    await parseSpec(['rename the config loader']);

    expect(calledPhases(planner)).toEqual(['tasks']);
  });

  it('an explicit --mode standard wins over the config file', async () => {
    writeConfig(makeConfig({ workflow: { mode: 'quick' } }));
    const planner = plannerRecordingPhases();
    createPlannerMock.mockResolvedValue(planner);

    await parseSpec(['--mode', 'standard', 'add health endpoint']);

    expect(calledPhases(planner)).toEqual(['research', 'spec', 'plan', 'tasks']);
  });

  it('an unrecognized --mode value rejects, names the three modes, and creates no session folder', async () => {
    let caught: unknown;
    try {
      await parseSpec(['--mode', 'bogus', 'probe']);
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeTruthy();
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain('Invalid mode: bogus');
    expect(message).toContain('Must be one of: quick, standard, speckit');
    expect(existsSync(sessionsRoot())).toBe(false);
    expect(createPlannerMock).not.toHaveBeenCalled();
  });

  it('prints the retired-mode notice for a config file that still sets mode: instant', async () => {
    mkdirSync(join(tmp, SPLITBRIEF_DIR), { recursive: true });
    const config = makeConfig();
    writeFileSync(
      join(tmp, SPLITBRIEF_DIR, CONFIG_FILE),
      JSON.stringify({ ...config, workflow: { ...config.workflow, mode: 'instant' } }, null, 2),
    );
    const stderrChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    const planner = plannerRecordingPhases();
    createPlannerMock.mockResolvedValue(planner);
    try {
      await parseSpec(['fix the button']);
    } finally {
      stderrSpy.mockRestore();
    }

    expect(calledPhases(planner)).toEqual(['tasks']);
    expect(
      stderrChunks.filter((chunk) => chunk.includes(RETIRED_WORKFLOW_MODE_NOTICE)),
    ).toHaveLength(1);
  });

  it('prints config warnings unchanged', async () => {
    writeConfig(
      makeConfig({
        implementer: {
          kind: 'shell',
          command: 'my-implementer',
          args: ['--task', '{prompt}'],
          model: 'custom-model',
        },
      }),
    );
    const stderrChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    createPlannerMock.mockResolvedValue(plannerRecordingPhases());
    try {
      await parseSpec(['warn me']);
    } finally {
      stderrSpy.mockRestore();
    }

    expect(stderrChunks.join('')).toContain('implementer.args contains {prompt}');
  });
});
