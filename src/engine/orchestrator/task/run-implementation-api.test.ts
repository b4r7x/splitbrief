import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeWctx } from '#testing/helpers/orchestrator-factories.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeOpenAiSseResponse } from '#testing/helpers/faux/openai-sse.js';
import { withLocalCatalog } from '#testing/helpers/faux/local-catalog.js';
import { createApiImplementer } from '../../implementers/api.js';
import { createContinuationHolder } from '../continuation.js';
import { runImplementation } from './run-implementation.js';

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
  const task = makeTask({ id: 'T001', file, action: 'modify' });
  const wctx = makeWctx({ projectDir, sessionId, config, implementer: api });
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
    config,
    implementer: api,
    workspaceDir: opened.projectDir,
    continuation: createContinuationHolder({
      step: { kind: 'brief', taskId: task.id, attempt: second.state.attempt },
      keepWorkspace: true,
      steer: 'continue',
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
  await continued.isolation.dispose();
});
