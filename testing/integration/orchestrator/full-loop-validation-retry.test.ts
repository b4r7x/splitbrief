import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { RetryOptions, ImplementerOptions } from '../../../src/engine/implementers/types.js';
import {
  REVIEW_FILE,
  SANDBOX_DIR,
  reviewPacketJsonPath,
  sessionDir,
} from '../../../src/core/paths.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { makeOpenAiSseResponse } from '#testing/helpers/faux/openai-sse.js';
import {
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';

const dirs: string[] = [];
let originalOpenRouterApiKey: string | undefined;
let originalPath: string | undefined;

beforeEach(() => {
  resetAllStores();
  originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
  originalPath = process.env.PATH;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalOpenRouterApiKey === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
  }
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

function setupProject(expectedMarker = 'from-retry'): string {
  const projectDir = createTempDir('orch-int-full-loop-retry');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  writeFileSync(
    join(projectDir, 'validate.mjs'),
    [
      "import { readFileSync } from 'node:fs';",
      "const content = readFileSync('src/loop.ts', 'utf-8');",
      `if (!content.includes(${JSON.stringify(expectedMarker)})) {`,
      `  console.error(${JSON.stringify(`expected ${expectedMarker} implementation`)});`,
      '  process.exit(1);',
      '}',
    ].join('\n') + '\n',
    'utf-8',
  );
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
    "console.log('implemented src/loop.ts via fake opencode');",
    "console.log('Tokens: 77 sent, 22 received');",
  ].join('\n');
  writeFileSync(executablePath, script + '\n', 'utf-8');
  chmodSync(executablePath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ''}`;
  return { executablePath, runLogPath };
}

describe('full workflow validation retry loop', { timeout: 30_000 }, () => {
  it('retries after real validation fails, promotes the staged fix, and writes final review artifacts', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-full-loop-validation-retry';
    const targetFile = 'src/loop.ts';
    const badImplementation = 'export const loop = "from-initial";\n';
    const goodImplementation = 'export const loop = "from-retry";\n';
    const implementerProjectDirs: string[] = [];
    const retryProjectDirs: string[] = [];
    const events: EngineEvent[] = [];

    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: targetFile,
      title: 'Create retry-validated module',
      description: 'Create a module that satisfies the project validation script.',
      implementationSteps: ['Create src/loop.ts with the retry marker export.'],
      tests: ['node validate.mjs passes'],
      scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
      evidence: ['validation fails once, retries, and passes before workflow_complete'],
      typeDefs: 'export const loop: string',
    });

    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec\n\nCreate a retry-validated module.',
        plan: '# Plan\n\nCreate the module and pass validation.',
        tasks: [task],
        usage: { inputTokens: 140, outputTokens: 90 },
      }),
      review: vi.fn().mockResolvedValue({
        text: '# Final review\n\nValidation passed after one local retry.',
        usage: { inputTokens: 60, outputTokens: 30 },
      }),
    });

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        implementerProjectDirs.push(opts.projectDir);
        expect(opts.projectDir).not.toBe(projectDir);
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(join(opts.projectDir, targetFile), badImplementation, 'utf-8');
        return {
          success: true,
          output: 'created initial implementation',
          usage: { inputTokens: 50, outputTokens: 20 },
        };
      }),
      retry: vi.fn().mockImplementation(async (opts: RetryOptions) => {
        retryProjectDirs.push(opts.projectDir);
        expect(opts.projectDir).not.toBe(projectDir);
        expect(readFileSync(join(projectDir, targetFile), 'utf-8')).toBe(badImplementation);
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(join(opts.projectDir, targetFile), goodImplementation, 'utf-8');
        return {
          success: true,
          output: 'fixed implementation',
          usage: { inputTokens: 35, outputTokens: 15 },
        };
      }),
    });

    const summary = await runWorkflow({
      feature: 'run a validation retry loop',
      projectDir,
      config: makeConfig({
        implementer: {
          kind: 'agent',
          command: 'node',
          model: 'cheap-direct-agent',
          contextLength: 4096,
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
          commitStrategy: 'none',
          maxRetries: 1,
          persistTranscript: true,
        },
      }),
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      sessionId,
      _planner: planner,
      _implementer: implementer,
      _eventSink: (event) => events.push(event),
    });

    expect(implementerProjectDirs).toHaveLength(1);
    expect(retryProjectDirs).toHaveLength(1);
    expect(readFileSync(join(projectDir, targetFile), 'utf-8')).toBe(goodImplementation);
    expect(summary).toMatchObject({
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
      failed: 0,
    });

    const validationResults = events.filter(
      (event): event is Extract<EngineEvent, { type: 'validate' }> =>
        event.type === 'validate' && event.status === 'done',
    );
    expect(validationResults.map((event) => event.passed)).toEqual([false, true]);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'task_retry',
        'task_completed',
        'all_tasks_done',
        'workflow_complete',
      ]),
    );
    expect(readFileSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE), 'utf-8')).toContain(
      'Validation passed after one local retry.',
    );
    expect(existsSync(reviewPacketJsonPath(projectDir, sessionId))).toBe(true);
  }, 30_000);

  it('uses planner hint escalation when local retry does not fix validation', async () => {
    const projectDir = setupProject();
    const sessionId = 'sess-full-loop-hint-escalation';
    const targetFile = 'src/loop.ts';
    const badImplementation = 'export const loop = "from-initial";\n';
    const hintImplementation = 'export const loop = "from-retry";\n';
    const retryKinds: string[] = [];
    const events: EngineEvent[] = [];

    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: targetFile,
      title: 'Create hint-validated module',
      description: 'Create a module that needs planner hint escalation before validation passes.',
      implementationSteps: ['Create src/loop.ts with the retry marker export.'],
      tests: ['node validate.mjs passes after hint escalation'],
      scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
      evidence: ['tier-1 escalation event appears before workflow_complete'],
      typeDefs: 'export const loop: string',
    });

    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec\n\nCreate a module with hint escalation.',
        plan: '# Plan\n\nCreate the module and fix it with a hint when needed.',
        tasks: [task],
        usage: { inputTokens: 140, outputTokens: 90 },
      }),
      escalateHint: vi.fn().mockResolvedValue({
        success: true,
        output: 'Use the from-retry marker expected by validate.mjs.',
        code: null,
        usage: { inputTokens: 50, outputTokens: 20 },
      }),
      review: vi.fn().mockResolvedValue({
        text: '# Final review\n\nHint escalation produced a passing implementation.',
        usage: { inputTokens: 60, outputTokens: 30 },
      }),
    });

    const implementer = makeImplementer({
      capabilities: { writesFiles: 'direct' },
      implement: vi.fn().mockImplementation(async (opts: ImplementerOptions) => {
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(join(opts.projectDir, targetFile), badImplementation, 'utf-8');
        return {
          success: true,
          output: 'created initial implementation',
          usage: { inputTokens: 50, outputTokens: 20 },
        };
      }),
      retry: vi.fn().mockImplementation(async (opts: RetryOptions) => {
        retryKinds.push(opts.kind);
        if (opts.kind === 'local') {
          return {
            success: false,
            output: '',
            error: 'local retry still misses the expected marker',
            usage: { inputTokens: 25, outputTokens: 10 },
          };
        }
        expect(opts.projectDir).not.toBe(projectDir);
        expect(opts.error).toContain('Hints from senior reviewer');
        mkdirSync(join(opts.projectDir, 'src'), { recursive: true });
        writeFileSync(join(opts.projectDir, targetFile), hintImplementation, 'utf-8');
        return {
          success: true,
          output: 'fixed after hint',
          usage: { inputTokens: 35, outputTokens: 15 },
        };
      }),
    });

    const summary = await runWorkflow({
      feature: 'run a hint escalation loop',
      projectDir,
      config: makeConfig({
        implementer: {
          kind: 'agent',
          command: 'node',
          model: 'cheap-direct-agent',
          contextLength: 4096,
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
          commitStrategy: 'none',
          maxRetries: 1,
          persistTranscript: true,
        },
      }),
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      sessionId,
      _planner: planner,
      _implementer: implementer,
      _eventSink: (event) => events.push(event),
    });

    expect(retryKinds).toEqual(['local', 'hint']);
    expect(readFileSync(join(projectDir, targetFile), 'utf-8')).toBe(hintImplementation);
    expect(summary).toMatchObject({
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
      failed: 0,
    });
    expect(events.find((event) => event.type === 'escalate' && event.tier === 1)).toBeDefined();
    expect(events.find((event) => event.type === 'task_completed')).toMatchObject({
      method: 'escalated-hint',
    });
    expect(events.map((event) => event.type)).toContain('workflow_complete');
    expect(readFileSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE), 'utf-8')).toContain(
      'Hint escalation produced a passing implementation.',
    );
  }, 30_000);

  it('runs an OpenRouter API implementer profile through the workflow without real network', async () => {
    const projectDir = setupProject('from-openrouter');
    const sessionId = 'sess-full-loop-openrouter-api';
    const targetFile = 'src/loop.ts';
    const implementation = 'export const loop = "from-openrouter";\n';
    const events: EngineEvent[] = [];
    process.env.OPENROUTER_API_KEY = 'sk-or-workflow-test';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        makeOpenAiSseResponse([
          { content: `\`\`\`ts\n${implementation}\`\`\`` },
          { usage: { prompt_tokens: 123, completion_tokens: 45 } },
        ]),
      );
    vi.stubGlobal('fetch', fetchMock);

    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: targetFile,
      title: 'Create OpenRouter-backed module',
      description: 'Create a module using an API-backed cheap implementer.',
      implementationSteps: ['Create src/loop.ts with the OpenRouter marker export.'],
      tests: ['node validate.mjs passes'],
      scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
      evidence: ['workflow_complete event is emitted after OpenRouter API implementation'],
      typeDefs: 'export const loop: string',
    });

    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec\n\nCreate a module with an OpenRouter API implementer.',
        plan: '# Plan\n\nUse the configured cheap API implementer.',
        tasks: [task],
        usage: { inputTokens: 140, outputTokens: 90 },
      }),
      review: vi.fn().mockResolvedValue({
        text: '# Final review\n\nOpenRouter API implementer passed validation.',
        usage: { inputTokens: 60, outputTokens: 30 },
      }),
    });

    const summary = await runWorkflow({
      feature: 'run an OpenRouter API implementer loop',
      projectDir,
      config: makeConfig({
        implementer: {
          kind: 'api',
          provider: 'openrouter',
          apiBase: 'https://openrouter.ai/api/v1',
          apiKey: 'env:OPENROUTER_API_KEY',
          model: 'openrouter/test-cheap-model',
          contextLength: 4096,
          temperature: 0.1,
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
          commitStrategy: 'none',
          maxRetries: 1,
          persistTranscript: true,
        },
      }),
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      sessionId,
      _planner: planner,
      _eventSink: (event) => events.push(event),
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(readFileSync(join(projectDir, targetFile), 'utf-8')).toContain(
      'export const loop = "from-openrouter";',
    );
    expect(summary).toMatchObject({
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
      failed: 0,
      implementerTool: 'openrouter',
      implementerModel: 'openrouter/test-cheap-model',
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['task_completed', 'all_tasks_done', 'workflow_complete']),
    );
    expect(readFileSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE), 'utf-8')).toContain(
      'OpenRouter API implementer passed validation.',
    );
  }, 30_000);

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

    const summary = await runWorkflow({
      feature: 'run an OpenCode CLI implementer loop',
      projectDir,
      config: makeConfig({
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
          commitStrategy: 'none',
          maxRetries: 1,
          persistTranscript: true,
        },
      }),
      callbacks: makeCallbacks().callbacks,
      sinks: TEST_WORKFLOW_SINKS,
      sessionId,
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
    expect(existsSync(join(projectDir, SANDBOX_DIR))).toBe(false);
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
  }, 30_000);
});
