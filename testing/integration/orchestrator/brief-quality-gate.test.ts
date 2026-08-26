import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLegacyQualityGate } from '../../../src/engine/orchestrator/planning/brief-quality-gate.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { sessionDir, BRIEF_QUALITY_FILE } from '../../../src/core/paths.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function makeFullTask() {
  return makeTask({
    tests: ['validates email format with regex', 'rejects empty string'],
    implementationSteps: ['1. Add validateEmail function', '2. Return null on valid'],
    typeDefs: 'function validateEmail(value: string): string | null',
    scope: { inBounds: ['email validation'], outOfBounds: ['UI changes'] },
    evidence: ['test coverage shows > 90%'],
  });
}

describe('runLegacyQualityGate', () => {
  function setupDir() {
    const projectDir = createTempDir('brief-quality-test');
    dirs.push(projectDir);
    const sessionId = 'sess-gate';
    ensureSessionDir(projectDir, sessionId);
    return { projectDir, sessionId };
  }

  it('writes brief-quality.json and publishes brief_quality_passed event on success', () => {
    const { projectDir, sessionId } = setupDir();
    const { bus, events } = makeBusRecorder();
    const task = makeFullTask();

    const { report, ok } = runLegacyQualityGate({
      tasks: [task],
      projectDir,
      sessionId,
      bus,
      phase: 'planning',
    });

    expect(ok).toBe(true);
    expect(report.passed).toBe(true);

    const reportPath = join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE);
    expect(existsSync(reportPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(persisted.version).toBe(1);
    expect(persisted.passed).toBe(true);

    expect(events.find((e) => e.type === 'brief_quality_passed')).toMatchObject({
      score: 1,
      warningCount: 0,
    });
  });

  it('writes brief-quality.json and publishes brief_quality_failed event on failure', () => {
    const { projectDir, sessionId } = setupDir();
    const { bus, events } = makeBusRecorder();
    const task = makeTask({ tests: [] });

    const { report, ok } = runLegacyQualityGate({
      tasks: [task],
      projectDir,
      sessionId,
      bus,
      phase: 'planning',
    });

    expect(ok).toBe(false);
    expect(report.passed).toBe(false);

    const reportPath = join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE);
    expect(existsSync(reportPath)).toBe(true);

    expect(events.find((e) => e.type === 'brief_quality_failed')?.errorCount).toBeGreaterThan(0);
  });
});
