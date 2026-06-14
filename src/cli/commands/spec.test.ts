import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { runCommand } from '#testing/helpers/commander.js';
import { DIPTYCH_DIR, SPEC_FILE } from '../../core/paths.js';

const createPlannerMock = vi.fn();

vi.mock('../../engine/runners/factory.js', () => ({
  createPlanner: (config: unknown) => createPlannerMock(config),
}));

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
  return join(tmp, DIPTYCH_DIR, 'sessions');
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
    expect(createPlannerMock).not.toHaveBeenCalled();
  });

  it('runs the planner and writes the spec artifact to the session folder', async () => {
    const program = new Command();
    program.exitOverride();
    const { registerSpecCommand } = await import('./spec.js');
    registerSpecCommand(program);

    await program.parseAsync([
      'node',
      'diptych',
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
});
