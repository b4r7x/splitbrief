import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  activateCompatibleCliShim,
  installCompatibleCliShim,
} from '#testing/helpers/compatible-cli-shim.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { CONFIG_FILE, SPLITBRIEF_DIR } from '../../core/paths.js';
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
  tmp = realpathSync(createTempDir('spec-options-test'));
  createTestGitRepo(tmp);
  // The configured planner is injected, but the readiness gate still probes
  // the config's CLI tool. Without a shim these assertions depend on whether
  // the developer's own machine is signed in to Claude Code.
  shimDir = createTempDir('spec-options-shim');
  restoreCompatibleCliShim = activateCompatibleCliShim(
    installCompatibleCliShim({
      directory: shimDir,
      tool: 'claude-code',
      authChannel: defaultCliAuthChannel('claude-code').id,
    }),
    'test-only-spec-options-shim-key',
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

describe('spec options and config notices', () => {
  it('--help offers no workflow mode: one planning session serves every feature', () => {
    const program = new Command();
    registerSpecCommand(program, { createPlanner: createPlannerMock });
    const specCommand = program.commands.find((command) => command.name() === 'spec');
    if (specCommand === undefined) throw new Error('expected the spec command to be registered');
    const help = specCommand.helpInformation();

    const flags = [...help.matchAll(/--[\w-]+/g)].map((match) => match[0]);
    expect(new Set(flags)).toEqual(
      new Set(['--project', '--allow-hooks', '--allow-repo-runners', '--help']),
    );
  });

  it('prints the retired workflow.mode notice once for a config file that still sets a mode', async () => {
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
    const planner = makePlanner();
    createPlannerMock.mockResolvedValue(planner);
    try {
      await parseSpec(['fix the button']);
    } finally {
      stderrSpy.mockRestore();
    }

    expect(planner.typedCall).toHaveBeenCalledTimes(1);
    expect(
      stderrChunks.filter((chunk) => chunk.includes('workflow.mode was retired')),
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
    createPlannerMock.mockResolvedValue(makePlanner());
    try {
      await parseSpec(['warn me']);
    } finally {
      stderrSpy.mockRestore();
    }

    expect(stderrChunks.join('')).toContain('implementer.args contains {prompt}');
  });
});
