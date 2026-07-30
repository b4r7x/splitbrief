// @vitest-environment node

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cspPolicy, generateCsp, scriptHash } from './generate-csp.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function cspFixture(): Promise<{
  includePath: string;
  outputDirectory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'splitbrief-csp-'));
  const outputDirectory = join(directory, 'client');
  const includePath = join(directory, 'nginx-csp.conf');
  temporaryDirectories.push(directory);
  await mkdir(join(outputDirectory, 'docs'), { recursive: true });

  return { includePath, outputDirectory };
}

describe('static CSP generation', () => {
  it('hashes exact non-empty inline script bytes across the built artifact', async () => {
    const fixture = await cspFixture();
    const firstSource = '\n  window.__theme = "dark";\n';
    const secondSource = 'window.__start = true;';
    await Promise.all([
      writeFile(
        join(fixture.outputDirectory, 'index.html'),
        [
          `<script>${firstSource}</script>`,
          '<script src="/assets/app.js"></script>',
          '<script>   </script>',
        ].join(''),
      ),
      writeFile(
        join(fixture.outputDirectory, 'docs', 'index.html'),
        `<script type="module">${secondSource}</script><script>${firstSource}</script>`,
      ),
    ]);

    const hashes = await generateCsp(fixture);
    const include = await readFile(fixture.includePath, 'utf8');
    const expectedHashes = [scriptHash(firstSource), scriptHash(secondSource)].sort();

    expect(hashes).toEqual(expectedHashes);
    for (const hash of expectedHashes) {
      expect(include).toContain(hash);
    }
    expect(include).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(include).toContain("script-src-attr 'none'");
  });

  it('deduplicates and sorts script hashes in the policy', () => {
    const second = scriptHash('second');
    const first = scriptHash('first');
    const policy = cspPolicy([second, first, second]);

    expect(policy).toContain(["script-src 'self'", ...[first, second].sort()].join(' '));
  });

  it('hashes the browser-normalized script text produced by the HTML parser', () => {
    expect(scriptHash('route\r\nroot\0')).toBe(
      "'sha256-YrtlFkGvhw0dbv7Y8b7hkDnBe6zYTIohKPj+41qFnmA='",
    );
  });

  it('fails closed when the build contains no inline scripts', async () => {
    const fixture = await cspFixture();
    await writeFile(join(fixture.outputDirectory, 'index.html'), '<script src="/app.js"></script>');

    await expect(generateCsp(fixture)).rejects.toThrow(/No inline scripts/);
  });
});
