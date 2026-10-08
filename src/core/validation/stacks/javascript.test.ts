import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { javascriptStack } from './javascript.js';

describe('javascriptStack', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir('stack-js');
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it('scripts.test selects npm test', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    expect(javascriptStack.test(dir)).toBe('npm test');
  });

  it('no package.json yields null test command', () => {
    expect(javascriptStack.test(dir)).toBeNull();
  });

  it('declares package.json as its only marker and the documented test patterns', () => {
    expect(javascriptStack.markers).toEqual(['package.json']);
    expect(javascriptStack.testFilePatterns).toEqual(['*.test.js', '*.spec.js', '*.test.mjs']);
  });
});
