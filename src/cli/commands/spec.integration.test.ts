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
  PLAN_JSON_FILE,
  SPLITBRIEF_DIR,
  TASKS_FILE,
} from '../../core/paths.js';
import { defaultCliAuthChannel } from '../../core/runners/cli-tool-catalog.js';
import type { Config } from '../../core/schemas/config.js';
import type { Planner } from '../../engine/planners/types.js';
import {
  planFromTasks,
  scriptedTypedCall,
  typedCallAnswering,
  typedCallFromTasks,
} from '#testing/helpers/typed-planner.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { saveDetectionCache } from '../../engine/detection/cache.js';
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
  createPlannerMock.mockResolvedValue(makePlanner());
});

afterEach(() => {
  restoreCompatibleCliShim?.();
  restoreCompatibleCliShim = undefined;
  cleanupTempDir(shimDir);
  if (tmp) cleanupTempDir(tmp);
  consoleSpy.mockRestore();
  modelCacheStore.reset();
});

function sessionsRoot(): string {
  return join(tmp, SPLITBRIEF_DIR, 'sessions');
}

function writeConfig(config: Config): void {
  mkdirSync(join(tmp, SPLITBRIEF_DIR), { recursive: true });
  writeFileSync(join(tmp, SPLITBRIEF_DIR, CONFIG_FILE), JSON.stringify(config, null, 2));
}

describe('spec command', () => {
  it('writes frontmatter with the remembered catalog name in both documents', async () => {
    writeConfig(makeConfig({ implementer: { kind: 'cli', tool: 'codex', model: 'gpt-6-luna' } }));
    await saveDetectionCache({
      projectDir: tmp,
      snapshot: {
        contextKey: 'remembered',
        fetchedAt: 1,
        validatedAt: 1,
        generation: 1,
        requestId: 1,
        providers: [],
        cliTools: [],
        cliCatalogs: [
          { tool: 'codex', models: [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }], probedAt: 1 },
        ],
      },
    });
    const program = new Command();
    registerSpecCommand(program, { createPlanner: createPlannerMock });
    await program.parseAsync(['node', 'splitbrief', 'spec', '--project', tmp, 'catalog names']);
    const [session] = readdirSync(sessionsRoot());
    if (session === undefined) throw new Error('Expected a planning session');
    for (const name of [PLAN_FILE, TASKS_FILE]) {
      const text = readFileSync(join(sessionsRoot(), session, name), 'utf8');
      expect(text).toContain('implementer: OpenAI Codex CLI · GPT-6-Luna');
      expect(text).not.toContain('GPT-6 Luna');
    }
  });

  it('constructs the planner from the resolved config', async () => {
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

    expect(createPlannerMock).toHaveBeenCalledOnce();
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
    expect(stdout).toContain('PLAN could not start.');
    expect(stdout).toContain('Configured command is outside the current trust policy.');
    expect(stdout).toContain(
      'Fix: Use a system-installed command, or run `splitbrief spec --allow-repo-runners`.',
    );
    expect(stdout).not.toContain('runners.preparation.planner');
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
    const planPath = join(sessionsRoot(), session, PLAN_FILE);
    expect(readFileSync(planPath, 'utf8')).toContain('Plan from the scripted briefs');
  });

  it('prints the planner questions without terminal controls and takes their defaults without a TTY', async () => {
    const typed = scriptedTypedCall([
      {
        kind: 'questions',
        questions: [
          {
            id: 'store',
            text: '\u001b]52;c;clipboard-secret\u0007Which store?\u009b2K',
            choices: ['sqlite', 'postgres'],
            default: 'sqlite',
          },
        ],
      },
      planFromTasks([makeTask()]),
    ]);
    createPlannerMock.mockResolvedValue(makePlanner({ typedCall: typed.typedCall }));
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

    const logged = consoleSpy.mock.calls.map((args) => String(args[0])).join('\n');
    // The CLI's own styling is ANSI; the planner's text arrives with none of its controls.
    expect(logged).toContain('\n1. Which store? (default: sqlite)\n');
    expect(logged).not.toContain('clipboard-secret');
    expect(logged).not.toContain('\u001b]');
    expect(logged).not.toContain('\u0007');
    expect(logged).not.toContain('\u009b');
    expect(typed.prompts).toHaveLength(2);
    expect(typed.prompts[1]).toContain('sqlite');
  });

  it('sends render checks back once without validation.render, then names them in plan.md', async () => {
    const base = planFromTasks([makeTask()]);
    const withRender = {
      ...base,
      checks: [
        ...base.checks,
        { id: 'K-render', kind: 'render' as const, value: 'overlay-picker', required: true },
      ],
    };
    const typed = scriptedTypedCall([withRender, withRender]);
    createPlannerMock.mockResolvedValue(makePlanner({ typedCall: typed.typedCall }));
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

    expect(typed.prompts).toHaveLength(2);
    expect(typed.prompts[1]).toContain('Render check K-render needs validation.render');
    const [session] = readdirSync(sessionsRoot());
    if (!session) throw new Error('expected one session folder');
    const card = readFileSync(join(sessionsRoot(), session, PLAN_FILE), 'utf8');
    expect(card).toContain('## Before you approve');
    expect(card).toContain('Render check K-render needs validation.render');
  });

  it('tells the planner the BUILD context the model catalog publishes, as a run does', async () => {
    writeConfig(
      makeConfig({ implementer: { kind: 'cli', tool: 'claude-code', model: 'claude-opus-5' } }),
    );
    modelCacheStore.hydrateModelsDevCatalog({
      catalog: {
        anthropic: {
          id: 'anthropic',
          models: { 'claude-opus-5': { id: 'claude-opus-5', limit: { context: 765_432 } } },
        },
      },
      fetchedAt: 1,
      validatedAt: 1,
    });
    const typed = scriptedTypedCall([planFromTasks([makeTask()])]);
    createPlannerMock.mockResolvedValue(makePlanner({ typedCall: typed.typedCall }));
    const program = new Command();
    program.exitOverride();
    registerSpecCommand(program, { createPlanner: createPlannerMock });

    try {
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
      modelCacheStore.reset();
    }

    expect(typed.prompts[0]).toContain('a measured context of 765,432 tokens');
  });

  describe('with a planner that reads no files of its own', () => {
    const context = (applicationContextTokens: number) => async () => ({
      contextKey: 'ollama@local',
      selectionId: 'qwen2.5',
      observedAt: 0,
      applicationContextTokens,
      budgetSource: 'configured' as const,
      loadState: 'unknown' as const,
    });
    const request = 'Modify `src/hello.ts` so it greets people by name.';

    function runSpec(): Promise<Command> {
      mkdirSync(join(tmp, 'src'), { recursive: true });
      writeFileSync(join(tmp, 'src', 'hello.ts'), 'export const HELLO_SENTINEL = 1;\n');
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
        request,
      ]);
    }

    it('carries the current source of the files the request names in its first prompt', async () => {
      const typed = scriptedTypedCall([planFromTasks([makeTask()])]);
      createPlannerMock.mockResolvedValue(
        makePlanner({ typedCall: typed.typedCall, resolvePlanningContext: context(64_000) }),
      );

      await runSpec();

      expect(typed.prompts[0]).toContain('export const HELLO_SENTINEL = 1;');
      expect(typed.prompts[0]).toContain('src/hello.ts — whole file, sha256');
    });

    it('fails before any call when the named source does not fit the model', async () => {
      const typed = scriptedTypedCall([planFromTasks([makeTask()])]);
      createPlannerMock.mockResolvedValue(
        makePlanner({ typedCall: typed.typedCall, resolvePlanningContext: context(2_200) }),
      );

      await expect(runSpec()).rejects.toThrow(/does not fit the seat.s context window/);
      expect(typed.prompts).toEqual([]);
    });
  });
});

describe('spec command — reporting', () => {
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

  it('names the planner on the pre-planning line', async () => {
    writeConfig(
      makeConfig({
        planner: { kind: 'shell', command: './scripts/planner', model: 'planner-default' },
      }),
    );

    await runSpec(['--allow-repo-runners', 'add health endpoint']);

    const line = loggedOutput()
      .split('\n')
      .find((l) => l.startsWith('Planning feature:'));
    expect(line).toBeDefined();
    expect(line).toContain('(planner: shell)');
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

  it('lists plan.json, plan.md and tasks.md with absolute paths that exist on disk', async () => {
    await runSpec(['add health endpoint']);

    const [session, ...rest] = readdirSync(sessionsRoot());
    expect(rest).toHaveLength(0);
    if (!session) throw new Error('expected one session folder');
    const sessionPath = join(sessionsRoot(), session);
    const logged = loggedOutput();
    for (const filename of [PLAN_JSON_FILE, PLAN_FILE, TASKS_FILE]) {
      expect(logged).toContain(`${sessionPath}/${filename}`);
      expect(existsSync(join(sessionPath, filename))).toBe(true);
    }
  });

  it('reports the task count exactly once, on the tasks line', async () => {
    createPlannerMock.mockResolvedValue(
      makePlanner({
        typedCall: typedCallFromTasks([
          makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] }),
          makeTask({ id: 'T002', suggestedFiles: ['src/b.ts'] }),
        ]),
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
        typedCall: typedCallAnswering(() => {
          throw new Error('planner exploded');
        }),
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

  const question = (round: number) => ({
    kind: 'questions' as const,
    questions: [{ id: `q${round}`, text: `Round ${round}?`, choices: null, default: 'yes' }],
  });
  const uncovered = {
    ...planFromTasks([makeTask()]),
    criteria: [
      { id: 'C1', text: 'The briefs are built', checkIds: ['T001-K1'] },
      { id: 'C2', text: 'Nothing serves this', checkIds: ['T001-K1'] },
    ],
  };

  it.each([
    [
      'a third round of questions',
      [question(1), question(2), question(3)],
      'The planner asked a third round of questions; a session takes 2.',
    ],
    [
      'a plan that fails its checks again after one repair',
      [uncovered, uncovered],
      'The plan failed its checks again after one repair:\n- Criterion C2 is served by no task.',
    ],
  ] as const)(
    'fails on %s and leaves no session directory behind',
    async (_label, script, message) => {
      createPlannerMock.mockResolvedValue(
        makePlanner({ typedCall: scriptedTypedCall([...script]).typedCall }),
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
      ).rejects.toThrow(message);

      if (existsSync(sessionsRoot())) {
        expect(readdirSync(sessionsRoot(), { withFileTypes: true })).toHaveLength(0);
      }
      expect(existsSync(join(tmp, SPLITBRIEF_DIR, 'active'))).toBe(false);
    },
  );

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
    expect(readFileSync(join(sessionPath, PLAN_FILE), 'utf8')).toContain(
      'Plan from the scripted briefs',
    );
    expect(existsSync(join(sessionPath, '.prepare-owner.json'))).toBe(false);
  });
});
