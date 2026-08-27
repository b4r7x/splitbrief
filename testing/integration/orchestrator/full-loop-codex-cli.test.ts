import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import type { Summary } from '../../../src/core/schemas/summary.js';
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
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';
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
  const projectDir = createTempDir('orch-int-full-loop-codex');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  seedValidationProject(projectDir, expectedMarker);
  return projectDir;
}

type FakeCodexRun = {
  cwd: string;
  args: string[];
};

function prependFakeCodexToPath(opts: {
  marker: string;
  requiredPromptText: string;
  terminalLine?: string | undefined;
}): {
  binDir: string;
  executablePath: string;
  runLogPath: string;
} {
  const binDir = createTempDir('fake-codex-bin');
  dirs.push(binDir);
  const executablePath = join(binDir, 'codex');
  const runLogPath = join(binDir, 'codex-run.json');
  const script = [
    '#!/usr/bin/env node',
    "const { mkdirSync, writeFileSync } = require('node:fs');",
    `const marker = ${JSON.stringify(opts.marker)};`,
    `const requiredPromptText = ${JSON.stringify(opts.requiredPromptText)};`,
    `const runLogPath = ${JSON.stringify(runLogPath)};`,
    `const terminalLine = ${JSON.stringify(opts.terminalLine ?? null)};`,
    'const args = process.argv.slice(2);',
    'const execIndex = args.indexOf("exec");',
    'if (execIndex === -1) { console.error("codex shim: expected exec subcommand"); process.exit(2); }',
    'if (!args.includes("--json")) { console.error("codex shim: expected --json"); process.exit(2); }',
    'const sandboxIndex = args.indexOf("--sandbox");',
    'if (sandboxIndex === -1 || args[sandboxIndex + 1] !== "workspace-write") {',
    '  console.error("codex shim: expected --sandbox workspace-write");',
    '  process.exit(2);',
    '}',
    'if (!args.includes("--skip-git-repo-check")) {',
    '  console.error("codex shim: expected --skip-git-repo-check");',
    '  process.exit(2);',
    '}',
    'const cdIndex = args.indexOf("--cd");',
    'const normalizeMacPath = (p) => p.replace(/^\\/private(\\/(?:tmp|var)\\/)/, "$1");',
    'if (cdIndex === -1 || normalizeMacPath(args[cdIndex + 1]) !== normalizeMacPath(process.cwd())) {',
    '  console.error("codex shim: expected --cd pointing at the working directory");',
    '  process.exit(2);',
    '}',
    'const prompt = args[args.length - 1] ?? "";',
    'if (!prompt.includes(requiredPromptText)) {',
    '  console.error("codex shim: expected task prompt to include " + requiredPromptText);',
    '  process.exit(2);',
    '}',
    'writeFileSync(runLogPath, JSON.stringify({ cwd: process.cwd(), args }));',
    "mkdirSync('src', { recursive: true });",
    "writeFileSync('src/loop.ts', 'export const loop = \"' + marker + '\";\\n', 'utf-8');",
    'console.log(terminalLine ?? JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 40, cached_input_tokens: 30 } }));',
  ].join('\n');
  writeFileSync(executablePath, script + '\n', 'utf-8');
  chmodSync(executablePath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ''}`;
  return { binDir, executablePath, runLogPath };
}

const TARGET_FILE = 'src/loop.ts';

async function runCodexLoop(opts: {
  marker: string;
  sessionId: string;
  requiredPromptText: string;
  preparationId: string;
  generation: string;
  terminalLine?: string | undefined;
}): Promise<{
  summary: Summary;
  events: EngineEvent[];
  runLog: FakeCodexRun;
  projectDir: string;
}> {
  const projectDir = setupProject(opts.marker);
  const fakeCodex = prependFakeCodexToPath({
    marker: opts.marker,
    requiredPromptText: opts.requiredPromptText,
    ...(opts.terminalLine === undefined ? {} : { terminalLine: opts.terminalLine }),
  });
  const events: EngineEvent[] = [];

  const task = makeTask({
    id: 'T001',
    action: 'create',
    file: TARGET_FILE,
    title: opts.requiredPromptText,
    description: 'Create a module using a Codex-style cheap CLI implementer.',
    implementationSteps: ['Create src/loop.ts with the Codex CLI marker export.'],
    tests: ['node validate.mjs passes'],
    scope: { inBounds: [TARGET_FILE], outOfBounds: ['unrelated files'] },
    evidence: ['workflow_complete event is emitted after Codex CLI implementation'],
    typeDefs: 'export const loop: string',
  });

  const planner = makePlanner({
    plan: vi.fn().mockResolvedValue({
      spec: '# Spec\n\nCreate a module with a Codex CLI implementer.',
      plan: '# Plan\n\nUse the configured cheap CLI implementer.',
      tasks: [task],
      usage: { inputTokens: 140, outputTokens: 90 },
    }),
    review: vi.fn().mockResolvedValue({
      text: '# Final review\n\nCodex CLI implementer passed validation.',
      usage: { inputTokens: 60, outputTokens: 30 },
    }),
  });

  const implementerResolution = await resolveCustomExecutable({ command: 'codex', projectDir });
  if (implementerResolution.kind !== 'resolved') {
    throw new Error('Codex fixture executable did not resolve.');
  }
  const preparationId = opts.preparationId;
  const prepared = makePreparedExecution({
    projectDir,
    sessionId: opts.sessionId,
    feature: 'run a Codex CLI implementer loop',
    config: makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'codex',
        model: 'codex/test-cheap-model',
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
        maxRetries: 1,
        persistTranscript: true,
      },
    }),
    preparationId,
    active: { version: 1, sessionId: opts.sessionId, generation: opts.generation },
    gates: () => [
      {
        kind: 'cli',
        slot: { role: 'planner' },
        preparationId,
        tool: 'claude-code',
        executable: executableReceipt(),
      },
      {
        kind: 'cli',
        slot: { role: 'implementer', profile: 'default' },
        preparationId,
        tool: 'codex',
        executable: implementerResolution.executable,
      },
    ],
  });

  const summary = await runWorkflow({
    prepared,
    callbacks: makeCallbacks().callbacks,
    sinks: TEST_WORKFLOW_SINKS,
    _planner: planner,
    _eventSink: (event) => events.push(event),
  });

  const runLog = JSON.parse(readFileSync(fakeCodex.runLogPath, 'utf-8')) as FakeCodexRun;
  return { summary, events, runLog, projectDir };
}

describe('full workflow Codex CLI implementer', { timeout: 90_000 }, () => {
  it('records codex turn usage in the summary with cached input excluded from input tokens', async () => {
    const requiredPromptText = 'Codex CLI backed module';
    const { summary, events, runLog, projectDir } = await runCodexLoop({
      marker: 'from-codex-cli',
      sessionId: 'sess-full-loop-codex-cli',
      requiredPromptText,
      preparationId: 'full-loop-codex-preparation',
      generation: '5b555555-5555-4555-8555-555555555555',
    });

    expect(runLog.cwd).not.toBe(projectDir);
    expect(runLog.args).toEqual(
      expect.arrayContaining([
        'exec',
        '--json',
        '--sandbox',
        'workspace-write',
        '--skip-git-repo-check',
        '--cd',
        '--model',
        'codex/test-cheap-model',
      ]),
    );
    expect(runLog.args[runLog.args.length - 1]).toContain(requiredPromptText);
    expect(readFileSync(join(projectDir, TARGET_FILE), 'utf-8')).toContain(
      'export const loop = "from-codex-cli";',
    );
    expect(summary).toMatchObject({
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
      failed: 0,
      implementerTool: 'codex',
      implementerModel: 'codex/test-cheap-model',
      tokenUsage: {
        implementerInput: 70,
        implementerOutput: 40,
        implementerCacheRead: 30,
      },
    });
    expect(summary.taskBreakdown).toEqual([
      expect.objectContaining({
        taskId: 'T001',
        method: 'local',
        retryCount: 0,
        tool: 'codex',
        model: 'codex/test-cheap-model',
      }),
    ]);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'implementer_generate_done',
        'task_completed',
        'all_tasks_done',
        'workflow_complete',
      ]),
    );
  }, 90_000);

  it('records zero implementer input and publishes the usage-not-reported warning when codex reports no usage', async () => {
    const sessionId = 'sess-full-loop-codex-cli-no-usage';
    const { summary, events, projectDir } = await runCodexLoop({
      marker: 'from-codex-cli-no-usage',
      sessionId,
      requiredPromptText: 'Codex CLI backed module without usage',
      preparationId: 'full-loop-codex-preparation-no-usage',
      generation: '5b555555-5555-4555-8555-555555555556',
      terminalLine: JSON.stringify({ type: 'turn.completed' }),
    });

    expect(readFileSync(join(projectDir, TARGET_FILE), 'utf-8')).toContain(
      'export const loop = "from-codex-cli-no-usage";',
    );
    expect(summary).toMatchObject({
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
      failed: 0,
      implementerTool: 'codex',
      tokenUsage: {
        implementerInput: 0,
        implementerOutput: 0,
      },
    });
    expect(summary.taskBreakdown).toEqual([
      expect.objectContaining({
        taskId: 'T001',
        method: 'local',
        retryCount: 0,
        tool: 'codex',
        implementerTokens: 0,
      }),
    ]);
    const warning = events.findLast(
      (event): event is Extract<EngineEvent, { type: 'warning' }> =>
        event.type === 'warning' && event.code === 'implementer_usage_not_reported',
    );
    expect(warning).toMatchObject({
      type: 'warning',
      taskId: 'T001',
      category: 'cost',
      code: 'implementer_usage_not_reported',
      transcriptSafe: true,
    });
    expect(warning?.message).toContain('codex');
    expect(warning?.message).toContain('T001');

    const reviewPacket = JSON.parse(
      readFileSync(
        join(projectDir, '.splitbrief', 'sessions', sessionId, 'review-packet.json'),
        'utf-8',
      ),
    ) as { escalations: { warnings: Array<{ type: string; taskId?: string; message?: string }> } };
    expect(reviewPacket.escalations.warnings).toContainEqual(
      expect.objectContaining({
        type: 'warning',
        taskId: 'T001',
        message: expect.stringContaining('codex'),
      }),
    );
  }, 90_000);
});
