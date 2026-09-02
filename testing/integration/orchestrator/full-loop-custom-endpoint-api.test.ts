import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
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
import { makePreparedExecution } from '#testing/helpers/factories/prepared-execution.js';

const dirs: string[] = [];

beforeEach(() => {
  resetAllStores();
});

afterEach(() => {
  vi.unstubAllGlobals();
  while (dirs.length > 0) cleanupTempDir(dirs.pop() as string);
});

function setupProject(expectedMarker = 'from-custom-endpoint'): string {
  const projectDir = createTempDir('orch-int-full-loop-custom-endpoint');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  seedValidationProject(projectDir, expectedMarker);
  return projectDir;
}

describe('full workflow custom-endpoint API implementer', { timeout: 90_000 }, () => {
  it('runs a custom-endpoint API implementer profile through the workflow without real network', async () => {
    const projectDir = setupProject('from-custom-endpoint');
    const sessionId = 'sess-full-loop-custom-endpoint-api';
    const targetFile = 'src/loop.ts';
    const implementation = 'export const loop = "from-custom-endpoint";\n';
    const events: EngineEvent[] = [];
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input, init).url;
      if (url.includes('/models')) {
        return Promise.resolve(
          new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        makeOpenAiSseResponse([
          { content: `\`\`\`ts\n${implementation}\`\`\`` },
          { usage: { prompt_tokens: 123, completion_tokens: 45 } },
        ]),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const task = makeTask({
      id: 'T001',
      action: 'create',
      file: targetFile,
      title: 'Create custom-endpoint-backed module',
      description: 'Create a module using an API-backed cheap implementer.',
      implementationSteps: ['Create src/loop.ts with the custom-endpoint marker export.'],
      tests: ['node validate.mjs passes'],
      scope: { inBounds: [targetFile], outOfBounds: ['unrelated files'] },
      evidence: ['workflow_complete event is emitted after custom-endpoint API implementation'],
      typeDefs: 'export const loop: string',
    });

    const planner = makePlanner({
      plan: vi.fn().mockResolvedValue({
        spec: '# Spec\n\nCreate a module with a custom-endpoint API implementer.',
        plan: '# Plan\n\nUse the configured cheap API implementer.',
        tasks: [task],
        usage: { inputTokens: 140, outputTokens: 90 },
      }),
      review: vi.fn().mockResolvedValue({
        text: '# Final review\n\nCustom-endpoint API implementer passed validation.',
        usage: { inputTokens: 60, outputTokens: 30 },
      }),
    });

    const feature = 'run a custom-endpoint API implementer loop';
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'custom-endpoint',
        service: 'custom-endpoint',
        offering: 'payg',
        apiBase: 'https://api.example.test/v1',
        apiKey: 'test-key',
        model: 'custom/test-cheap-model',
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
    const preparationId = 'full-loop-custom-endpoint-preparation';
    const active = {
      version: 1 as const,
      sessionId,
      generation: '6a666666-6666-4666-8666-666666666666',
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
          kind: 'api',
          slot: { role: 'implementer', profile: 'default' },
          preparationId,
          provider: 'custom-endpoint',
          endpointOrigin: 'https://api.example.test',
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

    expect(readFileSync(join(projectDir, targetFile), 'utf-8')).toContain(
      'export const loop = "from-custom-endpoint";',
    );
    expect(summary).toMatchObject({
      totalTasks: 1,
      completedByLocal: 1,
      escalatedToPlanner: 0,
      failed: 0,
      implementerTool: 'custom-endpoint',
      implementerModel: 'custom/test-cheap-model',
    });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['task_completed', 'all_tasks_done', 'workflow_complete']),
    );
    expect(readFileSync(join(sessionDir(projectDir, sessionId), REVIEW_FILE), 'utf-8')).toContain(
      'Custom-endpoint API implementer passed validation.',
    );
  }, 90_000);
});
