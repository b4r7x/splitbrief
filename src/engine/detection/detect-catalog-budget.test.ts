import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerDiscoveryContext } from '../../core/config/accessors/runner-config.js';
import { resolveCliExecutable } from '../runners/resolve-cli-executable.js';
import { detectRunnerEvidence } from './detect.js';

const OLD_CEILING_BYTES = 64 * 1024;
const CODEX_CATALOG_BUDGET_BYTES = 2 * 1024 * 1024;

function codexContext(model?: string): RunnerDiscoveryContext {
  return {
    role: 'planner',
    kind: 'cli',
    id: 'codex',
    ...(model === undefined ? {} : { model }),
    credentialPresent: false,
    configGeneration: 'catalog-budget-generation',
  };
}

async function installCodexShim(directory: string, catalogFile: string) {
  const shim = join(directory, 'codex');
  await writeFile(
    shim,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then',
      "  printf '%s\\n' 'codex-cli 0.146.0'",
      '  exit 0',
      'fi',
      'if [ "$1" = "debug" ] && [ "$2" = "models" ] && [ "$3" = "--bundled" ]; then',
      `  cat ${JSON.stringify(catalogFile)}`,
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  );
  await chmod(shim, 0o755);
  return resolveCliExecutable(shim, '/neutral/project');
}

function promptPayload(model: string): string {
  return `You are ${model}, a coding agent running inside a terminal sandbox. `.repeat(1_100);
}

function bundledCatalogFixture(): string {
  return JSON.stringify({
    models: [
      {
        slug: 'gpt-5.2-codex',
        display_name: 'GPT-5.2 Codex',
        is_default: true,
        supported_reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
        base_instructions: promptPayload('gpt-5.2-codex'),
      },
      {
        slug: 'gpt-5.2',
        display_name: 'GPT-5.2',
        supported_reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
        base_instructions: promptPayload('gpt-5.2'),
      },
      {
        slug: 'gpt-5.1-codex-mini',
        display_name: 'GPT-5.1 Codex Mini',
        supported_reasoning_efforts: ['low', 'medium', 'high'],
        base_instructions: promptPayload('gpt-5.1-codex-mini'),
      },
      {
        slug: 'gpt-5.1',
        display_name: 'GPT-5.1',
        hidden: true,
        supported_reasoning_efforts: ['low', 'medium', 'high'],
        base_instructions: promptPayload('gpt-5.1'),
      },
    ],
  });
}

describe('catalog probe output budget', () => {
  it.runIf(process.platform !== 'win32')(
    'parses a catalog larger than the old 64KiB ceiling',
    async () => {
      await withTempDir('detect-catalog-over-old-ceiling', async (directory) => {
        const stdout = JSON.stringify({
          models: [{ id: 'model-large', base_instructions: 'x'.repeat(80 * 1024) }],
        });
        expect(Buffer.byteLength(stdout, 'utf8')).toBeGreaterThan(OLD_CEILING_BYTES);
        expect(Buffer.byteLength(stdout, 'utf8')).toBeLessThan(CODEX_CATALOG_BUDGET_BYTES);
        const catalogFile = join(directory, 'catalog.json');
        await writeFile(catalogFile, stdout);
        const shim = await installCodexShim(directory, catalogFile);

        const evidence = await detectRunnerEvidence({
          context: codexContext(),
          resolveExecutable: async () => shim,
          includeCatalog: true,
          now: () => 200,
        });

        expect(evidence.catalog).toEqual({
          kind: 'success',
          value: [{ id: 'model-large', nativeOrder: 0 }],
        });
      });
    },
    60_000,
  );

  it.runIf(process.platform !== 'win32')(
    'resolves output over the 2MiB codex budget as malformed',
    async () => {
      await withTempDir('detect-catalog-over-budget', async (directory) => {
        const catalogFile = join(directory, 'catalog.json');
        await writeFile(catalogFile, 'x'.repeat(CODEX_CATALOG_BUDGET_BYTES + 4_096));
        const shim = await installCodexShim(directory, catalogFile);

        const evidence = await detectRunnerEvidence({
          context: codexContext(),
          resolveExecutable: async () => shim,
          includeCatalog: true,
          now: () => 201,
        });

        expect(evidence.catalog).toEqual({ kind: 'malformed' });
      });
    },
    60_000,
  );

  it.runIf(process.platform !== 'win32')(
    'parses a realistic 0.146.0 bundled catalog of roughly 300KB to the full model list',
    async () => {
      await withTempDir('detect-catalog-realistic', async (directory) => {
        const stdout = bundledCatalogFixture();
        expect(Buffer.byteLength(stdout, 'utf8')).toBeGreaterThan(262_144);
        expect(Buffer.byteLength(stdout, 'utf8')).toBeLessThan(CODEX_CATALOG_BUDGET_BYTES);
        const catalogFile = join(directory, 'catalog.json');
        await writeFile(catalogFile, stdout);
        const shim = await installCodexShim(directory, catalogFile);

        const evidence = await detectRunnerEvidence({
          context: codexContext('gpt-5.2-codex'),
          resolveExecutable: async () => shim,
          includeCatalog: true,
          now: () => 202,
        });

        expect(evidence.catalog).toEqual({
          kind: 'success',
          value: [
            {
              id: 'gpt-5.2-codex',
              nativeOrder: 0,
              displayName: 'GPT-5.2 Codex',
              nativeDefault: true,
              nativeReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
              supportsReasoning: true,
            },
            {
              id: 'gpt-5.2',
              nativeOrder: 1,
              displayName: 'GPT-5.2',
              nativeReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
              supportsReasoning: true,
            },
            {
              id: 'gpt-5.1-codex-mini',
              nativeOrder: 2,
              displayName: 'GPT-5.1 Codex Mini',
              nativeReasoningEfforts: ['low', 'medium', 'high'],
              supportsReasoning: true,
            },
            {
              id: 'gpt-5.1',
              nativeOrder: 3,
              displayName: 'GPT-5.1',
              nativeHidden: true,
              nativeReasoningEfforts: ['low', 'medium', 'high'],
              supportsReasoning: true,
            },
          ],
        });
        expect(evidence.modelRun.kind).toBe('listed-unverified');
      });
    },
    60_000,
  );
});
