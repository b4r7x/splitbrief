import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestratorCallbacks } from '../../../src/engine/orchestrator/types.js';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { runWorkflow } from '../../../src/engine/orchestrator/run/workflow.js';
import { loadState } from '../../../src/core/state/persistence.js';
import { readSession } from '../../../src/core/sessions/io.js';
import { BRIEF_QUALITY_FILE, sessionDir } from '../../../src/core/paths.js';
import { isBriefQualityReport } from '../../../src/engine/spec/brief-quality.js';
import { readRecoveryJournal } from '../../../src/core/evidence/ledger-storage.js';
import {
  createHeadlessGitProject,
  preparedHeadlessExecution,
  writeHeadlessConfigYaml,
} from '#testing/helpers/headless-project.js';
import { fauxImplementer } from '#testing/helpers/faux/implementer.js';
import { fauxPlanner } from '#testing/helpers/faux/planner.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { TEST_WORKFLOW_SINKS } from '#testing/helpers/orchestrator-context.js';
import {
  createTaskCompilationAttemptId,
  OwnedPlannerArtifactSchema,
} from '../../../src/core/schemas/task-compilation.js';
import { sha256Hex } from '../../../src/utils/sha256.js';

const dirs: string[] = [];

function phaseResult(logicalName: 'spec.md' | 'plan.md' | 'tasks.md', text: string) {
  const digest = sha256Hex(text);
  return {
    artifact: OwnedPlannerArtifactSchema.parse({
      semanticId: `test-${logicalName}`,
      programId: null,
      batchId: null,
      attemptId: createTaskCompilationAttemptId(),
      logicalName,
      transport: 'stdout-final',
      text,
      byteLength: Buffer.byteLength(text, 'utf8'),
      sha256: digest,
      runtimeReceipt: digest,
      terminal: { status: 'completed', recordId: `test-${logicalName}`, protocolDigest: digest },
      sourceReceipt: { kind: 'stdout-final', resultDigest: digest },
    }),
  };
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) cleanupTempDir(dir);
  }
});

function writeFailureFixture(projectDir: string, mode: 'standard' | 'speckit'): void {
  writeHeadlessConfigYaml(projectDir, [
    'version: 3',
    'planner:',
    '  kind: api',
    '  provider: anthropic',
    '  service: anthropic',
    '  offering: payg',
    '  api_base: https://api.anthropic.com/v1',
    '  api_key: test-key',
    '  model: claude-sonnet-4-6',
    'implementer:',
    '  kind: api',
    '  provider: ollama',
    '  service: ollama',
    '  offering: local',
    '  api_base: http://localhost:11434/v1',
    '  model: qwen2.5-coder:7b',
    '  context_length: 32768',
    'validation:',
    '  typecheck: false',
    '  lint: false',
    '  test: false',
    '  test_command: "noop"',
    'codebase:',
    '  enabled: false',
    'workflow:',
    `  mode: ${mode}`,
    '  approve: none',
    '  persist_transcript: false',
  ]);
}

function makePlannerWithInvalidTaskRepair(): {
  planner: ReturnType<typeof fauxPlanner>['planner'];
  planCallCount: () => number;
  repairCallCount: () => number;
} {
  const prepared = fauxPlanner({
    plans: [
      {
        spec: '# Admitted Specification\n\nThe workflow must fail closed.',
        plan: '# Admitted Plan\n\nGenerate and validate Task Briefs.',
        tasks: [],
      },
    ],
  });
  const originalPlan = prepared.planner.plan.bind(prepared.planner);
  prepared.planner.plan = async (opts) => {
    const result = await originalPlan(opts);
    return {
      ...result,
      phases: [
        phaseResult('spec.md', result.spec),
        phaseResult('plan.md', result.plan),
        phaseResult('tasks.md', 'The planner returned no Task Brief.'),
      ],
    };
  };

  let repairCallCount = 0;
  prepared.planner.review = async () => {
    repairCallCount += 1;
    return {
      text: 'The tasks-only repair still contains no parseable Task Brief.',
      usage: null,
    };
  };

  return {
    planner: prepared.planner,
    planCallCount: () => prepared.state.planCallCount,
    repairCallCount: () => repairCallCount,
  };
}

describe('zero-task planning fails before brief review', { timeout: 30_000 }, () => {
  it.each(['standard', 'speckit'] as const)(
    '%s records the quality failure without entering the blank brief-review screen',
    async (mode) => {
      const projectDir = createHeadlessGitProject(`zero-task-${mode}`);
      dirs.push(projectDir);
      writeFailureFixture(projectDir, mode);
      const sessionId = `sess-zero-task-${mode}`;
      const feature = 'fail closed when the planner returns no Task Brief';
      const events: EngineEvent[] = [];
      let approvalCallCount = 0;
      const callbacks: OrchestratorCallbacks = {
        onApprovalNeeded: async () => {
          approvalCallCount += 1;
          return { approved: true };
        },
        onComplete: () => {},
      };
      const planner = makePlannerWithInvalidTaskRepair();
      const { implementer, state: implementerState } = fauxImplementer({
        steps: [{ success: true, output: 'unexpected implementer call' }],
      });

      const summary = await runWorkflow({
        prepared: preparedHeadlessExecution({ projectDir, sessionId, feature }),
        callbacks,
        sinks: TEST_WORKFLOW_SINKS,
        headless: true,
        _planner: planner.planner,
        _implementer: implementer,
        _eventSink: (event) => events.push(event),
      });

      const ref = { projectDir, sessionId };
      const persistedSession = readSession(ref);
      const persistedState = loadState(ref);
      const qualityPath = join(sessionDir(projectDir, sessionId), BRIEF_QUALITY_FILE);
      const qualityReport: unknown = JSON.parse(readFileSync(qualityPath, 'utf8'));
      if (!isBriefQualityReport(qualityReport)) {
        throw new Error('Persisted brief quality report is invalid');
      }

      expect(planner.planCallCount()).toBe(1);
      expect(planner.repairCallCount()).toBe(mode === 'speckit' ? 2 : 1);
      const artifactDir = sessionDir(projectDir, sessionId);
      expect(readFileSync(join(artifactDir, 'spec.md'), 'utf8')).toContain(
        '# Admitted Specification',
      );
      expect(readFileSync(join(artifactDir, 'plan.md'), 'utf8')).toContain('# Admitted Plan');
      expect(summary.totalTasks).toBe(0);
      expect(persistedSession?.status).toBe('failed');
      expect(persistedState?.phase).not.toBe('reviewing-briefs');
      expect(approvalCallCount).toBe(0);
      expect(implementerState.implementCallCount).toBe(0);
      expect(events.filter((event) => event.type === 'task_started')).toHaveLength(0);
      expect(events.filter((event) => event.type === 'workflow_complete')).toHaveLength(0);
      expect(events.filter((event) => event.type === 'brief_quality_failed')).toHaveLength(2);
      expect(events.filter((event) => event.type === 'brief_quality_passed')).toHaveLength(0);
      expect(persistedState?.generation).toBeNull();
      expect(persistedState?.permit).toBeNull();
      expect(readRecoveryJournal(ref).records.length).toBeGreaterThan(0);
      expect(existsSync(qualityPath)).toBe(true);
      expect(qualityReport.passed).toBe(false);
      expect(qualityReport.issues.length).toBeGreaterThan(0);
      expect(qualityReport.issues.some((issue) => issue.code === 'empty_task_list')).toBe(true);
    },
  );
});
