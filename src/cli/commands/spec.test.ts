import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { runCommand } from '#testing/helpers/commander.js';
import { CONFIG_FILE, SPLITBRIEF_DIR, SPEC_FILE } from '../../core/paths.js';
import type { Config } from '../../core/schemas/config.js';
import type { Planner } from '../../engine/planners/types.js';
import { registerSpecCommand } from './spec.js';

const createPlannerMock = vi.fn<(config: Config) => Promise<Planner>>();

let tmp: string;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = realpathSync(createTempDir('spec-command-test'));
  createTestGitRepo(tmp);
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
  it('rejects the removed --auto flag', async () => {
    const { exitCode, stderr } = await runCommand([
      'spec',
      '--auto',
      '--project',
      tmp,
      'add health endpoint',
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/unknown option.*--auto/i);
  });

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
    ).rejects.toMatchObject({ kind: 'runner-not-trusted' });
    if (existsSync(sessionsRoot())) {
      expect(readdirSync(sessionsRoot(), { withFileTypes: true })).toHaveLength(0);
    }
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
