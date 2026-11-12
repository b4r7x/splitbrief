import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expireDeadlineAfterFile, freezeProbeDeadlines } from '#testing/helpers/fake-timers.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { stubSignInHome } from '#testing/helpers/sign-in-home.js';
import { resolveCliExecutable } from '../runners/resolve-cli-executable.js';
import { detectRunnerEvidence } from './runner-evidence.js';

const listing = [
  'Available models  ·  2 models',
  'Provider',
  'provider/first  First model',
  'provider/second  Second model',
  'Docs:  https://commandcode.ai/docs/reference/cli/models',
  '',
].join('\n');

describe.runIf(process.platform !== 'win32')('Command Code catalog completion', () => {
  freezeProbeDeadlines();
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    {
      label: 'complete listing with delayed exit',
      stdout: listing,
      stderr: '',
      exit: null,
      expected: 'success',
    },
    {
      label: 'complete listing followed by the cmd 1.62.1 decision-model note',
      stdout: `${listing}\nDecision models (headless only)\ntypesafe/jev  typed questions in, probabilities out\n`,
      stderr: '',
      exit: null,
      expected: 'success',
    },
    {
      label: 'partial row count',
      stdout: listing.replace('provider/second  Second model\n', ''),
      stderr: '',
      exit: null,
      expected: 'timeout',
    },
    {
      label: 'missing terminal footer',
      stdout: listing.replace(/Docs:.*\n/, ''),
      stderr: '',
      exit: null,
      expected: 'timeout',
    },
    {
      label: 'malformed listing',
      stdout: 'Available models\nnot a catalog\n',
      stderr: '',
      exit: null,
      expected: 'timeout',
    },
    {
      label: 'authentication error with delayed exit',
      stdout: listing,
      stderr: 'Authentication required\n',
      exit: null,
      expected: 'timeout',
    },
    {
      label: 'authentication failure exit',
      stdout: listing,
      stderr: 'Authentication required\n',
      exit: 1,
      expected: 'command-failed',
    },
  ])(
    '$label',
    async ({ stdout, stderr, exit, expected }) => {
      await withTempDir('command-code-catalog', async (directory) => {
        const pidFile = join(directory, 'catalog.pid');
        const shim = join(directory, 'cmd');
        await writeFile(
          shim,
          [
            `#!${process.execPath}`,
            "const fs = require('node:fs');",
            "if (process.argv.includes('--version') || process.argv.includes('-v')) { console.log('1.54.2'); process.exit(0); }",
            "if (!process.argv.includes('--list-models')) process.exit(1);",
            `process.stdout.write(${JSON.stringify(stdout)});`,
            `process.stderr.write(${JSON.stringify(stderr)});`,
            '// A test stops this fake as soon as the file exists, so the file appears whole by a rename.',
            `fs.writeFileSync(${JSON.stringify(pidFile + '.tmp')}, String(process.pid));`,
            `fs.renameSync(${JSON.stringify(pidFile + '.tmp')}, ${JSON.stringify(pidFile)});`,
            exit === null ? 'setInterval(() => {}, 1000);' : `process.exitCode = ${exit};`,
          ].join('\n'),
        );
        await chmod(shim, 0o755);
        const executable = await resolveCliExecutable({
          command: shim,
          projectDir: '/neutral/project',
        });
        await stubSignInHome(join(directory, 'home'), ['command-code']);
        const pending = detectRunnerEvidence({
          context: {
            role: 'planner',
            kind: 'cli',
            id: 'command-code',
            credentialPresent: false,
            configGeneration: 'catalog-exit-test',
          },
          resolveExecutable: async () => executable,
          includeCatalog: true,
          now: () => 200,
        });
        if (exit === null) await expireDeadlineAfterFile(pidFile);
        const evidence = await pending;
        expect(evidence.catalog.kind).toBe(expected);
        if (evidence.catalog.kind === 'success') {
          expect(evidence.catalog.value.map((model) => model.id)).toEqual([
            'provider/first',
            'provider/second',
          ]);
        }
        const pid = Number(await readFile(pidFile, 'utf8'));
        expect(() => process.kill(pid, 0)).toThrow();
      });
    },
    15_000,
  );

  it('turns telemetry off, so a listing with a stderr note ends before its budget', async () => {
    await withTempDir('command-code-catalog', async (directory) => {
      const shim = join(directory, 'cmd');
      await writeFile(
        shim,
        [
          `#!${process.execPath}`,
          "if (process.argv.includes('--version') || process.argv.includes('-v')) { console.log('1.54.2'); process.exit(0); }",
          "if (!process.argv.includes('--list-models')) process.exit(1);",
          `process.stdout.write(${JSON.stringify(listing)});`,
          "process.stderr.write('Fetching available models...\\n');",
          "if (process.env.DO_NOT_TRACK !== '1') setInterval(() => {}, 1000);",
        ].join('\n'),
      );
      await chmod(shim, 0o755);
      const executable = await resolveCliExecutable({
        command: shim,
        projectDir: '/neutral/project',
      });
      await stubSignInHome(join(directory, 'home'), ['command-code']);
      const evidence = await detectRunnerEvidence({
        context: {
          role: 'planner',
          kind: 'cli',
          id: 'command-code',
          credentialPresent: false,
          configGeneration: 'catalog-telemetry-test',
        },
        resolveExecutable: async () => executable,
        includeCatalog: true,
        now: () => 200,
      });
      expect(evidence.catalog.kind).toBe('success');
    });
  }, 15_000);
});

// cmd 1.88.5 writes its catalog cache to ~/.commandcode/cache/model-catalog/v1/ while
// `--list-models` runs; the probe reads it from the HOME it staged, never the host HOME.
describe.runIf(process.platform !== 'win32')('Command Code catalog cache', () => {
  freezeProbeDeadlines();
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const cacheListing = [
    'Available models  ·  2 models',
    '',
    'Open Source',
    '',
    'deepseek/deepseek-v4.1-flash-fast       High throughput V4.1 Flash',
    '',
    'Anthropic',
    '',
    'claude-haiku-4-5                        prev Haiku, still fast for quick tasks',
    '',
    'Docs:  https://commandcode.ai/docs/reference/cli/models',
    '',
  ].join('\n');
  const cacheFolder = ['.commandcode', 'cache', 'model-catalog', 'v1'] as const;
  const cache = readFileSync(
    join(
      import.meta.dirname,
      '../../../testing/fixtures/command-code/model-catalog-cache-1.88.5.json',
    ),
    'utf8',
  );

  async function stageHostHome(directory: string): Promise<void> {
    const hostHome = join(directory, 'host-home');
    await stubSignInHome(hostHome, ['command-code']);
    await mkdir(join(hostHome, ...cacheFolder), { recursive: true });
    const hostCache = JSON.parse(cache);
    hostCache.body.data = [
      {
        ...hostCache.body.data[0],
        display: { label: 'Host DeepSeek' },
        reasoningEfforts: ['low'],
      },
    ];
    await writeFile(join(hostHome, ...cacheFolder, 'catalog-host.json'), JSON.stringify(hostCache));
  }

  async function writeFakeCmd(
    directory: string,
    input: Readonly<{ writesCache: boolean; pidFile?: string }>,
  ): Promise<string> {
    const shim = join(directory, 'cmd');
    await writeFile(
      shim,
      [
        `#!${process.execPath}`,
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "if (process.argv.includes('--version') || process.argv.includes('-v')) { console.log('1.88.5'); process.exit(0); }",
        "if (!process.argv.includes('--list-models')) process.exit(1);",
        ...(input.writesCache
          ? [
              `const folder = path.join(process.env.HOME, ${cacheFolder.map((part) => JSON.stringify(part)).join(', ')});`,
              'fs.mkdirSync(folder, { recursive: true });',
              `fs.writeFileSync(path.join(folder, 'catalog-a813c4ec6551f9c3.json'), ${JSON.stringify(cache)});`,
            ]
          : []),
        `process.stdout.write(${JSON.stringify(cacheListing)});`,
        ...(input.pidFile === undefined
          ? []
          : [
              `fs.writeFileSync(${JSON.stringify(input.pidFile + '.tmp')}, String(process.pid));`,
              `fs.renameSync(${JSON.stringify(input.pidFile + '.tmp')}, ${JSON.stringify(input.pidFile)});`,
              'setInterval(() => {}, 1000);',
            ]),
      ].join('\n'),
    );
    await chmod(shim, 0o755);
    return shim;
  }

  async function detectCatalog(shim: string, configGeneration: string) {
    const executable = await resolveCliExecutable({
      command: shim,
      projectDir: '/neutral/project',
    });
    return detectRunnerEvidence({
      context: {
        role: 'planner',
        kind: 'cli',
        id: 'command-code',
        credentialPresent: false,
        configGeneration,
      },
      resolveExecutable: async () => executable,
      includeCatalog: true,
      now: () => 200,
    });
  }

  it.each([{ timesOut: false }, { timesOut: true }])(
    'gives each listed model the ladder and label of the staged cache (timed out: $timesOut)',
    async ({ timesOut }) => {
      await withTempDir('command-code-cache', async (directory) => {
        await stageHostHome(directory);
        const pidFile = join(directory, 'catalog.pid');
        const shim = await writeFakeCmd(directory, {
          writesCache: true,
          ...(timesOut ? { pidFile } : {}),
        });
        const pending = detectCatalog(shim, `catalog-cache-${String(timesOut)}`);
        if (timesOut) await expireDeadlineAfterFile(pidFile);
        const evidence = await pending;

        if (evidence.catalog.kind !== 'success') {
          throw new Error(`Expected the listing to succeed, got ${evidence.catalog.kind}`);
        }
        expect(
          evidence.catalog.value.find((model) => model.id === 'deepseek/deepseek-v4.1-flash-fast'),
        ).toMatchObject({
          displayName: 'DeepSeek V4.1 Flash Fast (latest)',
          nativeReasoningEfforts: ['off', 'low', 'high', 'max'],
          supportsReasoning: true,
          contextLength: 1_000_000,
          supportsImages: true,
        });
        expect(
          evidence.catalog.value.find((model) => model.id === 'claude-haiku-4-5'),
        ).toMatchObject({ displayName: 'Claude Haiku 4.5', nativeReasoningEfforts: [] });
      });
    },
    15_000,
  );

  it('reads no cache from the host HOME when the listing writes none', async () => {
    await withTempDir('command-code-cache', async (directory) => {
      await stageHostHome(directory);
      const shim = await writeFakeCmd(directory, { writesCache: false });
      const evidence = await detectCatalog(shim, 'catalog-cache-host');

      if (evidence.catalog.kind !== 'success') {
        throw new Error(`Expected the listing to succeed, got ${evidence.catalog.kind}`);
      }
      const deepseek = evidence.catalog.value.find(
        (model) => model.id === 'deepseek/deepseek-v4.1-flash-fast',
      );
      expect(deepseek).toMatchObject({ detail: 'High throughput V4.1 Flash' });
      expect(deepseek).not.toHaveProperty('displayName');
      expect(deepseek).not.toHaveProperty('nativeReasoningEfforts');
    });
  }, 15_000);
});
