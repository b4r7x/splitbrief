import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');

function readScripts(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  return manifest.scripts ?? {};
}

describe('package.json publish scripts', () => {
  it('builds exactly once per publish via prepack', () => {
    const scripts = readScripts();

    expect(scripts.prepack).toBe('npm run build');
    expect(scripts.prepublishOnly).toBeUndefined();

    const buildInvocations = Object.entries(scripts).filter(
      ([name, body]) =>
        (name === 'prepack' || name === 'prepublishOnly') && body.includes('npm run build'),
    );
    expect(buildInvocations).toHaveLength(1);
  });
});
