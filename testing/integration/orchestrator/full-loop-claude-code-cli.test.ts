import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../../src/engine/events/types.js';
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
  const projectDir = createTempDir('orch-int-full-loop-claude-code');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  seedValidationProject(projectDir, expectedMarker);
  return projectDir;
}

type FakeClaudeRun = {
  cwd: string;
  args: string[];
};

function prependFakeClaudeToPath(opts: { marker: string; requiredPromptText: string }): {
  binDir: string;
  executablePath: string;
  runLogPath: string;
} {
  const binDir = createTempDir('fake-claude-code-bin');
  dirs.push(binDir);
  const executablePath = join(binDir, 'claude');
  const runLogPath = join(binDir, 'claude-run.json');
  const script = [
    '#!/usr/bin/env node',
    "const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');",
    `const marker = ${JSON.stringify(opts.marker)};`,
    `const requiredPromptText = ${JSON.stringify(opts.requiredPromptText)};`,
    `const runLogPath = ${JSON.stringify(runLogPath)};`,
    'const args = process.argv.slice(2);',
    'if (args[0] !== "-p") { console.error("claude shim: expected -p"); process.exit(2); }',
    'const formatIndex = args.indexOf("--output-format");',
    'if (formatIndex === -1 || args[formatIndex + 1] !== "stream-json") {',
    '  console.error("claude shim: expected --output-format stream-json");',
    '  process.exit(2);',
    '}',
    'if (!args.includes("--permission-mode")) { console.error("claude shim: expected --permission-mode"); process.exit(2); }',
    'const prompt = readFileSync(0, "utf-8");',
    'if (!prompt.includes(requiredPromptText)) {',
    '  console.error("claude shim: expected task prompt to include " + requiredPromptText);',
    '  process.exit(2);',
    '}',
    'writeFileSync(runLogPath, JSON.stringify({ cwd: process.cwd(), args }));',
    "mkdirSync('src', { recursive: true });",
    "writeFileSync('src/loop.ts', 'export const loop = \"' + marker + '\";\\n', 'utf-8');",
    'console.log(JSON.stringify({ type: "assistant", session_id: "fake-claude-session", message: { content: [{ type: "text", text: "implemented src/loop.ts via fake claude" }] } }));',
    'console.log(JSON.stringify({ type: "result", result: "done", session_id: "fake-claude-session", usage: { input_tokens: 90, output_tokens: 35, cache_read_input_tokens: 30 } }));',
  ].join('\n');
  writeFileSync(executablePath, script + '\n', 'utf-8');
  chmodSync(executablePath, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ''}`;
  return { binDir, executablePath, runLogPath };
}

describe('full workflow Claude Code CLI implementer', { timeout: 90_000 }, () => {
  it('records claude-code result usage in the summary', async () => {
    const marker = 'from-claude-code-cli';
    const projectDir = setupProject(marker);
    const sessionId = 'sess-full-loop-claude-code-cli';
    const targetFile = 'src/loop.ts';
    const requiredPromptText = 'Claude Code CLI backed module';
    const fakeClaude = prependFakeClaudeToPath({ marker, requiredPromptText });
    const events: EngineEvent[] = [];

    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: targetFile,
      title: requiredPromptText,
      description: 'Create a module using a Claude Code-style cheap CLI implementer.',
      implementationSteps: ['Create src/loop.ts with the Claude Code CLI marker export.'],
      tests: ['node validate.mjs passes'],
      scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
      evidence: ['workflow_complete event is emitted after Claude Code CLI implementation'],
      typeDefs: 'export const loop: string',
    });

    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec\n\nCreate a module with a Claude Code CLI implementer.',
        plan: '# Plan\n\nUse the configured cheap CLI implementer.',
        tasks: [task],
        usage: { inputTokens: 140, outputTokens: 90 },
      }),
      review: vi.fn().mockResolvedValue({
        text: '# Final review\n\nClaude Code CLI implementer passed validation.',
        usage: { inputTokens: 60, outputTokens: 30 },
      }),
    });

    const feature = 'run a Claude Code CLI implementer loop';
    const config = makeConfig({
      implementer: {
        kind: 'cli',
        tool: 'claude-code',
        model: 'claude-sonnet-4-20250514',
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
    });
    const preparationId = 'full-loop-claude-code-preparation';
    const implementerResolution = await resolveCustomExecutable({ command: 'claude', projectDir });
    if (implementerResolution.kind !== 'resolved') {
      throw new Error('Claude Code fixture executable did not resolve.');
    }
    const active = {
      version: 1 as const,
      sessionId,
      generation: '5c555555-5555-4555-8555-555555555555',
    };
    const prepared = makePreparedExecution({
      projectDir,
      sessionId,
      feature,
      config,
      preparationId,
      active,
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
          tool: 'claude-code',
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

    const runLog = JSON.parse(readFileSync(fakeClaude.runLogPath, 'utf-8')) as FakeClaudeRun;
    expect(runLog.cwd).not.toBe(projectDir);
    expect(runLog.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-mode',
        'acceptEdits',
        '--model',
        'claude-sonnet-4-20250514',
      ]),
    );
    expect(readFileSync(join(projectDir, targetFile), 'utf-8')).toContain(
      'export const loop = "from-claude-code-cli";',
    );
    expect(summary).toMatchObject({
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
      failed: 0,
      implementerTool: 'claude-code',
      implementerModel: 'claude-sonnet-4-20250514',
      tokenUsage: {
        implementerInput: 90,
        implementerOutput: 35,
        implementerCacheRead: 30,
      },
    });
    expect(summary.taskBreakdown).toEqual([
      expect.objectContaining({
        taskId: 'T001',
        method: 'local',
        retryCount: 0,
        tool: 'claude-code',
        model: 'claude-sonnet-4-20250514',
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
});
