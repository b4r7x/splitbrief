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
import {
  CONFIG_FILE,
  PLAN_FILE,
  READINESS_FILE,
  SPEC_FILE,
  SPLITBRIEF_DIR,
  TASKS_FILE,
} from '../../core/paths.js';
import { defaultCliAuthChannel } from '../../core/runners/cli-tool-catalog.js';
import type { Config } from '../../core/schemas/config.js';
import type { Planner } from '../../engine/planners/types.js';
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

function plannerWithStandardPhases(): Planner {
  return makePlanner({
    plan: vi.fn().mockResolvedValue({
      spec: '# Generated Spec',
      plan: '# Generated Plan',
      tasks: [],
      usage: null,
      phases: [
        { text: '# Research', filename: 'research.md' },
        { text: '# Generated Spec', filename: SPEC_FILE },
        { text: '# Generated Plan', filename: PLAN_FILE },
        { text: '# Generated Tasks', filename: TASKS_FILE },
      ],
    }),
  });
}

function plannerWithSingleTaskPhase(): Planner {
  return makePlanner({
    plan: vi.fn().mockResolvedValue({
      spec: '',
      plan: '',
      tasks: [],
      usage: null,
      phases: [{ text: '# Generated Tasks', filename: TASKS_FILE }],
    }),
    quickPlan: vi.fn().mockResolvedValue({
      spec: '',
      plan: '',
      tasks: [],
      usage: null,
      phases: [{ text: '# Generated Tasks', filename: TASKS_FILE }],
    }),
  });
}

describe('spec --mode', () => {
  it('--help offers --mode with the shared wording and no other workflow flags', () => {
    const program = new Command();
    registerSpecCommand(program, { createPlanner: createPlannerMock });
    const specCommand = program.commands.find((command) => command.name() === 'spec');
    if (specCommand === undefined) throw new Error('expected the spec command to be registered');
    const help = specCommand.helpInformation();

    expect(help).toContain('--mode <mode>');
    expect(help).toContain('Workflow mode: instant, quick, standard, or speckit');
    const flags = [...help.matchAll(/--[\w-]+/g)].map((match) => match[0]);
    expect(new Set(flags)).toEqual(
      new Set(['--mode', '--project', '--allow-hooks', '--allow-repo-runners', '--help']),
    );
  });

  it('--mode quick writes only the tasks artifact', async () => {
    const planner = plannerWithSingleTaskPhase();
    createPlannerMock.mockResolvedValue(planner);

    await parseSpec(['--mode', 'quick', 'rename the config loader']);

    expect(vi.mocked(planner.quickPlan)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(planner.plan)).not.toHaveBeenCalled();
    const [session, ...rest] = readdirSync(sessionsRoot());
    expect(rest).toHaveLength(0);
    if (!session) throw new Error('expected one session folder');
    const files = readdirSync(join(sessionsRoot(), session)).sort();
    expect(files).toEqual([READINESS_FILE, TASKS_FILE]);
  });

  it('--mode instant uses the instant call when the planner has one', async () => {
    const instantPlan = vi.fn().mockResolvedValue({
      spec: '',
      plan: '',
      tasks: [],
      usage: null,
      phases: [{ text: '# Instant Tasks', filename: TASKS_FILE }],
    });
    const planner = makePlanner({ instantPlan });
    createPlannerMock.mockResolvedValue(planner);

    await parseSpec(['--mode', 'instant', 'fix the button']);

    expect(instantPlan).toHaveBeenCalledTimes(1);
    expect(vi.mocked(planner.quickPlan)).not.toHaveBeenCalled();
    expect(vi.mocked(planner.plan)).not.toHaveBeenCalled();
  });

  it('--mode instant falls back to the quick call when the planner has none', async () => {
    const planner = plannerWithSingleTaskPhase();
    createPlannerMock.mockResolvedValue(planner);

    await parseSpec(['--mode', 'instant', 'fix the button']);

    expect(vi.mocked(planner.quickPlan)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(planner.plan)).not.toHaveBeenCalled();
  });

  it('--mode standard writes research, spec, plan and tasks artifacts', async () => {
    const planner = plannerWithStandardPhases();
    createPlannerMock.mockResolvedValue(planner);

    await parseSpec(['--mode', 'standard', 'add health endpoint']);

    expect(vi.mocked(planner.plan)).toHaveBeenCalledTimes(1);
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
    const planner = plannerWithStandardPhases();
    createPlannerMock.mockResolvedValue(planner);

    await parseSpec(['--mode', 'speckit', 'replace the auth provider']);

    expect(vi.mocked(planner.plan)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(planner.quickPlan)).not.toHaveBeenCalled();
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
    const planner = plannerWithSingleTaskPhase();
    createPlannerMock.mockResolvedValue(planner);

    await parseSpec(['rename the config loader']);

    expect(vi.mocked(planner.quickPlan)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(planner.plan)).not.toHaveBeenCalled();
  });

  it('an explicit --mode standard wins over the config file', async () => {
    writeConfig(makeConfig({ workflow: { mode: 'quick' } }));
    const planner = plannerWithStandardPhases();
    createPlannerMock.mockResolvedValue(planner);

    await parseSpec(['--mode', 'standard', 'add health endpoint']);

    expect(vi.mocked(planner.plan)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(planner.quickPlan)).not.toHaveBeenCalled();
  });

  it('an unrecognized --mode value rejects, names the four modes, and creates no session folder', async () => {
    let caught: unknown;
    try {
      await parseSpec(['--mode', 'bogus', 'probe']);
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeTruthy();
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain('Invalid mode: bogus');
    expect(message).toContain('Must be one of: instant, quick, standard, speckit');
    expect(existsSync(sessionsRoot())).toBe(false);
    expect(createPlannerMock).not.toHaveBeenCalled();
  });

  it('prints config warnings unchanged', async () => {
    writeConfig(
      makeConfig({
        implementer: {
          kind: 'api',
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          apiKey: 'not-a-real-key',
        },
      }),
    );
    const stderrChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    createPlannerMock.mockResolvedValue(plannerWithStandardPhases());
    try {
      await parseSpec(['warn me']);
    } finally {
      stderrSpy.mockRestore();
    }

    expect(stderrChunks.join('')).toContain(
      "API key for anthropic doesn't match expected format (sk-ant-...)",
    );
  });
});
