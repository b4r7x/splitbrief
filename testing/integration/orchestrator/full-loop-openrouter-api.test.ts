import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { REVIEW_FILE, sessionDir } from '../../../src/core/paths.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { makeOpenAiSseResponse } from '#testing/helpers/faux/openai-sse.js';
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

const dirs: string[] = [];
let originalOpenRouterApiKey: string | undefined;

beforeEach(() => {
  resetAllStores();
  originalOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalOpenRouterApiKey === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = originalOpenRouterApiKey;
  }
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

function setupProject(expectedMarker = 'from-openrouter'): string {
  const projectDir = createTempDir('orch-int-full-loop-openrouter');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  seedValidationProject(projectDir, expectedMarker);
  return projectDir;
}

describe('full workflow OpenRouter API implementer', { timeout: 90_000 }, () => {
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

    const feature = 'run an OpenRouter API implementer loop';
    const config = parsePreparedConfig(
      makeConfig({
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
          maxRetries: 1,
          persistTranscript: true,
        },
      }),
    );
    const preparationId = 'full-loop-openrouter-preparation';
    const active = {
      version: 1 as const,
      sessionId,
      generation: '6a666666-6666-4666-8666-666666666666',
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
          kind: 'api',
          slot: { role: 'implementer', profile: 'default' },
          preparationId,
          provider: 'openrouter',
          endpointOrigin: 'https://openrouter.ai',
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
  }, 90_000);
});
