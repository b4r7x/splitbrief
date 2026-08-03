import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { REVIEW_FILE, SANDBOX_DIR, sessionDir } from '../../../src/core/paths.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { makeCallbacks, makePlanner } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import { seedValidationProject } from '#testing/helpers/validation-project.js';
import { executableReceipt } from '#testing/helpers/custom-command-based.js';
import {
  parsePreparedConfig,
  type PreparedExecution,
} from '../../../src/engine/runners/prepared-execution.js';
import { resolveCustomExecutable } from '../../../src/engine/runners/resolve-cli-executable.js';

const dirs: string[] = [];
let originalPath: string | undefined;

beforeEach(() => {
  resetAllStores();
  originalPath = process.env.PATH;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

function setupProject(expectedMarker: string): string {
  const projectDir = createTempDir('orch-int-full-loop-opencode');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  seedValidationProject(projectDir, expectedMarker);
  return projectDir;
}

type FakeOpencodeRun = {
  cwd: string;
  args: string[];
  env: {
    HOME: string | null;
    TMPDIR: string | null;
    XDG_CACHE_HOME: string | null;
    npm_config_cache: string | null;
  };
};

function normalizeMacTmpPath(path: string | null): string | null {
  return path?.replace(/^\/private(\/(?:tmp|var)\/)/, '$1') ?? null;
}

function prependFakeOpencodeToPath(opts: { marker: string; requiredPromptText: string }): {
  binDir: string;
  executablePath: string;
  runLogPath: string;
} {
  const binDir = createTempDir('fake-opencode-bin');
  dirs.push(binDir);
  const executablePath = join(binDir, 'opencode');
  const runLogPath = join(binDir, 'opencode-run.json');
  const script = [
    '#!/usr/bin/env node',
    "const { mkdirSync, writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    `const marker = ${JSON.stringify(opts.marker)};`,
    `const requiredPromptText = ${JSON.stringify(opts.requiredPromptText)};`,
    `const runLogPath = ${JSON.stringify(runLogPath)};`,
    'const prompt = process.argv[process.argv.length - 1] ?? "";',
    'writeFileSync(runLogPath, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), env: { HOME: process.env.HOME ?? null, TMPDIR: process.env.TMPDIR ?? null, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? null, npm_config_cache: process.env.npm_config_cache ?? null } }));',
    'if (!prompt.includes(requiredPromptText)) {',
    '  console.error("expected task prompt to include " + requiredPromptText);',
    '  process.exit(2);',
    '}',
    "mkdirSync('src', { recursive: true });",
    'mkdirSync(process.env.HOME, { recursive: true });',
    "writeFileSync(join(process.env.HOME, 'state.json'), '{}', 'utf-8');",
    'mkdirSync(process.env.TMPDIR, { recursive: true });',
    "writeFileSync(join(process.env.TMPDIR, 'temp.txt'), 'temp', 'utf-8');",
    "writeFileSync('src/loop.ts', 'export const loop = \"' + marker + '\";\\n', 'utf-8');",
    'console.log(JSON.stringify({ type: "text", part: { type: "text", text: "implemented src/loop.ts via fake opencode" } }));',
    'console.log(JSON.stringify({ type: "step_finish", part: { type: "step-finish", tokens: { input: 77, output: 22 } } }));',
  ].join('\n');
  writeFileSync(executablePath, script + '\n', 'utf-8');
  chmodSync(executablePath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ''}`;
  return { binDir, executablePath, runLogPath };
}

describe('full workflow OpenCode CLI implementer', { timeout: 90_000 }, () => {
  it('runs an OpenCode CLI implementer profile through the workflow with a fake executable', async () => {
    const marker = 'from-opencode-cli';
    const projectDir = setupProject(marker);
    const sessionId = 'sess-full-loop-opencode-cli';
    const targetFile = 'src/loop.ts';
    const requiredPromptText = 'OpenCode CLI backed module';
    const fakeOpencode = prependFakeOpencodeToPath({ marker, requiredPromptText });
    const events: EngineEvent[] = [];

    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: targetFile,
      title: requiredPromptText,
      description: 'Create a module using an OpenCode-style cheap CLI implementer.',
      implementationSteps: ['Create src/loop.ts with the OpenCode CLI marker export.'],
      tests: ['node validate.mjs passes'],
      scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
      evidence: ['workflow_complete event is emitted after OpenCode CLI implementation'],
      typeDefs: 'export const loop: string',
    });

    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec\n\nCreate a module with an OpenCode CLI implementer.',
        plan: '# Plan\n\nUse the configured cheap CLI implementer.',
        tasks: [task],
        usage: { inputTokens: 140, outputTokens: 90 },
      }),
      review: vi.fn().mockResolvedValue({
        text: '# Final review\n\nOpenCode CLI implementer passed validation.',
        usage: { inputTokens: 60, outputTokens: 30 },
      }),
    });

    const feature = 'run an OpenCode CLI implementer loop';
    const config = parsePreparedConfig(
      makeConfig({
        implementer: {
          kind: 'cli',
          tool: 'opencode',
          model: 'opencode/test-cheap-model',
          contextLength: 4096,
          temperature: 0.1,
        },
        implementerProfiles: {
          default: 'opencode-cli',
          profiles: {
            'opencode-cli': {
              label: 'Fake OpenCode CLI',
              costTier: 'cheap',
              kind: 'cli',
              tool: 'opencode',
              model: 'opencode/test-cheap-model',
              contextLength: 4096,
              temperature: 0.1,
            },
          },
        },
        validation: {
          typecheck: false,
          lint: false,
          test: true,
          testCommand: 'node validate.mjs',
        },
        workflow: {
          mode: 'standard',
          approve: 'none',
          maxRetries: 1,
          persistTranscript: true,
        },
      }),
    );
    const preparationId = 'full-loop-opencode-preparation';
    const implementerResolution = await resolveCustomExecutable({
      command: 'opencode',
      projectDir,
    });
    if (implementerResolution.kind !== 'resolved') {
      throw new Error('OpenCode fixture executable did not resolve.');
    }
    const active = {
      version: 1 as const,
      sessionId,
      generation: '5a555555-5555-4555-8555-555555555555',
    };
    const prepared: PreparedExecution = {
      purpose: 'new-workflow',
      config,
      preparationId,
      report: {
        generatedAt: '2026-08-04T00:00:00.000Z',
        projectDir,
        status: 'ready',
        counts: { ok: 2, info: 0, warning: 0, blocker: 0 },
        nextAction: { kind: 'continue', label: 'Continue', reason: 'Ready' },
        sections: [],
        metadata: {},
      },
      gates: [
        {
          kind: 'cli',
          slot: { role: 'planner' },
          preparationId,
          tool: 'claude-code',
          executable: executableReceipt(),
        },
        {
          kind: 'cli',
          slot: { role: 'implementer', profile: 'opencode-cli' },
          preparationId,
          tool: 'opencode',
          executable: implementerResolution.executable,
        },
      ],
      session: { kind: 'existing', ref: { projectDir, sessionId }, active },
      runtime: { feature, allowRepoRunners: false, allowHooks: false },
    };

    const summary = await runWorkflow({
      prepared,
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      _planner: planner,
      _eventSink: (event) => events.push(event),
    });

    expect(existsSync(fakeOpencode.executablePath)).toBe(true);
    const runLog = JSON.parse(readFileSync(fakeOpencode.runLogPath, 'utf-8')) as FakeOpencodeRun;
    expect(runLog.cwd).not.toBe(projectDir);
    expect(normalizeMacTmpPath(runLog.env.HOME)).toBe(
      normalizeMacTmpPath(join(runLog.cwd, SANDBOX_DIR, 'home')),
    );
    expect(normalizeMacTmpPath(runLog.env.TMPDIR)).toBe(
      normalizeMacTmpPath(join(runLog.cwd, SANDBOX_DIR, 'tmp')),
    );
    expect(normalizeMacTmpPath(runLog.env.XDG_CACHE_HOME)).toBe(
      normalizeMacTmpPath(join(runLog.cwd, SANDBOX_DIR, 'cache')),
    );
    expect(normalizeMacTmpPath(runLog.env.npm_config_cache)).toBe(
      normalizeMacTmpPath(join(runLog.cwd, SANDBOX_DIR, 'npm-cache')),
    );
    expect(runLog.args[0]).toBe('run');
    expect(runLog.args[runLog.args.length - 1]).toContain(requiredPromptText);
    expect(runLog.args).toEqual(expect.arrayContaining(['--model', 'opencode/test-cheap-model']));
    expect(readFileSync(join(projectDir, targetFile), 'utf-8')).toContain(
      'export const loop = "from-opencode-cli";',
    );
    expect(summary).toMatchObject({
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
      failed: 0,
      implementerTool: 'opencode',
      implementerModel: 'opencode/test-cheap-model',
      tokenUsage: {
        implementerInput: 77,
        implementerOutput: 22,
      },
    });
    expect(summary.taskBreakdown).toEqual([
      expect.objectContaining({
        taskId: 'T001',
        method: 'local',
        tool: 'opencode',
        model: 'opencode/test-cheap-model',
        implementerProfile: 'opencode-cli',
      }),
    ]);
    expect(events.find((event) => event.type === 'task_started')).toMatchObject({
      type: 'task_started',
      taskId: 'T001',
      implementerProfile: 'opencode-cli',
      tool: 'opencode',
      model: 'opencode/test-cheap-model',
      costPosture: 'Selected cheap cost tier via cheapest-capable routing',
    });
    expect(
      events.find((event) => event.type === 'validate' && event.status === 'done'),
    ).toMatchObject({
      type: 'validate',
      taskId: 'T001',
      passed: true,
      stages: { typecheck: false, lint: false, test: true },
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'implementer_generate_running',
        'implementer_generate_done',
        'task_completed',
        'all_tasks_done',
        'workflow_complete',
      ]),
    );
    expect(readFileSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE), 'utf-8')).toContain(
      'OpenCode CLI implementer passed validation.',
    );
  }, 90_000);
});
