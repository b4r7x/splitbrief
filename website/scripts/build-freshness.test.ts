// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildInputDigest,
  checkBuildFreshness,
  invalidateBuildFreshness,
  recordBuildFreshness,
} from './build-freshness.js';

const temporaryDirectories: string[] = [];

async function freshnessFixture() {
  const websiteRoot = await mkdtemp(join(tmpdir(), 'splitbrief-build-freshness-'));
  temporaryDirectories.push(websiteRoot);
  await mkdir(join(websiteRoot, 'src'));
  await writeFile(join(websiteRoot, 'src', 'entry.ts'), 'export const value = 1;\n');

  return {
    inputPaths: ['src'],
    stampPath: join(websiteRoot, 'dist', 'build-inputs.sha256'),
    websiteRoot,
  };
}

async function defaultInputFixture() {
  const options = await freshnessFixture();
  await Promise.all(
    ['content', 'public', 'scripts', 'shared'].map((directory) =>
      mkdir(join(options.websiteRoot, directory)),
    ),
  );
  await Promise.all([
    writeFile(join(options.websiteRoot, 'content', 'page.mdx'), '# Page\n'),
    writeFile(join(options.websiteRoot, 'public', 'favicon.svg'), '<svg/>'),
    writeFile(join(options.websiteRoot, 'scripts', 'build.ts'), 'export {};\n'),
    writeFile(join(options.websiteRoot, 'shared', 'site.ts'), 'export const name = "one";\n'),
    ...[
      'package-lock.json',
      'package.json',
      'source.config.ts',
      'tsconfig.json',
      'vite.config.ts',
    ].map((file) => writeFile(join(options.websiteRoot, file), '{}\n')),
  ]);
  return { websiteRoot: options.websiteRoot };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('built output freshness', () => {
  it('accepts an unchanged input tree after recording the build', async () => {
    const options = await freshnessFixture();

    await recordBuildFreshness(options);

    await expect(checkBuildFreshness(options)).resolves.toBeUndefined();
  });

  it('rejects missing stamps and source changes after a build', async () => {
    const options = await freshnessFixture();

    await expect(checkBuildFreshness(options)).rejects.toThrow(/npm run build first/);
    await recordBuildFreshness(options);
    await writeFile(join(options.websiteRoot, 'src', 'entry.ts'), 'export const value = 2;\n');

    await expect(checkBuildFreshness(options)).rejects.toThrow(/output is stale/);
  });

  it('includes the production origin and invalidates a prior successful stamp', async () => {
    const options = await freshnessFixture();
    const [firstOriginDigest, secondOriginDigest] = await Promise.all([
      buildInputDigest({ ...options, siteUrl: 'https://one.example' }),
      buildInputDigest({ ...options, siteUrl: 'https://two.example' }),
    ]);
    expect(firstOriginDigest).not.toBe(secondOriginDigest);

    await recordBuildFreshness({ ...options, siteUrl: 'https://one.example' });
    await expect(
      checkBuildFreshness({ ...options, siteUrl: 'https://two.example' }),
    ).rejects.toThrow(/output is stale/);

    await invalidateBuildFreshness(options);
    await expect(checkBuildFreshness(options)).rejects.toThrow(/npm run build first/);
  });

  it('invalidates the default digest when shared build input changes', async () => {
    const options = await defaultInputFixture();
    const originalDigest = await buildInputDigest(options);

    await writeFile(join(options.websiteRoot, 'shared', 'site.ts'), 'export const name = "two";\n');

    await expect(buildInputDigest(options)).resolves.not.toBe(originalDigest);
  });
});
