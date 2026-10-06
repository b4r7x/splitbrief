import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from '../../core/schemas/config.js';
import type { FileBundleEntry } from './file-bundle.js';
import type { ImplementerPublisher } from './types.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeOpenAiSseResponse } from '#testing/helpers/faux/openai-sse.js';
import { withLocalCatalog } from '#testing/helpers/faux/local-catalog.js';
import { createApiImplementer } from './api.js';
import { createShellImplementer } from './shell.js';

const LOCAL_CATALOG = ['qwen2.5-coder:7b'];

let projectDir: string;
let fetchMock: ReturnType<typeof vi.fn>;

function bundleText(files: FileBundleEntry[]): string {
  return JSON.stringify({ version: 1, files });
}

/** One completed response carrying `text`, behind the catalog probe the seat reads. */
function respond(text: string, finishReason?: string): void {
  fetchMock.mockImplementation(
    withLocalCatalog(LOCAL_CATALOG, () =>
      makeOpenAiSseResponse([{ content: text, ...(finishReason && { finishReason }) }]),
    ),
  );
}

function call(task: ReturnType<typeof makeTask>, config: Config = makeConfig()) {
  return { task, projectDir, config, context: defaultContext, onOutput: vi.fn() };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(join(projectDir, path)), { recursive: true });
  writeFileSync(join(projectDir, path), content);
}

function read(path: string): string {
  return readFileSync(join(projectDir, path), 'utf-8');
}

function lastRequestBody(): { messages: Array<{ role: string; content: string }> } {
  const init = fetchMock.mock.calls.at(-1)?.[1] as { body?: string } | undefined;
  return JSON.parse(String(init?.body)) as {
    messages: Array<{ role: string; content: string }>;
  };
}

beforeEach(() => {
  projectDir = createTempDir('api-file-bundle-test');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanupTempDir(projectDir);
  vi.unstubAllGlobals();
});

describe('api BUILD — file-bundle-v1 through the public pipeline', () => {
  it('honours revoked checkout ownership when the user recreates a reverted target', async () => {
    const task = makeTask({ id: 'T001', file: 'src/owned.ts', action: 'create' });
    const implementer = createApiImplementer(makeConfig());
    const opts = { ...call(task), fileIgnoreProjectDir: projectDir, createdByThisTask: [] };
    respond(bundleText([{ path: task.file, action: 'create', content: 'worker content\n' }]));
    expect((await implementer.implement(opts)).success).toBe(true);
    rmSync(join(projectDir, task.file));
    write(task.file, 'user replacement\n');
    const requestCount = fetchMock.mock.calls.length;

    const result = await implementer.implement(opts);

    expect(result.applyResult).toMatchObject({ status: 'rejected', code: 'baseline-conflict' });
    expect(fetchMock.mock.calls.length).toBe(requestCount);
    expect(read(task.file)).toBe('user replacement\n');
  });

  it('does not transfer in-memory creation ownership from another workspace', async () => {
    const workerDir = createTempDir('api-bundle-worker');
    try {
      const task = makeTask({ id: 'T001', file: 'src/owned.ts', action: 'create' });
      const implementer = createApiImplementer(makeConfig());
      respond(bundleText([{ path: task.file, action: 'create', content: 'worker content\n' }]));
      expect((await implementer.implement({ ...call(task), projectDir: workerDir })).success).toBe(
        true,
      );
      write(task.file, 'user target content\n');
      const requestCount = fetchMock.mock.calls.length;
      const result = await implementer.implement(call(task));
      expect(result.applyResult).toMatchObject({ status: 'rejected', code: 'baseline-conflict' });
      expect(fetchMock.mock.calls.length).toBe(requestCount);
      expect(read(task.file)).toBe('user target content\n');
    } finally {
      cleanupTempDir(workerDir);
    }
  });

  it('asks for the bundle grammar and applies every declared file of a two-file brief', async () => {
    respond(
      bundleText([
        { path: 'src/a.ts', action: 'create', content: 'export const a = 1;\n' },
        { path: 'src/b.ts', action: 'create', content: 'export const b = 2;\n' },
      ]),
    );
    const task = makeTask({
      id: 'T001',
      file: 'src/a.ts',
      files: ['src/a.ts', 'src/b.ts'],
      action: 'create',
    });

    const result = await createApiImplementer(makeConfig()).implement(call(task));

    expect(result.success).toBe(true);
    expect(read('src/a.ts')).toBe('export const a = 1;\n');
    expect(read('src/b.ts')).toBe('export const b = 2;\n');
    expect(result.applyResult).toMatchObject({
      status: 'applied',
      noops: [],
      untouched: [],
      applied: [
        { path: 'src/a.ts', action: 'create', beforeSha256: null, linesAdded: 2 },
        { path: 'src/b.ts', action: 'create', beforeSha256: null, linesAdded: 2 },
      ],
    });

    const { messages } = lastRequestBody();
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('"version":1,"files"');
    expect(messages[1]?.content).toContain('- src/a.ts (anchor)');
    expect(messages[1]?.content).toContain('- src/b.ts');
    expect(messages[1]?.content).not.toContain('Output the complete file contents');
  });

  it('reports one done for the whole bundle, with every changed file in its lines', async () => {
    respond(
      bundleText([
        { path: 'src/a.ts', action: 'create', content: 'export const a = 1;\n' },
        {
          path: 'src/b.ts',
          action: 'create',
          content: 'export const b = 2;\nexport const c = 3;\n',
        },
      ]),
    );
    const done: Array<{ file: string; linesAdded: number; linesRemoved: number; diff?: string }> =
      [];
    const publisher: ImplementerPublisher = {
      publishRunning: () => {},
      publishCallEvent: () => {},
      publishDone: ({ file, linesAdded, linesRemoved, diff }) => {
        done.push({ file, linesAdded, linesRemoved, ...(diff !== undefined && { diff }) });
      },
      publishFailed: () => {},
      publishWarning: () => {},
    };
    const task = makeTask({
      id: 'T012',
      file: 'src/a.ts',
      files: ['src/a.ts', 'src/b.ts'],
      action: 'create',
    });

    const result = await createApiImplementer(makeConfig(), { publisher }).implement({
      ...call(task),
      phase: 'implementing',
    });

    expect(result.success).toBe(true);
    expect(done).toHaveLength(1);
    expect(done[0]?.file).toBe('src/a.ts');
    // Two lines for `a`, three for `b`: the trailing newline is a line of its own.
    expect(done[0]?.linesAdded).toBe(5);
    expect(done[0]?.linesRemoved).toBe(0);
    expect(done[0]?.diff).toContain('src/a.ts');
    expect(done[0]?.diff).toContain('src/b.ts');
    expect(done[0]?.diff).toContain('+ export const c = 3;');
  });

  it('applies a one-file brief through the same grammar', async () => {
    respond(
      bundleText([{ path: 'src/only.ts', action: 'create', content: 'export const x = 1;\n' }]),
    );
    const task = makeTask({ id: 'T002', file: 'src/only.ts', action: 'create' });

    const result = await createApiImplementer(makeConfig()).implement(call(task));

    expect(result.success).toBe(true);
    expect(read('src/only.ts')).toBe('export const x = 1;\n');
    expect(result.applyResult).toMatchObject({ status: 'applied', untouched: [] });
  });

  it('leaves a declared file the bundle omits exactly as it was, and never deletes it', async () => {
    write('src/kept.ts', 'export const kept = 1;\n');
    write('src/moved.ts', 'export const moved = 1;\n');
    respond(
      bundleText([
        { path: 'src/moved.ts', action: 'modify', content: 'export const moved = 2;\n' },
      ]),
    );
    const task = makeTask({
      id: 'T003',
      file: 'src/moved.ts',
      files: ['src/kept.ts', 'src/moved.ts'],
      action: 'modify',
    });

    const result = await createApiImplementer(makeConfig()).implement(call(task));

    expect(result.success).toBe(true);
    expect(read('src/moved.ts')).toBe('export const moved = 2;\n');
    expect(read('src/kept.ts')).toBe('export const kept = 1;\n');
    expect(result.applyResult).toMatchObject({ status: 'applied', untouched: ['src/kept.ts'] });
  });

  it('writes nothing when the response is prose and a code fence instead of a bundle', async () => {
    respond('Here you go:\n```ts\nexport const x = 1;\n```');
    const task = makeTask({ id: 'T004', file: 'src/none.ts', action: 'create' });

    const result = await createApiImplementer(makeConfig()).implement(call(task));

    expect(result.success).toBe(false);
    expect(existsSync(join(projectDir, 'src/none.ts'))).toBe(false);
    expect(result.applyResult).toMatchObject({
      status: 'rejected',
      code: 'invalid-bundle',
      applied: [],
      untouched: ['src/none.ts'],
    });
  });

  it('never reaches the parser when the transport cut the response off', async () => {
    respond(
      '{"version":1,"files":[{"path":"src/cut.ts","action":"create","content":"export con',
      'length',
    );
    const task = makeTask({ id: 'T005', file: 'src/cut.ts', action: 'create' });

    const result = await createApiImplementer(makeConfig()).implement(call(task));

    expect(result.success).toBe(false);
    expect(result.error).toBe('OpenAI response ended because the max token limit was reached');
    expect(result.applyResult).toBeUndefined();
    expect(existsSync(join(projectDir, 'src/cut.ts'))).toBe(false);
  });

  it('refuses a create brief whose anchor already exists and this task never created', async () => {
    write('src/taken.ts', 'export const taken = 1;\n');
    respond(
      bundleText([
        { path: 'src/taken.ts', action: 'create', content: 'export const taken = 2;\n' },
      ]),
    );
    const task = makeTask({ id: 'T006', file: 'src/taken.ts', action: 'create' });

    const result = await createApiImplementer(makeConfig()).implement(call(task));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/brief says create but the anchor already exists/);
    expect(result.applyResult).toMatchObject({ status: 'rejected', code: 'baseline-conflict' });
    expect(read('src/taken.ts')).toBe('export const taken = 1;\n');
    // The refusal precedes generation: neither the catalog nor the completion is contacted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails a bundle that repeats the captured content, stale brief code included', async () => {
    write('src/same.ts', 'export const same = 1;\n');
    respond(
      bundleText([{ path: 'src/same.ts', action: 'modify', content: 'export const same = 1;\n' }]),
    );
    const task = makeTask({
      id: 'T007',
      file: 'src/same.ts',
      action: 'modify',
      // What disk holds is the baseline; a brief carrying something else does not
      // turn an unchanged answer into a change.
      currentCode: 'export const stale = 0;\n',
    });

    const result = await createApiImplementer(makeConfig()).implement(call(task));

    expect(result.success).toBe(false);
    expect(result.applyResult).toMatchObject({ status: 'rejected', code: 'no-changes' });
    expect(read('src/same.ts')).toBe('export const same = 1;\n');
  });

  it('keeps a partial application as a failure, then rewrites its own created file on retry', async () => {
    const readOnlyDir = join(projectDir, 'src/locked');
    mkdirSync(readOnlyDir, { recursive: true });
    try {
      chmodSync(readOnlyDir, 0o555);

      respond(
        bundleText([
          { path: 'src/a.ts', action: 'create', content: 'export const a = 1;\n' },
          { path: 'src/locked/b.ts', action: 'create', content: 'export const b = 1;\n' },
        ]),
      );
      const task = makeTask({
        id: 'T008',
        file: 'src/a.ts',
        files: ['src/a.ts', 'src/locked/b.ts'],
        action: 'create',
      });
      const implementer = createApiImplementer(makeConfig());

      const first = await implementer.implement(call(task));

      expect(first.success).toBe(false);
      expect(first.applyResult).toMatchObject({
        status: 'partial',
        code: 'io-failure',
        failedPath: 'src/locked/b.ts',
        applied: [{ path: 'src/a.ts', action: 'create' }],
        untouched: ['src/locked/b.ts'],
      });
      expect(read('src/a.ts')).toBe('export const a = 1;\n');

      chmodSync(readOnlyDir, 0o755);
      respond(
        bundleText([
          { path: 'src/a.ts', action: 'modify', content: 'export const a = 2;\n' },
          { path: 'src/locked/b.ts', action: 'create', content: 'export const b = 1;\n' },
        ]),
      );

      const second = await implementer.retry({
        ...call(task),
        error: 'io-failure on src/locked/b.ts',
        attempt: 1,
        kind: 'local',
      });

      expect(second.success).toBe(true);
      expect(second.applyResult).toMatchObject({
        status: 'applied',
        applied: [
          { path: 'src/a.ts', action: 'modify' },
          { path: 'src/locked/b.ts', action: 'create' },
        ],
      });
      expect(read('src/a.ts')).toBe('export const a = 2;\n');
      expect(read('src/locked/b.ts')).toBe('export const b = 1;\n');
      // The retry asked against what the first attempt actually left on disk.
      expect(lastRequestBody().messages[1]?.content).toContain('export const a = 1;');
    } finally {
      chmodSync(readOnlyDir, 0o755);
    }
  });

  it('rewrites a create anchor a recorded earlier attempt of this same task made', async () => {
    // What a fresh process knows about an interrupted attempt is what the run
    // recorded for it; the capture takes that as proof of ownership.
    write('src/recorded.ts', 'export const recorded = 1;\n');
    respond(
      bundleText([
        { path: 'src/recorded.ts', action: 'modify', content: 'export const recorded = 2;\n' },
      ]),
    );
    const task = makeTask({ id: 'T013', file: 'src/recorded.ts', action: 'create' });

    const result = await createApiImplementer(makeConfig()).implement({
      ...call(task),
      createdByThisTask: ['src/recorded.ts'],
    });

    expect(result.success).toBe(true);
    expect(read('src/recorded.ts')).toBe('export const recorded = 2;\n');
    expect(result.applyResult).toMatchObject({
      status: 'applied',
      applied: [{ path: 'src/recorded.ts', action: 'modify' }],
    });
  });

  it('parks a create anchor another task left behind, even after this seat created one of its own', async () => {
    respond(
      bundleText([{ path: 'src/mine.ts', action: 'create', content: 'export const mine = 1;\n' }]),
    );
    const implementer = createApiImplementer(makeConfig());
    const mine = makeTask({ id: 'T009', file: 'src/mine.ts', action: 'create' });

    expect((await implementer.implement(call(mine))).success).toBe(true);

    write('src/theirs.ts', 'export const theirs = 1;\n');
    const theirs = makeTask({ id: 'T010', file: 'src/theirs.ts', action: 'create' });

    const result = await implementer.implement(call(theirs));

    expect(result.success).toBe(false);
    expect(result.applyResult).toMatchObject({ status: 'rejected', code: 'baseline-conflict' });
    expect(read('src/theirs.ts')).toBe('export const theirs = 1;\n');
  });
});

describe('shell BUILD — the legacy code grammar is untouched', () => {
  it('still writes the extracted code of a fenced response', async () => {
    const code = '```typescript\nexport function hello() {\n  return "hi";\n}\n```';
    const config = makeConfig({
      implementer: {
        kind: 'shell',
        command: '/usr/bin/printf',
        args: ['%s', code],
        outputFormat: 'text',
        model: 'test',
        contextLength: 8192,
      },
    });
    const task = makeTask({ id: 'T011', file: 'src/legacy.ts', action: 'create' });

    const result = await createShellImplementer(config).implement(call(task, config));

    expect(result.success).toBe(true);
    expect(result.applyResult).toBeUndefined();
    expect(read('src/legacy.ts')).toContain('export function hello()');
  });
});
