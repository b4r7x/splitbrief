import { describe, it, expect } from 'vitest';
import { createStagedProject } from './staged-project.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

describe('createStagedProject', () => {
  it('creates a staged copy of the project', async () => {
    const dir = createTempDir('staged-test');
    createTestGitRepo(dir);
    const staged = await createStagedProject(dir);
    expect(staged.projectDir).not.toBe(dir);
    expect(typeof staged.cleanup).toBe('function');
    staged.cleanup();
    cleanupTempDir(dir);
  });
});
