import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');

// npm runs all three on `npm publish`, in this order — a second hook means a second build.
const PUBLISH_BUILD_HOOKS = ['prepublishOnly', 'prepack', 'prepare'];

function readScripts(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  return manifest.scripts ?? {};
}

describe('package.json publish scripts', () => {
  it('builds exactly once per publish, via prepare', () => {
    const scripts = readScripts();

    const defined = PUBLISH_BUILD_HOOKS.filter((hook) => scripts[hook] !== undefined);

    expect(defined).toEqual(['prepare']);
    expect(scripts.prepare).toBe('npm run build');
  });
});
