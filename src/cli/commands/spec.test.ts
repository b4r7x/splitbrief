import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { Command } from 'commander';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  activateCompatibleCliShim,
  installCompatibleCliShim,
} from '#testing/helpers/compatible-cli-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import {
  CONFIG_FILE,
  PLAN_FILE,
  RESEARCH_FILE,
  SPLITBRIEF_DIR,
  SPEC_FILE,
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
let consoleSpy: MockInstance<typeof console.log>;

beforeEach(() => {
  tmp = realpathSync(createTempDir('spec-command-test'));
  createTestGitRepo(tmp);
  // The configured planner is injected, but the readiness gate still probes
  // the config's CLI tool. Without a shim these assertions depend on whether
  // the developer's own machine is signed in to Claude Code.
  shimDir = createTempDir('spec-command-shim');
  restoreCompatibleCliShim = activateCompatibleCliShim(
    installCompatibleCliShim({
      directory: shimDir,
      tool: 'claude-code',
      authChannel: defaultCliAuthChannel('claude-code').id,
    }),
    'test-only-spec-command-shim-key',
  );
  // A repo-local planner command is only admissible with --allow-repo-runners,
  // and admission resolves the executable, so the fixture ships a real one.
  mkdirSync(join(tmp, 'scripts'), { recursive: true });
  writeFileSync(join(tmp, 'scripts', 'planner'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(join(tmp, 'scripts', 'planner'), 0o755);
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  createPlannerMock.mockReset();
  createPlannerMock.mockResolvedValue(
    makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Generated Spec',
        plan: '# Generated Plan',
        tasks: [],
        usage: null,
        phases: [{ text: '# Generated Spec', filename: SPEC_FILE }],
      }),
    }),
  );
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

describe('spec command', () => {
  it('runs the planner and writes the spec artifact to the session folder', async () => {
    const program = new Command();
    program.exitOverride();
    registerSpecCommand(program, { createPlanner: createPlannerMock });

    await program.parseAsync([
      'node',
      'splitbrief',
      'spec',
      '--project',
      tmp,
      '--allow-hooks',
      'add health endpoint',
    ]);

    const [session, ...rest] = readdirSync(sessionsRoot());
    expect(rest).toHaveLength(0);
    if (!session) throw new Error('expected one session folder');
    const specPath = join(sessionsRoot(), session, SPEC_FILE);
    expect(readFileSync(specPath, 'utf8')).toContain('# Generated Spec');
  });

  it('does not let --allow-hooks authorize repo-local planner commands', async () => {
    writeConfig(
      makeConfig({
        planner: { kind: 'shell', command: './scripts/planner', model: 'planner-default' },
      }),
    );
    const program = new Command();
    program.exitOverride();
    registerSpecCommand(program, { createPlanner: createPlannerMock });

    await expect(
      program.parseAsync([
        'node',
        'splitbrief',
        'spec',
        '--project',
        tmp,
        '--allow-hooks',
        'add health endpoint',
      ]),
    ).rejects.toMatchObject({
      kind: 'cli-error',
      message: expect.stringContaining('readiness blocked'),
    });
    if (existsSync(sessionsRoot())) {
      expect(readdirSync(sessionsRoot(), { withFileTypes: true })).toHaveLength(0);
    }
  });

  it('prints the blockers its error message points at, with no TTY', async () => {
    writeConfig(
      makeConfig({
        planner: { kind: 'shell', command: './scripts/planner', model: 'planner-default' },
      }),
    );
    const program = new Command();
    program.exitOverride();
    registerSpecCommand(program, { createPlanner: createPlannerMock });

    await expect(
      program.parseAsync([
        'node',
        'splitbrief',
        'spec',
        '--project',
        tmp,
        '--allow-hooks',
        'add health endpoint',
      ]),
    ).rejects.toMatchObject({ kind: 'cli-error' });

    const stdout = consoleSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(stdout).toContain('Run readiness: blocked');
    expect(stdout).toContain('runners.preparation.planner');
  });

  it('allows repo-local planner commands with --allow-repo-runners', async () => {
    writeConfig(
      makeConfig({
        planner: { kind: 'shell', command: './scripts/planner', model: 'planner-default' },
      }),
    );
    const program = new Command();
    program.exitOverride();
    registerSpecCommand(program, { createPlanner: createPlannerMock });

    await program.parseAsync([
      'node',
      'splitbrief',
      'spec',
      '--project',
      tmp,
      '--allow-hooks',
      '--allow-repo-runners',
      'add health endpoint',
    ]);

    const [session, ...rest] = readdirSync(sessionsRoot());
    expect(rest).toHaveLength(0);
    if (!session) throw new Error('expected one session folder');
    const specPath = join(sessionsRoot(), session, SPEC_FILE);
    expect(readFileSync(specPath, 'utf8')).toContain('# Generated Spec');
  });

  it('strips terminal controls from streamed planner output', async () => {
    const stdoutChunks: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    createPlannerMock.mockResolvedValue(
      makePlanner({
        plan: vi.fn().mockImplementation(async ({ callbacks }) => {
          callbacks.onOutput('\u001b]52;c;clipboard-secret\u0007visible\u009b2K');
          return {
            spec: '# Generated Spec',
            plan: '# Generated Plan',
            tasks: [],
            usage: null,
            phases: [{ text: '# Generated Spec', filename: SPEC_FILE }],
          };
        }),
      }),
    );

    try {
      const program = new Command();
      program.exitOverride();
      registerSpecCommand(program, { createPlanner: createPlannerMock });

      await program.parseAsync([
        'node',
        'splitbrief',
        'spec',
        '--project',
        tmp,
        '--allow-hooks',
        'add health endpoint',
      ]);
    } finally {
      stdoutSpy.mockRestore();
    }

    const stdout = stdoutChunks.join('');
    expect(stdout).toContain('visible');
    expect(stdout).not.toContain('clipboard-secret');
    expect(stdout).not.toContain('\u001b');
    expect(stdout).not.toContain('\u0007');
    expect(stdout).not.toContain('\u009b');
  });
});

describe('spec command — resolved-mode reporting', () => {
  function runSpec(args: string[]): Promise<Command> {
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

  function loggedOutput(): string {
    return consoleSpy.mock.calls.map((args) => String(args[0])).join('\n');
  }

  function standardPhases() {
    return [
      { text: '# Research', filename: RESEARCH_FILE },
      { text: '# Spec', filename: SPEC_FILE },
      { text: '# Plan', filename: PLAN_FILE },
      { text: '# Tasks', filename: TASKS_FILE },
    ];
  }

  it('names the planner and the resolved mode on the pre-planning line', async () => {
    writeConfig(
      makeConfig({
        planner: { kind: 'shell', command: './scripts/planner', model: 'planner-default' },
      }),
    );

    await runSpec(['--allow-repo-runners', '--mode', 'quick', 'add health endpoint']);

    const line = loggedOutput()
      .split('\n')
      .find((l) => l.startsWith('Planning feature:'));
    expect(line).toBeDefined();
    expect(line).toContain('(planner: shell, mode: quick)');
  });

  it('strips terminal control bytes from the feature argument', async () => {
    await runSpec(['\u001b]52;c;clipboard-secret\u0007visible\u009b2K feature']);

    const line = loggedOutput()
      .split('\n')
      .find((l) => l.startsWith('Planning feature:'));
    expect(line).toBeDefined();
    expect(line).toContain('visible feature');
    expect(line).not.toContain('clipboard-secret');
    expect(line).not.toContain('\u001b');
    expect(line).not.toContain('\u0007');
    expect(line).not.toContain('\u009b');
  });

  it('reports only tasks.md in quick mode', async () => {
    createPlannerMock.mockResolvedValue(
      makePlanner({
        quickPlan: vi.fn().mockResolvedValue({
          spec: '',
          plan: '',
          tasks: [makeTask()],
          usage: null,
          phases: [{ text: '# Tasks', filename: TASKS_FILE }],
        }),
      }),
    );

    await runSpec(['--mode', 'quick', 'add health endpoint']);

    const logged = loggedOutput();
    expect(logged).toContain('/tasks.md');
    expect(logged).not.toContain('spec.md');
    expect(logged).not.toContain('plan.md');
  });

  it('lists research, spec, plan and tasks with absolute paths that exist on disk', async () => {
    createPlannerMock.mockResolvedValue(
      makePlanner({
        plan: vi.fn().mockResolvedValue({
          spec: '# Spec',
          plan: '# Plan',
          tasks: [],
          usage: null,
          phases: standardPhases(),
        }),
      }),
    );

    await runSpec(['add health endpoint']);

    const [session, ...rest] = readdirSync(sessionsRoot());
    expect(rest).toHaveLength(0);
    if (!session) throw new Error('expected one session folder');
    const sessionPath = join(sessionsRoot(), session);
    const logged = loggedOutput();
    for (const filename of [RESEARCH_FILE, SPEC_FILE, PLAN_FILE, TASKS_FILE]) {
      expect(logged).toContain(`${sessionPath}/${filename}`);
      expect(existsSync(join(sessionPath, filename))).toBe(true);
    }
  });

  it('reports the task count exactly once, on the tasks line', async () => {
    createPlannerMock.mockResolvedValue(
      makePlanner({
        plan: vi.fn().mockResolvedValue({
          spec: '# Spec',
          plan: '# Plan',
          tasks: [makeTask(), makeTask()],
          usage: null,
          phases: standardPhases(),
        }),
      }),
    );

    await runSpec(['add health endpoint']);

    const logged = loggedOutput();
    expect(logged.match(/\(\d+ tasks\)/g) ?? []).toEqual(['(2 tasks)']);
    const tasksLine = logged.split('\n').find((line) => line.includes('/tasks.md'));
    expect(tasksLine).toBeDefined();
    expect(tasksLine).toContain('(2 tasks)');
  });
});

describe('spec command — preparation ownership across the planner call', () => {
  it('a failing planner call leaves no session directory behind and clears the active pointer', async () => {
    createPlannerMock.mockResolvedValue(
      makePlanner({
        plan: vi.fn().mockRejectedValue(new Error('planner exploded')),
      }),
    );
    const program = new Command();
    program.exitOverride();
    registerSpecCommand(program, { createPlanner: createPlannerMock });

    await expect(
      program.parseAsync([
        'node',
        'splitbrief',
        'spec',
        '--project',
        tmp,
        '--allow-hooks',
        'add health endpoint',
      ]),
    ).rejects.toThrow('planner exploded');

    if (existsSync(sessionsRoot())) {
      expect(readdirSync(sessionsRoot(), { withFileTypes: true })).toHaveLength(0);
    }
    expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'active'))).toBe(false);
  });

  it('a successful planner call keeps the session directory and its artifacts, with no ownership marker left over', async () => {
    const program = new Command();
    program.exitOverride();
    registerSpecCommand(program, { createPlanner: createPlannerMock });

    await program.parseAsync([
      'node',
      'splitbrief',
      'spec',
      '--project',
      tmp,
      '--allow-hooks',
      'add health endpoint',
    ]);

    const [session, ...rest] = readdirSync(sessionsRoot());
    expect(rest).toHaveLength(0);
    if (!session) throw new Error('expected one session folder');
    const sessionPath = join(sessionsRoot(), session);
    expect(readFileSync(join(sessionPath, SPEC_FILE), 'utf8')).toContain('# Generated Spec');
    expect(existsSync(join(sessionPath, '.prepare-owner.json'))).toBe(false);
  });
});
