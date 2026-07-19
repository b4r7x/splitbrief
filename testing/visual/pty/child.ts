import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { createDefaultConfig, writeConfig } from '../../../src/core/config/load/io.js';
import { registerStartCommand, type StartDeps } from '../../../src/cli/commands/start.js';
import { renderApp as productionRenderApp } from '../../../src/cli/render.js';
import { stripTerminalControls } from '../../../src/utils/display-text.js';
import { createTestGitRepo } from '../../helpers/git.js';
import { cleanupTempDir, createTempDir } from '../../helpers/temp-dir.js';
import { findVisualScenario } from '../catalog.js';
import { createHomeFixture } from '../fixtures/screen-fixtures.js';

export const PTY_CHILD_SCENARIO = 'home-empty';
export const PTY_CHILD_OUTPUT = 'terminal';
export const PTY_CHILD_MARKER = 'No recent sessions';
export const PTY_CHILD_EXIT_INPUT = '\x11';
export const PTY_CHILD_VIEWPORT = Object.freeze({ cols: 80, rows: 24 });

export interface PtyChildOptions {
  readonly scenario: typeof PTY_CHILD_SCENARIO;
  readonly output: typeof PTY_CHILD_OUTPUT;
}

export interface SyntheticPtyProject {
  readonly projectDir: string;
  readonly cleanup: () => void;
}

export interface PtyChildDependencies {
  readonly createProject: () => SyntheticPtyProject;
  readonly renderApp: StartDeps['renderApp'];
}

export interface PtyChildResult {
  readonly scenario: typeof PTY_CHILD_SCENARIO;
  readonly output: typeof PTY_CHILD_OUTPUT;
  readonly projectDir: string;
}

const DEFAULT_DEPENDENCIES: PtyChildDependencies = {
  createProject: createSyntheticPtyProject,
  renderApp: productionRenderApp,
};

export function parsePtyChildArgs(argv: readonly string[]): PtyChildOptions {
  let scenario: string = PTY_CHILD_SCENARIO;
  let output: string = PTY_CHILD_OUTPUT;
  let sawScenario = false;
  let sawOutput = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--scenario') {
      if (sawScenario) throw new Error('PTY child accepts --scenario only once');
      scenario = requiredOptionValue(argv, index, '--scenario');
      sawScenario = true;
      index += 1;
      continue;
    }
    if (argument === '--output') {
      if (sawOutput) throw new Error('PTY child accepts --output only once');
      output = requiredOptionValue(argv, index, '--output');
      sawOutput = true;
      index += 1;
      continue;
    }
    throw new Error('PTY child received an unknown argument');
  }

  if (scenario !== PTY_CHILD_SCENARIO) {
    throw new Error('PTY child supports only the home-empty scenario');
  }
  if (output !== PTY_CHILD_OUTPUT) {
    throw new Error('PTY child supports only terminal output');
  }
  return { scenario, output };
}

export function createSyntheticPtyProject(): SyntheticPtyProject {
  const projectDir = realpathSync(createTempDir('diptych-pty-child'));
  try {
    createTestGitRepo(projectDir, {
      'README.md': '# Synthetic PTY fixture\n',
    });
    const defaults = createDefaultConfig();
    writeConfig(projectDir, {
      ...defaults,
      validation: { typecheck: false, lint: false, test: false },
      workflow: {
        ...defaults.workflow,
        persistTranscript: false,
        git: { commitStrategy: 'none' },
      },
    });
  } catch (error) {
    cleanupTempDir(projectDir);
    throw error;
  }

  let cleaned = false;
  return {
    projectDir,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      cleanupTempDir(projectDir);
    },
  };
}

export async function runPtyChild(
  argv: readonly string[],
  dependencies: PtyChildDependencies = DEFAULT_DEPENDENCIES,
): Promise<PtyChildResult> {
  const options = parsePtyChildArgs(argv);
  const project = dependencies.createProject();
  const scenario = findVisualScenario(options.scenario);
  const checkpoint = scenario?.checkpoints[0];
  if (!scenario || !checkpoint || checkpoint.marker !== PTY_CHILD_MARKER) {
    project.cleanup();
    throw new Error('PTY child home fixture contract is unavailable');
  }

  const fixture = createHomeFixture();
  let fixturePrepared = false;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (fixturePrepared) void fixture.teardown();
    project.cleanup();
  };
  process.once('exit', cleanup);

  try {
    await fixture.setup({ scenario, checkpoint, viewport: PTY_CHILD_VIEWPORT });
    fixturePrepared = true;
    await runProductionStart({
      projectDir: project.projectDir,
      renderApp: dependencies.renderApp,
    });
    return { ...options, projectDir: project.projectDir };
  } finally {
    process.off('exit', cleanup);
    cleanup();
  }
}

async function runProductionStart(options: {
  readonly projectDir: string;
  readonly renderApp: StartDeps['renderApp'];
}): Promise<void> {
  const program = new Command();
  program.name('diptych-pty-child').exitOverride();
  registerStartCommand(program, createChildStartDeps(options));
  await program.parseAsync(['node', 'diptych-pty-child', 'start', '--project', options.projectDir]);
}

function createChildStartDeps(options: {
  readonly projectDir: string;
  readonly renderApp: StartDeps['renderApp'];
}): StartDeps {
  const forbidden = async (path: string): Promise<never> => {
    throw new Error(`PTY child entered forbidden ${path} path`);
  };
  return {
    spawnServer: async () => forbidden('provider/server'),
    runHeadless: async () => forbidden('headless/provider'),
    runRpc: async () => forbidden('rpc/provider'),
    initStores: async (projectDir) => {
      if (projectDir !== options.projectDir) {
        throw new Error('PTY child start command escaped its synthetic project');
      }
    },
    renderApp: options.renderApp,
  };
}

function requiredOptionValue(argv: readonly string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`PTY child ${name} requires a value`);
  }
  return value;
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint || !existsSync(entrypoint)) return false;
  return pathToFileURL(resolve(entrypoint)).href === import.meta.url;
}

function reportChildFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown PTY child failure';
  process.stderr.write(`PTY child failed: ${stripTerminalControls(message)}\n`);
  process.exitCode = 1;
}

if (isDirectExecution()) {
  void runPtyChild(process.argv.slice(2)).catch(reportChildFailure);
}
