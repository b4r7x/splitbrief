import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { readActive, writeActive } from '../../core/sessions/lifecycle.js';
import { activeFile } from '../../core/paths.js';
import type { Summary } from '../../core/schemas/summary.js';
import { saveFinalSession } from './session-lifecycle.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function makeProjectDir(): string {
  const projectDir = createTempDir('session-lifecycle-test');
  dirs.push(projectDir);
  return projectDir;
}

function makeSummary(): Summary {
  return {
    feature: 'recoverable feature',
    totalTasks: 1,
    completedByLocal: 0,
    escalatedToPlanner: 0,
    skipped: 0,
    failed: 0,
    totalTime: 10,
    tokenUsage: {
      plannerInput: 0,
      plannerOutput: 0,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 0,
      escalationOutput: 0,
    },
    estimatedCostSavings: '$0.00',
    escalationRate: 0,
  };
}

describe('saveFinalSession', () => {
  it('clears the active session by default', () => {
    const projectDir = makeProjectDir();
    const sessionId = 'sess-final';
    writeActive(projectDir, sessionId);

    saveFinalSession({
      projectDir,
      sessionId,
      feature: 'final feature',
      startTime: 1,
      status: 'interrupted',
      summary: makeSummary(),
    });

    expect(existsSync(activeFile(projectDir))).toBe(false);
  });

  it('preserves the active session for recoverable pending recovery stops', () => {
    const projectDir = makeProjectDir();
    const sessionId = 'sess-recovery';
    writeActive(projectDir, sessionId);

    saveFinalSession({
      projectDir,
      sessionId,
      feature: 'recoverable feature',
      startTime: 1,
      status: 'interrupted',
      summary: makeSummary(),
      preserveActive: true,
    });

    expect(readActive(projectDir)).toBe(sessionId);
  });
});
