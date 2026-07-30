// @vitest-environment node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WEBSITE_ROOT } from './site.js';

const packageManifestSchema = z.object({
  devDependencies: z.record(z.string(), z.string()),
  engines: z.object({ node: z.string() }),
  scripts: z.record(z.string(), z.string()),
});

describe('website package contract', () => {
  it('keeps source generation explicit and the Lighthouse toolchain exact', async () => {
    const manifest = packageManifestSchema.parse(
      JSON.parse(await readFile(resolve(WEBSITE_ROOT, 'package.json'), 'utf8')),
    );

    expect(manifest.scripts.postinstall).toBeUndefined();
    expect(manifest.scripts['generate:source']).toBe('fumadocs-mdx');
    expect(manifest.scripts.typecheck).toMatch(/^npm run generate:source && /);
    expect(manifest.scripts.test).toMatch(/^npm run generate:source && /);
    expect(manifest.engines.node).toBe('^22.19.0 || ^24.0.0 || ^26.0.0');
    expect(manifest.devDependencies['@lhci/cli']).toBeUndefined();
    expect(manifest.devDependencies.lighthouse).toBe('13.4.1');
    expect(manifest.devDependencies['chrome-launcher']).toBe('1.2.1');
  });
});
