import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandBasedPlanner } from './command-invoke.js';
import { ONE_SHOT_API_CAPS } from './types.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { callPlanner } from '#testing/helpers/planner-call.js';

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

describe('createCommandBasedPlanner', () => {
  it('forwards question markers from subprocess stdout to onQuestion', async () => {
    const projectDir = createTempDir('cmd-planner-question');
    createTestGitRepo(projectDir);
    try {
      const marker = '<!-- Q:{"id":"q1","type":"input","text":"Module name?"} -->';
      const artifact = `---
id: T001
title: Test task
action: create
file: src/example.ts
depends_on: []
---

# Plan

### Description
Create the example file.

### Implementation Steps
1. Write the file.

### Tests
- npm test

### Constraints
- Follow project conventions.

${marker}`;
      const planner = createCommandBasedPlanner(
        { kind: 'shell', command: 'printf', args: ['%s', artifact] },
        'test-planner',
      );
      const onQuestion = vi.fn();
      await callPlanner(planner, {
        prompt: 'plan feature',
        projectDir,
        callbacks: { onOutput: vi.fn(), onQuestion },
      });

      expect(onQuestion).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'q1', text: 'Module name?' }),
      ]);
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('escalateHint reports failure when the command writes no files', async () => {
    const projectDir = createTempDir('cmd-planner-hint');
    createTestGitRepo(projectDir);
    try {
      const planner = createCommandBasedPlanner(
        { kind: 'shell', command: 'printf', args: ['hint output'] },
        'test-planner',
        { capabilities: { ...ONE_SHOT_API_CAPS, supportsHintEscalation: true } },
      );
      const result = await planner.escalateHint?.({
        task: makeTask(),
        error: 'broken',
        projectDir,
        callbacks: { onOutput: vi.fn() },
      });
      expect(result?.success).toBe(false);
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('runs the command with the runner environment: declared names only, never the host credentials', async () => {
    const projectDir = createTempDir('cmd-planner-env');
    const captureDir = createTempDir('cmd-planner-env-capture');
    createTestGitRepo(projectDir);
    Object.assign(process.env, PLANTED_ENV);
    try {
      const capture = join(captureDir, 'names.txt');
      const planner = createCommandBasedPlanner(
        {
          kind: 'shell',
          command: process.execPath,
          args: [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(capture)}, Object.keys(process.env).join('\\n'))`,
          ],
          env: ['SPLITBRIEF_DECLARED_TOKEN'],
        },
        'test-planner',
        { capabilities: { ...ONE_SHOT_API_CAPS, supportsHintEscalation: true } },
      );
      await planner.escalateHint?.({
        task: makeTask(),
        error: 'broken',
        projectDir,
        callbacks: { onOutput: vi.fn() },
      });

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
