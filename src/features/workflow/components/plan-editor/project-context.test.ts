import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProjectContext } from './project-context.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';

let tempDir: string;

beforeEach(() => {
  tempDir = createTempDir('project-context-test');
});

afterEach(() => {
  cleanupTempDir(tempDir);
});

describe('buildProjectContext', () => {
  it('returns only name and dir, reading the package name from disk', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({ name: 'my-app' }));

    const context = buildProjectContext(tempDir);

    expect(context).toEqual({ name: 'my-app', dir: tempDir });
    expect(Object.keys(context).sort()).toEqual(['dir', 'name']);
  });

  it('falls back to unknown when package.json is absent', () => {
    const context = buildProjectContext(tempDir);

    expect(context).toEqual({ name: 'unknown', dir: tempDir });
  });
});
