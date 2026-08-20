import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, realpath, stat, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { RunnerDiscoveryContext } from '../../core/config/accessors/runner-config.js';
import {
  CliExecutableReceiptSchema,
  formatDigestBoundExecutableFingerprint,
  type CliExecutableReceipt,
} from '../../core/discovery/detection.js';
import { CLI_TOOL_CATALOG, type CliToolId } from '../../core/runners/cli-tool-catalog.js';
import { resolveCliExecutable } from '../runners/resolve-cli-executable.js';
import { detectionRuntimeNamespace, detectRunnerEvidence } from './detect.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

const ADMITTED_VERSION = CLI_TOOL_CATALOG.codex.compatibility.testedVersion;

function cliContext(tool: CliToolId = 'codex'): RunnerDiscoveryContext {
  return {
    role: 'planner',
    kind: 'cli',
    id: tool,
    credentialPresent: false,
    configGeneration: 'compiler-runtime-generation',
  };
}

function catalogShimScript(
  input: Readonly<{ version: string; marker: string; record: boolean }>,
): string {
  return [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    `  printf '%s\\n' 'codex-cli ${input.version}'`,
    '  exit 0',
    'fi',
    'if [ "$1" = "debug" ] && [ "$2" = "models" ] && [ "$3" = "--bundled" ]; then',
    ...(input.record
      ? [`  printf '%s\\n' ran > ${JSON.stringify(input.marker)}`]
      : ['  : # catalog branch must never run']),
    `  printf '%s\\n' '{"models":[{"id":"model-a"}]}'`,
    '  exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n');
}

async function installShim(directory: string, name: string, script: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, script, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

function paddedToLength(text: string, length: number): string {
  const padding = length - Buffer.byteLength(text, 'utf8');
  return padding <= 0 ? text : `${text}#${' '.repeat(padding - 1)}`;
}

/**
 * Replaces the file content in place and restores the mtime, so the stat
 * fingerprint (dev/ino/size/mtime) stays byte-for-byte identical to the
 * original while the content digest changes. utimes has sub-millisecond
 * precision loss, so the caller must re-derive the stat from disk afterwards.
 */
async function replaceInPlaceWithPreservedStat(path: string, content: string, mtimeMs: number) {
  await writeFile(path, content);
  await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
}

function statTuple(info: Awaited<ReturnType<typeof stat>>) {
  return {
    dev: Number(info.dev),
    ino: Number(info.ino),
    size: Number(info.size),
    mtimeMs: Number(info.mtimeMs),
  };
}

/**
 * Builds a schema-valid receipt whose stat tuple matches the current disk
 * state but whose content digest is stale — the strongest fake loader: a
 * stat-only revalidation cannot distinguish the binary, only the digest-bound
 * runtime identity can.
 */
async function staleDigestReceipt(
  input: Readonly<{
    path: string;
    claimedContent: string;
  }>,
): Promise<CliExecutableReceipt> {
  const info = await stat(input.path);
  const fingerprint = statTuple(info);
  const contentDigest = createHash('sha256').update(input.claimedContent).digest('hex');
  const boundFingerprint = formatDigestBoundExecutableFingerprint({
    fingerprint,
    contentDigest,
  });
  if (boundFingerprint === null) throw new Error('fixture fingerprint did not format');
  const canonicalPath = resolve(input.path);
  const realPath = await realpath(canonicalPath);
  const result = CliExecutableReceiptSchema.safeParse({
    path: realPath,
    fingerprint,
    executableIdentity: {
      canonicalPath,
      realPath,
      platformFileId: `${fingerprint.dev}:${fingerprint.ino}`,
      fingerprint: boundFingerprint,
      resolvedAt: 1,
    },
  });
  if (!result.success) throw new Error('fixture receipt did not parse');
  return result.data;
}

describe('detection runtime binding', () => {
  it('derives the same namespace for the same receipt and none for a metadata-only identity', async () => {
    await withTempDir('detect-runtime-namespace', async (directory) => {
      const shim = await installShim(
        directory,
        'codex',
        catalogShimScript({
          version: ADMITTED_VERSION,
          marker: join(directory, 'ran'),
          record: true,
        }),
      );
      const receipt = await resolveCliExecutable(shim, '/neutral/project');
      const again = await resolveCliExecutable(shim, '/neutral/project');

      expect(detectionRuntimeNamespace(receipt)).toBe(detectionRuntimeNamespace(again));
      expect(detectionRuntimeNamespace(receipt)).toMatch(
        /^splitbrief-detection-runtime-v1:\d+:\d+:\d+:[\d.]+:sha256:[a-f0-9]{64}$/,
      );
      expect(
        detectionRuntimeNamespace({ path: shim, fingerprint: { ...receipt.fingerprint } }),
      ).toBeUndefined();
    });
  });

  itUnix('reports a supported exact runtime with a bound catalog dispatch', async () => {
    await withTempDir('detect-supported-runtime', async (directory) => {
      const marker = join(directory, 'catalog-ran');
      const shim = await installShim(
        directory,
        'codex',
        catalogShimScript({ version: ADMITTED_VERSION, marker, record: true }),
      );
      const receipt = await resolveCliExecutable(shim, '/neutral/project');

      const evidence = await detectRunnerEvidence({
        context: cliContext(),
        resolveExecutable: async () => receipt,
        includeCatalog: true,
        now: () => 1_000,
      });

      expect(evidence.catalog).toEqual({
        kind: 'success',
        value: [{ id: 'model-a', nativeOrder: 0 }],
      });
      expect(existsSync(marker)).toBe(true);
    });
  });

  itUnix('keeps an incompatible runtime unsupported with zero catalog dispatch', async () => {
    await withTempDir('detect-unsupported-runtime', async (directory) => {
      const marker = join(directory, 'catalog-ran');
      const shim = await installShim(
        directory,
        'codex',
        catalogShimScript({ version: '0.39.9', marker, record: true }),
      );
      const receipt = await resolveCliExecutable(shim, '/neutral/project');

      const evidence = await detectRunnerEvidence({
        context: cliContext(),
        resolveExecutable: async () => receipt,
        includeCatalog: true,
        now: () => 2_000,
      });

      expect(evidence.catalog).toEqual({ kind: 'unsupported' });
      expect(existsSync(marker)).toBe(false);
    });
  });

  itUnix(
    'keeps an unverified prerelease runtime unsupported with zero catalog dispatch',
    async () => {
      await withTempDir('detect-unverified-runtime', async (directory) => {
        const marker = join(directory, 'catalog-ran');
        const shim = await installShim(
          directory,
          'codex',
          catalogShimScript({ version: '0.40.0-rc.1', marker, record: true }),
        );
        const receipt = await resolveCliExecutable(shim, '/neutral/project');

        const evidence = await detectRunnerEvidence({
          context: cliContext(),
          resolveExecutable: async () => receipt,
          includeCatalog: true,
          now: () => 3_000,
        });

        expect(evidence.catalog).toEqual({ kind: 'unsupported' });
        expect(existsSync(marker)).toBe(false);
      });
    },
  );
});

describe('fake loader and different-cache zero-dispatch', () => {
  itUnix(
    'refuses a fake loader whose receipt no longer matches the binary, with zero catalog dispatch',
    async () => {
      await withTempDir('detect-fake-loader', async (directory) => {
        const marker = join(directory, 'catalog-ran');
        const shimPath = join(directory, 'codex');
        const replaced = catalogShimScript({ version: ADMITTED_VERSION, marker, record: true });
        // The original shares the replaced script's exact byte length, so a
        // content swap can preserve the stat fingerprint byte-for-byte.
        const original = paddedToLength(
          catalogShimScript({ version: ADMITTED_VERSION, marker, record: false }),
          Buffer.byteLength(replaced, 'utf8'),
        );
        await installShim(directory, 'codex', original);
        const before = await stat(shimPath);
        // Swap the content: dev/ino/size stay identical and mtime is restored,
        // so only the content digest differs.
        await replaceInPlaceWithPreservedStat(shimPath, replaced, before.mtimeMs);
        const after = await stat(shimPath);
        expect(after.dev).toBe(before.dev);
        expect(after.ino).toBe(before.ino);
        expect(after.size).toBe(before.size);
        // The loader serves a schema-valid receipt built from the current
        // stat but carrying the stale content digest: stat-only revalidation
        // cannot distinguish the binary.
        const fake = await staleDigestReceipt({ path: shimPath, claimedContent: original });

        const evidence = await detectRunnerEvidence({
          context: cliContext(),
          resolveExecutable: async () => fake,
          includeCatalog: true,
          now: () => 4_000,
        });

        expect(evidence.catalog.kind).not.toBe('success');
        expect(evidence.executable).toMatchObject({ kind: 'identity-drifted' });
        expect(existsSync(marker)).toBe(false);
      });
    },
  );

  itUnix(
    'does not dispatch a catalog under a different cache namespace than the receipt was admitted in',
    async () => {
      await withTempDir('detect-different-cache', async (directory) => {
        const markerOne = join(directory, 'catalog-ran-one');
        const markerTwo = join(directory, 'catalog-ran-two');
        const shimPath = join(directory, 'codex');
        const first = catalogShimScript({
          version: ADMITTED_VERSION,
          marker: markerOne,
          record: true,
        });
        const second = catalogShimScript({
          version: ADMITTED_VERSION,
          marker: markerTwo,
          record: true,
        });
        await installShim(directory, 'codex', first);
        const before = await stat(shimPath);
        const receipt = await resolveCliExecutable(shimPath, '/neutral/project');
        const namespace = detectionRuntimeNamespace(receipt);
        expect(namespace).toBeDefined();

        const firstEvidence = await detectRunnerEvidence({
          context: cliContext(),
          resolveExecutable: async () => receipt,
          includeCatalog: true,
          now: () => 5_000,
        });
        expect(firstEvidence.catalog).toEqual({
          kind: 'success',
          value: [{ id: 'model-a', nativeOrder: 0 }],
        });
        expect(existsSync(markerOne)).toBe(true);

        // The binary is replaced in place; the second call's loader still
        // serves the first call's receipt — the cache namespace it was
        // admitted under no longer matches the executable that would run.
        await replaceInPlaceWithPreservedStat(
          shimPath,
          paddedToLength(second, first.length),
          before.mtimeMs,
        );

        const secondEvidence = await detectRunnerEvidence({
          context: cliContext(),
          resolveExecutable: async () => receipt,
          includeCatalog: true,
          now: () => 6_000,
        });

        expect(secondEvidence.catalog.kind).not.toBe('success');
        expect(existsSync(markerTwo)).toBe(false);
      });
    },
  );

  itUnix('leaves a metadata-only fake loader unverified with zero catalog dispatch', async () => {
    await withTempDir('detect-metadata-loader', async (directory) => {
      const marker = join(directory, 'catalog-ran');
      const shim = await installShim(
        directory,
        'codex',
        catalogShimScript({ version: ADMITTED_VERSION, marker, record: true }),
      );
      const receipt = await resolveCliExecutable(shim, '/neutral/project');
      const fake = { path: receipt.path, fingerprint: { ...receipt.fingerprint } };

      expect(detectionRuntimeNamespace(fake)).toBeUndefined();

      const evidence = await detectRunnerEvidence({
        context: cliContext(),
        resolveExecutable: async () => fake,
        includeCatalog: true,
        now: () => 7_000,
      });

      expect(evidence.catalog).toEqual({ kind: 'unsupported' });
      expect(existsSync(marker)).toBe(false);
    });
  });
});
