import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInitialState } from '../../core/state/machine.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { evaluateBriefQuality } from './brief-quality.js';
import { runBriefQualityGate } from '../orchestrator/planning/shared.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeCallbacks, makePlanner, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { sessionDir, BRIEF_QUALITY_FILE, TASKS_FILE } from '../../core/paths.js';
import { runPlanningPhase } from '../orchestrator/planning/run.js';

const TEST_METADATA = { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'instant' };

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

describe('evaluateBriefQuality — pure unit tests', () => {
  it('valid brief passes with score 1', () => {
    const report = evaluateBriefQuality([makeFullTask()]);
    expect(report.passed).toBe(true);
    expect(report.score).toBe(1);
    expect(report.issues).toHaveLength(0);
    expect(report.version).toBe(1);
  });

  it('missing tests blocks with missing_validation error', () => {
    const task = makeTask({ tests: [] });
    const report = evaluateBriefQuality([task]);
    expect(report.passed).toBe(false);
    const issue = report.issues.find(i => i.code === 'missing_validation');
    expect(issue?.severity).toBe('error');
    expect(issue?.taskId).toBe(task.id);
  });

  it('empty task list blocks with empty_task_list error', () => {
    const report = evaluateBriefQuality([]);
    expect(report.passed).toBe(false);
    expect(report.score).toBe(0.8);
    const issue = report.issues.find(i => i.code === 'empty_task_list');
    expect(issue?.severity).toBe('error');
  });

  it('vague tests block with vague_validation error', () => {
    const task = makeTask({ tests: ['works correctly', 'validate'] });
    const report = evaluateBriefQuality([task]);
    expect(report.passed).toBe(false);
    const issue = report.issues.find(i => i.code === 'vague_validation');
    expect(issue?.severity).toBe('error');
  });

  it('risky task without escalation blocks with missing_escalation error', () => {
    const task = makeTask({
      description: 'Update the auth middleware to validate permissions',
      tests: ['rejects invalid token', 'allows valid request'],
      implementationSteps: ['1. Check auth header'],
    });
    const report = evaluateBriefQuality([task]);
    expect(report.passed).toBe(false);
    const issue = report.issues.find(i => i.code === 'missing_escalation');
    expect(issue?.severity).toBe('error');
  });

  it('missing evidence blocks', () => {
    const task = makeTask({
      tests: ['validates email format'],
      implementationSteps: ['1. Add function'],
      typeDefs: 'function foo(): void',
      scope: { inBounds: ['foo'] },
    });
    const report = evaluateBriefQuality([task]);
    expect(report.passed).toBe(false);
    const issue = report.issues.find(i => i.code === 'missing_evidence');
    expect(issue?.severity).toBe('error');
  });

  it('modify task without code context blocks with missing_code_context error', () => {
    const task = makeTask({
      action: 'modify',
      tests: ['returns correct result'],
      implementationSteps: ['1. Modify the function'],
    });
    const report = evaluateBriefQuality([task]);
    expect(report.passed).toBe(false);
    const issue = report.issues.find(i => i.code === 'missing_code_context');
    expect(issue?.severity).toBe('error');
  });

  it('flags two distinct concrete file paths as multi_file_task', () => {
    const task = makeTask({
      description: 'Update src/api.ts and also modify src/utils.ts for new helpers',
      tests: ['returns expected value'],
      implementationSteps: ['1. Edit src/api.ts', '2. Update src/utils.ts'],
    });
    const report = evaluateBriefQuality([task]);
    expect(report.passed).toBe(false);
    const issue = report.issues.find(i => i.code === 'multi_file_task');
    expect(issue?.severity).toBe('error');
  });

  it('does not flag the same concrete file path twice', () => {
    const task = makeTask({
      description: 'Update src/api.ts and keep src/api.ts aligned with the new helper',
      tests: ['returns expected value'],
      implementationSteps: ['1. Edit src/api.ts', '2. Keep src/api.ts in sync'],
      typeDefs: 'function updateApi(): void',
      scope: { inBounds: ['src/api.ts'], outOfBounds: ['src/utils.ts'] },
      evidence: ['src/api.ts behavior remains covered'],
    });
    const report = evaluateBriefQuality([task]);
    expect(report.passed).toBe(true);
    expect(report.issues.find(i => i.code === 'multi_file_task')).toBeUndefined();
  });

  it('score clamps to 0 when many errors accumulate', () => {
    const task = makeTask({
      action: 'modify',
      tests: [],
      implementationSteps: [],
      description: 'Update src/api.ts and src/utils.ts with auth and database config',
    });
    const report = evaluateBriefQuality([task]);
    expect(report.score).toBe(0);
    expect(report.passed).toBe(false);
  });

  it('missing implementation steps blocks', () => {
    const task = makeTask({ implementationSteps: [] });
    const report = evaluateBriefQuality([task]);
    expect(report.passed).toBe(false);
    const issue = report.issues.find(i => i.code === 'missing_implementation_steps');
    expect(issue?.severity).toBe('error');
  });

  it('missing scope blocks', () => {
    const task = makeFullTask();
    const report = evaluateBriefQuality([{ ...task, scope: undefined }]);
    expect(report.passed).toBe(false);
    const issue = report.issues.find(i => i.code === 'missing_scope');
    expect(issue?.severity).toBe('error');
  });

  it('risk words in description trigger escalation check but not title', () => {
    const task = makeTask({
      title: 'Add auth middleware',
      description: 'Adds a middleware layer with basic routing logic',
      tests: ['routes correctly'],
      implementationSteps: ['1. Add middleware'],
      typeDefs: 'type Middleware = unknown',
      scope: { inBounds: ['middleware routing'], outOfBounds: ['auth token validation'] },
      evidence: ['routing middleware test passes'],
    });
    const report = evaluateBriefQuality([task]);
    expect(report.issues.find(i => i.code === 'missing_escalation')).toBeUndefined();
  });

  it('risky task with escalation provided passes', () => {
    const task = makeTask({
      description: 'Update the auth middleware to validate permissions',
      tests: ['rejects invalid token'],
      implementationSteps: ['1. Check header'],
      typeDefs: 'type AuthMiddleware = unknown',
      scope: { inBounds: ['auth middleware'], outOfBounds: ['database schema'] },
      evidence: ['invalid token test fails before and passes after'],
      escalation: ['Stop if token format is unexpected'],
    });
    const report = evaluateBriefQuality([task]);
    expect(report.issues.find(i => i.code === 'missing_escalation')).toBeUndefined();
  });

  it('non-vague single test passes vague_validation check', () => {
    const task = makeTask({
      tests: ['passes tsc', 'validates schema'],
      typeDefs: 'type SchemaResult = boolean',
      scope: { inBounds: ['schema validation'], outOfBounds: ['runtime behavior'] },
      evidence: ['schema validation test passes'],
    });
    const report = evaluateBriefQuality([task]);
    expect(report.issues.find(i => i.code === 'vague_validation')).toBeUndefined();
  });
});

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

    const { report, ok } = runBriefQualityGate([task], projectDir, sessionId, bus, 'planning');

    expect(ok).toBe(true);
    expect(report.passed).toBe(true);

    const reportPath = join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE);
    expect(existsSync(reportPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(persisted.version).toBe(1);
    expect(persisted.passed).toBe(true);

    const ev = events.find(e => e.type === 'brief_quality_passed');
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

    const { report, ok } = runBriefQualityGate([task], projectDir, sessionId, bus, 'planning');

    expect(ok).toBe(false);
    expect(report.passed).toBe(false);

    const reportPath = join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE);
    expect(existsSync(reportPath)).toBe(true);

    const ev = events.find(e => e.type === 'brief_quality_failed');
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
        projectDir, config, callbacks, metadata: TEST_METADATA, sessionId, bus,
        sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} },
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
    expect(persisted.issues.map((i: { code: string; severity: string }) => [i.code, i.severity])).toEqual(
      expect.arrayContaining([
        ['missing_scope', 'error'],
        ['missing_evidence', 'error'],
      ]),
    );
  });
});
