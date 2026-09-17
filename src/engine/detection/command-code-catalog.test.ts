import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
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
  it.concurrent.each([
    {
      label: 'complete listing with delayed exit',
      stdout: listing,
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
      expected: 'malformed',
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
            `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
            `process.stdout.write(${JSON.stringify(stdout)});`,
            `process.stderr.write(${JSON.stringify(stderr)});`,
            exit === null ? 'setInterval(() => {}, 1000);' : `process.exitCode = ${exit};`,
          ].join('\n'),
        );
        await chmod(shim, 0o755);
        const executable = await resolveCliExecutable({
          command: shim,
          projectDir: '/neutral/project',
        });
        const evidence = await detectRunnerEvidence({
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
});
