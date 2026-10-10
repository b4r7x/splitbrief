import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerDiscoveryContext } from '../../core/config/accessors/runner-discovery-context.js';
import { resolveCliExecutable } from '../runners/resolve-cli-executable.js';
import { detectRunnerEvidence } from './runner-evidence.js';

const MAX_CAUSE_CHARS = 200;

function codexContext(): RunnerDiscoveryContext {
  return {
    role: 'planner',
    kind: 'cli',
    id: 'codex',
    credentialPresent: false,
    configGeneration: 'catalog-failure-generation',
  };
}

/** A codex whose `debug models` writes `stderrFile` to stderr and exits with `exitCode`. */
async function installFailingCodex(
  directory: string,
  input: Readonly<{ stderr: string; exitCode: number; stdout?: string }>,
) {
  const stderrFile = join(directory, 'stderr.txt');
  const stdoutFile = join(directory, 'stdout.txt');
  await writeFile(stderrFile, input.stderr);
  await writeFile(stdoutFile, input.stdout ?? '');
  const shim = join(directory, 'codex');
  await writeFile(
    shim,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      "  printf '%s\\n' 'codex-cli 0.146.0'",
      '  exit 0',
      'fi',
      'if [ "$1" = "debug" ] && [ "$2" = "models" ] && [ -z "$3" ]; then',
      `  cat ${JSON.stringify(stdoutFile)}`,
      `  cat ${JSON.stringify(stderrFile)} >&2`,
      `  exit ${input.exitCode}`,
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  );
  await chmod(shim, 0o755);
  return resolveCliExecutable({ command: shim, projectDir: '/neutral/project' });
}

async function catalogOutcomeFor(
  label: string,
  input: Readonly<{ stderr: string; exitCode: number; stdout?: string }>,
) {
  return withTempDir(label, async (directory) => {
    const shim = await installFailingCodex(directory, input);
    const evidence = await detectRunnerEvidence({
      context: codexContext(),
      resolveExecutable: async () => shim,
      includeCatalog: true,
      now: () => 300,
    });
    return evidence.catalog;
  });
}

describe('a catalog listing that exits non-zero', () => {
  it.runIf(process.platform !== 'win32')(
    'is a command failure that names the first stderr line, not an unreadable list',
    async () => {
      const outcome = await catalogOutcomeFor('catalog-failure-stderr', {
        stderr: [
          'Error: Server at http://127.0.0.1:49374 did not provide a compatible V2 health response',
          '    at ~effect/Utils/internal (/$bunfs/root/chunk-wdasang7.js:8:1710)',
          '',
        ].join('\n'),
        exitCode: 1,
      });

      expect(outcome).toEqual({
        kind: 'command-failed',
        cause: 'Server at http://127.0.0.1:49374 did not provide a compatible V2 health response',
      });
    },
    60_000,
  );

  it.runIf(process.platform !== 'win32')(
    'skips blank stderr lines and keeps a cause that carries no error label as written',
    async () => {
      const outcome = await catalogOutcomeFor('catalog-failure-blank-lines', {
        stderr: '\n   \nnot logged in to any provider\nsecond line\n',
        exitCode: 4,
      });

      expect(outcome).toEqual({ kind: 'command-failed', cause: 'not logged in to any provider' });
    },
    60_000,
  );

  it.runIf(process.platform !== 'win32')(
    'names the exit status when the tool wrote nothing to stderr',
    async () => {
      const outcome = await catalogOutcomeFor('catalog-failure-silent', {
        stderr: '',
        exitCode: 2,
      });

      expect(outcome).toEqual({ kind: 'command-failed', cause: 'exit code 2' });
    },
    60_000,
  );

  it.runIf(process.platform !== 'win32')(
    'strips terminal controls from the cause and bounds its length',
    async () => {
      const outcome = await catalogOutcomeFor('catalog-failure-hostile', {
        stderr: `\u001b[31merror: ${'x'.repeat(5_000)}\u001b[0m\u0007\n`,
        exitCode: 1,
      });

      expect(outcome.kind).toBe('command-failed');
      if (outcome.kind !== 'command-failed') return;
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Assert that terminal controls never survive.
      expect(outcome.cause).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
      expect(outcome.cause.startsWith('xxx')).toBe(true);
      expect(outcome.cause.length).toBeLessThanOrEqual(MAX_CAUSE_CHARS);
    },
    60_000,
  );

  it.runIf(process.platform !== 'win32')(
    'is a command failure even when stdout carries a listing',
    async () => {
      const outcome = await catalogOutcomeFor('catalog-failure-with-stdout', {
        stdout: JSON.stringify({ models: [{ id: 'gpt-5.2-codex' }] }),
        stderr: 'Error: catalog request failed\n',
        exitCode: 1,
      });

      expect(outcome).toEqual({ kind: 'command-failed', cause: 'catalog request failed' });
    },
    60_000,
  );
});

describe('a catalog listing that exits zero', () => {
  it.runIf(process.platform !== 'win32')(
    'stays malformed when its output does not parse',
    async () => {
      const outcome = await catalogOutcomeFor('catalog-exit-zero-garbage', {
        stdout: 'this is not a catalog',
        stderr: '',
        exitCode: 0,
      });

      expect(outcome).toEqual({ kind: 'malformed' });
    },
    60_000,
  );
});
