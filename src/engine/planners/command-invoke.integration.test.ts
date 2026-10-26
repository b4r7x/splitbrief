import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandPlanner } from './command-invoke.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

const PLANTED_ENV = {
  SPLITBRIEF_FAKE_API_KEY: 'fake-api-key',
  CLAUDE_CODE_SESSION_ID: 'fake-session',
  SSH_AUTH_SOCK: '/tmp/fake-agent.sock',
  SPLITBRIEF_DECLARED_TOKEN: 'fake-declared',
};
const originalEnv = Object.fromEntries(
  Object.keys(PLANTED_ENV).map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('createCommandPlanner', () => {
  it('runs the command with the runner environment: declared names only, never the host credentials', async () => {
    const projectDir = createTempDir('cmd-planner-env');
    const captureDir = createTempDir('cmd-planner-env-capture');
    createTestGitRepo(projectDir);
    Object.assign(process.env, PLANTED_ENV);
    try {
      const capture = join(captureDir, 'names.txt');
      const planner = createCommandPlanner(
        makeConfig({
          planner: {
            kind: 'shell',
            command: process.execPath,
            args: [
              '-e',
              `const fs = require('node:fs'); fs.readFileSync(0); fs.writeFileSync(${JSON.stringify(capture)}, Object.keys(process.env).join('\\n'))`,
            ],
            env: ['SPLITBRIEF_DECLARED_TOKEN'],
          },
        }),
        'shell',
      );
      await planner.review('review the run', projectDir, { onOutput: vi.fn() });

      const names = readFileSync(capture, 'utf8').split('\n');
      expect(names).toContain('SPLITBRIEF_DECLARED_TOKEN');
      expect(names).not.toContain('SPLITBRIEF_FAKE_API_KEY');
      expect(names).not.toContain('SSH_AUTH_SOCK');
      expect(names.filter((name) => name.startsWith('CLAUDE_CODE_'))).toEqual([]);
    } finally {
      cleanupTempDir(projectDir);
      cleanupTempDir(captureDir);
    }
  });
});
