import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState } from '../../../src/core/state/machine.js';
import type { WorkflowState } from '../../../src/core/schemas/workflow.js';
import { runPlanningPhase } from '../../../src/engine/orchestrator/planning/run.js';
import { runBriefQualityGate } from '../../../src/engine/orchestrator/planning/planning-helpers.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import {
  makeCallbacks,
  makePlanner,
  makeBusRecorder,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../src/core/paths-io.js';
import { sessionDir, BRIEF_QUALITY_FILE, TASKS_FILE } from '../../../src/core/paths.js';
import {
  makeWorkflowMetadata,
  TEST_WORKFLOW_SINKS,
} from '#testing/helpers/orchestrator-context.js';

const TEST_METADATA = makeWorkflowMetadata('instant');

const MINIMAL_TASKS_MD = `---
id: T001
title: Rename foo to bar
action: modify
file: src/foo.ts
---

### Description
Rename the symbol.

### Tests
- passes tsc
`;

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

describe('runBriefQualityGate', () => {
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

    const { report, ok } = runBriefQualityGate({
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

    const ev = events.find((e) => e.type === 'brief_quality_passed');
    expect(ev).toBeDefined();
    if (ev && 'score' in ev) {
      expect(ev.score).toBe(1);
      expect(ev.warningCount).toBe(0);
    }
  });

  it('writes brief-quality.json and publishes brief_quality_failed event on failure', () => {
    const { projectDir, sessionId } = setupDir();
    const { bus, events } = makeBusRecorder();
    const task = makeTask({ tests: [] });

    const { report, ok } = runBriefQualityGate({
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

    const ev = events.find((e) => e.type === 'brief_quality_failed');
    expect(ev).toBeDefined();
    if (ev && 'errorCount' in ev) {
      expect(ev.errorCount).toBeGreaterThan(0);
    }
  });

  it('gate failure prevents planning from entering implementing phase', async () => {
    const projectDir = createTempDir('brief-quality-int');
    dirs.push(projectDir);
    const sessionId = 'sess-gate-int';
    ensureSessionDir(projectDir, sessionId);

    const badTask = makeTask({ id: 'T001', scope: undefined, evidence: [] });
    const planner = makePlanner({
      instantPlan: vi.fn().mockResolvedValue({
        spec: '',
        plan: '',
        tasks: [badTask],
        usage: { inputTokens: 10, outputTokens: 5 },
        phases: [{ text: MINIMAL_TASKS_MD, filename: TASKS_FILE }],
      }),
    });
    const { callbacks } = makeCallbacks();
    const config = makeConfig({ workflow: { mode: 'instant' } });
    const { bus } = makeBusRecorder();
    const initial = createInitialState('rename foo');
    const state: WorkflowState = { ...initial, phase: 'idle' };

    const result = await runPlanningPhase({
      wctx: {
        projectDir,
        config,
        callbacks,
        metadata: TEST_METADATA,
        sessionId,
        bus,
        sinks: TEST_WORKFLOW_SINKS,
      },
      planner,
      state,
      feature: 'rename foo',
    });

    expect(result.cancelled).toBe(true);
    expect(result.state.phase).toBe('idle');
    expect(result.tasks).toHaveLength(0);

    const reportPath = join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE);
    expect(existsSync(reportPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(
      persisted.issues.map((i: { code: string; severity: string }) => [i.code, i.severity]),
    ).toEqual(
      expect.arrayContaining([
        ['missing_scope', 'error'],
        ['missing_evidence', 'error'],
      ]),
    );
  });
});
