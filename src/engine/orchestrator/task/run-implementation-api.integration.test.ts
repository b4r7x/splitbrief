import { plainUserMessage } from '../../../core/types/user-input.js';

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeBusRecorder,
  makeCopyingIsolation,
  makeWctx,
} from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeOpenAiSseResponse } from '#testing/helpers/faux/openai-sse.js';
import { localCatalogResponse, withLocalCatalog } from '#testing/helpers/faux/local-catalog.js';
import { createApiImplementer } from '../../implementers/api.js';
import { createContinuationHolder } from '../continuation.js';
import { runImplementation } from './run-implementation.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { enqueueUserMessage } from '../queue/submit.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';

vi.mock('../../../lib/git/files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/git/files.js')>()),
  checkIgnoredPaths: vi.fn().mockResolvedValue([]),
  listTrackedAndUntrackedFiles: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../lib/git/repository.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/git/repository.js')>()),
  isGitRepo: vi.fn().mockResolvedValue(false),
}));

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

it.each(['queue', 'seed', 'parked'] as const)(
  'sends a %s image correction through the real API implementer and keeps it for a cold retry',
  async (route) => {
    const projectDir = createTempDir('api-image-correction');
    dirs.push(projectDir);
    const sessionId = 'api-image-correction';
    const ref = { projectDir, sessionId };
    ensureSessionDir(projectDir, sessionId);
    const file = 'value.ts';
    writeFileSync(join(projectDir, file), 'export const value = 0;\n');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    );
    const imagePath = join(projectDir, 'reference.png');
    writeFileSync(imagePath, png);
    const message = {
      ...plainUserMessage('Use this screenshot and preserve the exported value.'),
      images: [
        {
          id: 'reference',
          kind: 'image' as const,
          path: imagePath,
          mimeType: 'image/png',
          sizeBytes: png.length,
        },
      ],
    };
    const task = makeTask({ suggestedFiles: [file], action: 'modify' });
    const state = makeImplState([task]);
    saveState(ref, state);
    const { bus, events } = makeBusRecorder();
    const requests: unknown[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method !== 'POST') {
        return localCatalogResponse(request.url, ['qwen2.5-coder:7b']);
      }
      requests.push(JSON.parse(await request.text()));
      if (requests.length === 1 && route === 'queue') {
        enqueueUserMessage({ ...ref, state, message, bus, phase: 'implementing' });
      }
      return makeOpenAiSseResponse([
        {
          content: JSON.stringify({
            version: 1,
            files: [
              {
                path: file,
                action: 'modify',
                content: `export const value = ${requests.length};\n`,
              },
            ],
          }),
        },
      ]);
    });
    const config = makeConfig();
    const wctx = makeWctx({
      ...ref,
      config,
      modelCache: {
        ...makeModelCacheAccessor(),
        getScopedProviderRuntime: ({ role, provider }) =>
          role === 'implementer' && provider === 'ollama'
            ? {
                connection: { role, provider, contextKey: 'implementer' },
                state: 'fresh',
                catalog: 'populated',
                models: [{ id: 'qwen2.5-coder:7b', supportsImages: true }],
                fetchedAt: 1,
                validatedAt: 1,
              }
            : null,
      },
      bus,
      implementer: createApiImplementer(config),
      isolation: makeCopyingIsolation(ref),
      callbacks: makeCallbacks({ onContinuationNeeded: async () => message }).callbacks,
      ...(route === 'seed' && {
        continuation: createContinuationHolder({
          step: { kind: 'brief', taskId: task.id, attempt: state.attempt },
          steer: message,
        }),
      }),
    });
    let parked = route === 'parked';
    wctx.sinks = {
      ...wctx.sinks,
      consumeBoundaryInterrupt: () => {
        const interrupt = parked;
        parked = false;
        return interrupt;
      },
    };
    const opened = await wctx.isolation.open({ config });
    wctx.workspaceDir = opened.projectDir;
    const workspace = await wctx.isolation.acquire({ role: 'implementer', config });
    const options = {
      wctx,
      task,
      state,
      taskStartSnapshot: workspace.snapshot,
      setTrackedState: vi.fn(),
      recordApprovalDenial: vi.fn(),
    };
    try {
      const first = await runImplementation(options);
      expect(first.implResult.success).toBe(true);
      expect(requests).toHaveLength(route === 'queue' ? 2 : 1);
      const imageRequest = {
        messages: [
          { role: 'system', content: expect.any(String) },
          {
            role: 'user',
            content: [
              { type: 'text', text: expect.stringContaining(`[image:reference] = ${imagePath}`) },
              {
                type: 'image_url',
                image_url: { url: `data:image/png;base64,${png.toString('base64')}` },
              },
            ],
          },
        ],
      };
      expect(requests.at(-1)).toMatchObject(imageRequest);
      expect(first.state.lineages?.T001?.correctionImages).toEqual(message.images);
      const persisted = loadState(ref);
      if (persisted === null) throw new Error('Correction state was not persisted');
      const second = await runImplementation({
        ...options,
        wctx: { ...wctx, implementer: createApiImplementer(config), continuation: undefined },
        state: persisted,
        retryError: 'Verify the screenshot again',
      });
      expect(second.implResult.success).toBe(true);
      expect(requests.at(-1)).toMatchObject(imageRequest);
      expect(readFileSync(join(workspace.projectDir, file), 'utf8')).toContain(
        `value = ${requests.length}`,
      );
      expect(readFileSync(join(projectDir, file), 'utf8')).toBe('export const value = 0;\n');
      expect(events.filter((event) => event.type === 'queue_drained')).toHaveLength(
        route === 'queue' ? 1 : 0,
      );
    } finally {
      await wctx.isolation.dispose();
    }
  },
);

it('applies real API bundles to one workspace on the first attempt, retry and cold continuation', async () => {
  const projectDir = createTempDir('workspace-api-extraction');
  dirs.push(projectDir);
  const sessionId = 'workspace-api-extraction';
  const file = 'value.ts';
  const original = 'export const value = 0;\n';
  writeFileSync(join(projectDir, file), original);
  const config = makeConfig();
  const api = createApiImplementer(config);
  const implement = vi.spyOn(api, 'implement');
  const retry = vi.spyOn(api, 'retry');
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      withLocalCatalog(['qwen2.5-coder:7b'], () => {
        calls += 1;
        return makeOpenAiSseResponse([
          {
            content: JSON.stringify({
              version: 1,
              files: [
                { path: file, action: 'modify', content: `export const value = ${calls};\n` },
              ],
            }),
          },
        ]);
      }),
    ),
  );
  const task = makeTask({ id: 'T001', suggestedFiles: [file], action: 'modify' });
  const { bus, events } = makeBusRecorder();
  const wctx = makeWctx({
    projectDir,
    sessionId,
    config,
    bus,
    implementer: api,
    isolation: makeCopyingIsolation({ projectDir, sessionId }),
  });
  const opened = await wctx.isolation.open({ config });
  wctx.workspaceDir = opened.projectDir;
  const taskStartSnapshot = (await wctx.isolation.acquire({ role: 'implementer', config }))
    .snapshot;
  const options = {
    wctx,
    task,
    state: makeImplState([task]),
    taskStartSnapshot,
    setTrackedState: vi.fn(),
    recordApprovalDenial: vi.fn(),
  };
  const first = await runImplementation(options);
  expect(first.implResult.applyResult).toMatchObject({
    status: 'applied',
    applied: [{ path: file }],
  });
  expect(readFileSync(join(projectDir, file), 'utf8')).toBe(original);
  const second = await runImplementation({
    ...options,
    state: { ...first.state, attempt: 1 },
    retryError: 'retry this brief',
  });
  expect(second.implResult.applyResult).toMatchObject({
    status: 'applied',
    applied: [{ path: file }],
  });
  expect(second.workspace.projectDir).toBe(first.workspace.projectDir);
  expect(readFileSync(join(projectDir, file), 'utf8')).toBe(original);
  await second.workspace.retain?.();
  await wctx.isolation.dispose();
  const continued = makeWctx({
    projectDir,
    sessionId,
    isolation: makeCopyingIsolation({ projectDir, sessionId }),
    config,
    bus,
    implementer: api,
    workspaceDir: opened.projectDir,
    continuation: createContinuationHolder({
      step: { kind: 'brief', taskId: task.id, attempt: second.state.attempt },
      keepWorkspace: true,
      steer: plainUserMessage('continue'),
    }),
  });
  const third = await runImplementation({ ...options, wctx: continued, state: second.state });
  expect(third.implResult.applyResult).toMatchObject({
    status: 'applied',
    applied: [{ path: file }],
  });
  expect(third.workspace.projectDir).toBe(first.workspace.projectDir);
  expect(implement.mock.calls.map(([call]) => call.projectDir)).toEqual([
    opened.projectDir,
    opened.projectDir,
  ]);
  expect(retry.mock.calls.map(([call]) => call.projectDir)).toEqual([opened.projectDir]);
  expect(readFileSync(join(opened.projectDir, file), 'utf8')).toBe('export const value = 3;\n');
  expect(readFileSync(join(projectDir, file), 'utf8')).toBe(original);
  expect(calls).toBe(3);
  expect(events.filter((event) => event.type === 'planner_text')).toEqual(
    [1, 2, 3].map((value) =>
      expect.objectContaining({
        role: 'implementer',
        content: 'plain',
        text: JSON.stringify({
          version: 1,
          files: [{ path: file, action: 'modify', content: `export const value = ${value};\n` }],
        }),
      }),
    ),
  );
  await continued.isolation.dispose();
});
