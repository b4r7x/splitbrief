import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, '../../../..');
const parserPath = 'engine/providers/models-dev-cache/parse.js';
const workerPath = 'engine/providers/models-dev-cache/parse-worker.js';
const rawCatalog = JSON.stringify({
  demo: {
    id: 'demo',
    models: {
      demo: {
        id: 'demo',
        reasoning_options: [{ type: 'effort', values: [null, 12, 'low', 'high'] }],
        extra: { nested: ['retained'] },
      },
    },
  },
});
const record = {
  version: 1,
  sourceUrl: 'https://models.dev/api.json',
  parserVersion: 'models-dev-api-json-v1',
  catalog: JSON.parse(rawCatalog),
  fetchedAt: 1_700_000_000_000,
  validatedAt: 1_700_000_000_500,
};

describe('models.dev parser runtime', () => {
  let root: string;
  let emitted: string;
  let originalWorker: string;

  beforeAll(() => {
    root = createTempDir('models-dev-parser-runtime');
    emitted = join(root, 'dist');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    symlinkSync(join(projectRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
    for (const source of [
      'engine/providers/models-dev-cache/parse.ts',
      'engine/providers/models-dev-cache/parse-worker.ts',
      'engine/providers/models-dev-cache/record.ts',
      'core/schemas/models-dev.ts',
      'utils/error.ts',
    ]) {
      const output = join(emitted, source.replace(/\.ts$/, '.js'));
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(
        output,
        transpileModule(readFileSync(join(projectRoot, 'src', source), 'utf8'), {
          fileName: source,
          compilerOptions: {
            module: ModuleKind.ESNext,
            target: ScriptTarget.ES2024,
            verbatimModuleSyntax: true,
          },
        }).outputText,
      );
    }
    originalWorker = readFileSync(join(emitted, workerPath), 'utf8');
  });

  beforeEach(() => writeFileSync(join(emitted, workerPath), originalWorker));
  afterAll(() => cleanupTempDir(root));

  it.each(['source', 'emitted'])(
    'validates payloads through the %s worker from another directory',
    async (runtime) => {
      const url = pathToFileURL(
        runtime === 'source'
          ? join(projectRoot, 'src', parserPath.replace(/\.js$/, '.ts'))
          : join(emitted, parserPath),
      ).href;
      const inputs = [
        { kind: 'catalog', raw: rawCatalog },
        { kind: 'catalog', raw: '{invalid' },
        { kind: 'catalog', raw: '{"demo":{"id":"demo","models":{"broken":{}}}}' },
        { kind: 'catalog', raw: '{}' },
        { kind: 'record', raw: JSON.stringify(record) },
        { kind: 'record', raw: JSON.stringify({ ...record, unexpected: true }) },
        { kind: 'metadata', raw: JSON.stringify(record) },
        { kind: 'metadata', raw: JSON.stringify({ ...record, catalog: { broken: {} } }) },
      ];
      const code = `
      import { parseModelsDevPayload } from ${JSON.stringify(url)};
      const results = [];
      for (const input of ${JSON.stringify(inputs)}) results.push(await parseModelsDevPayload(input));
      console.log(JSON.stringify(results));
    `;
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          ...(runtime === 'source' ? ['--import', import.meta.resolve('tsx')] : []),
          '--input-type=module',
          '--eval',
          code,
        ],
        { cwd: root, timeout: 120_000 },
      );
      const results = JSON.parse(stdout);
      expect(results).toMatchObject([
        {
          kind: 'valid',
          catalog: {
            demo: {
              models: {
                demo: {
                  reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
                  extra: { nested: ['retained'] },
                },
              },
            },
          },
        },
        { kind: 'invalid-json' },
        { kind: 'invalid-schema' },
        { kind: 'valid', catalog: {} },
        {
          catalog: {
            demo: { models: { demo: { reasoning_options: [{ values: ['low', 'high'] }] } } },
          },
        },
        null,
        {
          sourceUrl: record.sourceUrl,
          parserVersion: record.parserVersion,
          validatedAt: record.validatedAt,
        },
        null,
      ]);
      expect(results[6]).not.toHaveProperty('catalog');
    },
  );

  it('services main-thread input while a worker parse remains pending', async () => {
    const channelName = `models-dev-${root}`;
    writeFileSync(
      join(emitted, workerPath),
      `
      import { BroadcastChannel, parentPort, workerData } from 'node:worker_threads';
      import { parsePayload } from './record.js';
      const channel = new BroadcastChannel(${JSON.stringify(channelName)});
      channel.onmessage = () => {
        parentPort.postMessage(parsePayload(workerData));
        channel.close();
      };
      channel.postMessage('started');
    `,
    );
    const code = `
      import { BroadcastChannel } from 'node:worker_threads';
      import { parseModelsDevPayload } from ${JSON.stringify(pathToFileURL(join(emitted, parserPath)).href)};
      const channel = new BroadcastChannel(${JSON.stringify(channelName)});
      const started = new Promise(resolve => { channel.onmessage = resolve; });
      let settled = false;
      const parsing = parseModelsDevPayload({kind:'catalog', raw:${JSON.stringify(rawCatalog)}});
      parsing.then(() => { settled = true; });
      await started;
      process.stdin.once('data', async key => {
        console.log('KEY ' + key.toString().trim() + ' pending=' + !settled);
        channel.postMessage('release');
        console.log('RESULT ' + (await parsing).kind);
        channel.close();
        process.stdin.pause();
      });
      console.log('FRAME pending=' + !settled);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes('FRAME') && !child.stdin.writableEnded) child.stdin.end('k\n');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const exitCode = await new Promise<number | null>((done, reject) => {
      child.once('error', reject);
      child.once('close', done);
    });
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
    expect(stdout.trim().split('\n')).toEqual([
      'FRAME pending=true',
      'KEY k pending=true',
      'RESULT valid',
    ]);
  });

  it.each([
    ['process.exit(0);', 'exited before returning a result (0)'],
    ['process.exit(7);', 'exited before returning a result (7)'],
    ['throw new Error("parser fixture failed");', 'parser fixture failed'],
  ])('rejects worker failure and exits cleanly for %s', async (worker, message) => {
    writeFileSync(join(emitted, workerPath), worker);
    const code = `
      import { parseModelsDevPayload } from ${JSON.stringify(pathToFileURL(join(emitted, parserPath)).href)};
      try {
        await parseModelsDevPayload({kind:'catalog', raw:'{}'});
        throw new Error('Expected worker failure.');
      } catch (cause) { console.log(cause.message); }
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', code],
      {
        cwd: root,
        timeout: 120_000,
      },
    );
    expect(stdout.trim()).toContain(message);
  });
});
