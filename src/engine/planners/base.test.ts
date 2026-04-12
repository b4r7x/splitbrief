import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPlannerBase } from './base.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { makeTask } from '#testing/helpers/fixtures.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

let projectDir: string;

const minimalTask = makeTask();

beforeEach(() => {
  projectDir = createTempDir('planner-base-test');
  createTestGitRepo(projectDir);
});

afterEach(() => {
  cleanupTempDir(projectDir);
});

describe('createPlannerBase — hintSuccessMode', () => {
  it('hintSuccessMode: "files" — succeeds when files are written', async () => {
    const outFile = join(projectDir, 'hint-out.ts');
    const planner = createPlannerBase({
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => {
        writeFileSync(outFile, '// written by escalation');
        return { text: '', usage: null };
      },
      isAvailable: async () => true,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint(minimalTask, 'error', projectDir, { onOutput: () => {} });
    expect(result.success).toBe(true);
  });

  it('hintSuccessMode: "files" — fails when no files are written', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => ({ text: '', usage: null }),
      isAvailable: async () => true,
      hintSuccessMode: 'files',
    });

    const result = await planner.escalateHint(minimalTask, 'error', projectDir, { onOutput: () => {} });
    expect(result.success).toBe(false);
  });

  it('hintSuccessMode: "text" (default) — succeeds when text is non-empty', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => ({ text: 'some hint output', usage: null }),
      isAvailable: async () => true,
    });

    const result = await planner.escalateHint(minimalTask, 'error', projectDir, { onOutput: () => {} });
    expect(result.success).toBe(true);
  });

  it('hintSuccessMode: "text" (default) — fails when text is empty', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => ({ text: '', usage: null }),
      isAvailable: async () => true,
    });

    const result = await planner.escalateHint(minimalTask, 'error', projectDir, { onOutput: () => {} });
    expect(result.success).toBe(false);
  });

  it('supportsHintEscalation: false — always returns success: false', async () => {
    const planner = createPlannerBase({
      invokePlan: async () => ({ text: '', usage: null }),
      invokeEscalate: async () => ({ text: 'lots of output', usage: null }),
      isAvailable: async () => true,
      supportsHintEscalation: false,
    });

    const result = await planner.escalateHint(minimalTask, 'error', projectDir, { onOutput: () => {} });
    expect(result.success).toBe(false);
  });
});
