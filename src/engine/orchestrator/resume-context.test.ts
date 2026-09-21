import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { sessionDir, SESSION_LOG_FILE } from '../../core/paths.js';
import { createInitialState } from '../../core/state/machine.js';
import type { ResumeContextHolder } from './types.js';
import type { RunnerCallContext } from '../calls/types.js';
import type { Planner } from '../planners/types.js';
import {
  applyRebuiltContext,
  autoCompactResumeContext,
  createSessionExpiredHandler,
} from './resume-context.js';

function workflowConfig(compactionThreshold?: number) {
  return {
    maxRetries: 3,
    compactionFormat: 'auto' as const,
    ...(compactionThreshold !== undefined && { compactionThreshold }),
  };
}

type CompactionPlanner = Pick<Planner, 'capabilities' | 'summarize' | 'summarizeStructured'>;

function summarizingPlanner({
  supportsSelfSummarisation = true,
  ...hooks
}: { supportsSelfSummarisation?: boolean } & Partial<
  Pick<Planner, 'summarize' | 'summarizeStructured'>
> = {}): CompactionPlanner {
  return {
    capabilities: {
      supportsConversationalPlanning: false,
      supportsHintEscalation: true,
      supportsSessionResume: false,
      supportsEffort: false,
      supportsImages: false,
      supportsSelfSummarisation,
    },
    summarize: async () => {
      throw new Error('summarize should not be called');
    },
    ...hooks,
  };
}

const cliPlannerConfig = { kind: 'cli' as const, tool: 'claude-code' as const };
const apiPlannerConfig = {
  kind: 'api' as const,
  provider: 'ollama' as const,
  service: 'ollama' as const,
  offering: 'local' as const,
  apiBase: 'http://localhost:11434/v1',
  model: 'test',
};

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupSession(logLines: string[] = []): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('resume-context-test');
  dirs.push(projectDir);
  const sessionId = 'sess-resume';
  ensureSessionDir(projectDir, sessionId);
  if (logLines.length > 0) {
    const file = join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE);
    writeFileSync(file, logLines.map((l) => l + '\n').join(''));
  }
  return { projectDir, sessionId };
}

function messageEntry(role: 'user' | 'assistant', text: string): string {
  return JSON.stringify({
    kind: 'message',
    ts: new Date('2025-01-01T00:00:00Z').toISOString(),
    role,
    text,
    phase: 'planning',
  });
}

function numberedMessageEntry(index: number): string {
  return JSON.stringify({
    kind: 'message',
    ts: 1000 + index,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `msg ${index}`,
    phase: 'planning',
  });
}

describe('applyRebuiltContext', () => {
  it('populates the resume holder with user+assistant messages read from disk', async () => {
    const { projectDir, sessionId } = setupSession([
      messageEntry('user', 'add auth'),
      messageEntry('assistant', 'here is the spec'),
    ]);
    const { bus, events } = makeBusRecorder();
    const resumeHolder: ResumeContextHolder = { messages: [] };

    await applyRebuiltContext({
      projectDir,
      sessionId,
      bus,
      resumeHolder,
    });

    expect(resumeHolder.messages).toEqual([
      { role: 'user', content: 'add auth' },
      { role: 'assistant', content: 'here is the spec' },
    ]);
    expect(events.find((e) => e.type === 'warning')).toBeUndefined();
  });

  it('skips populating the holder when requireNonEmpty is set and no messages were rebuilt', async () => {
    const { projectDir, sessionId } = setupSession();
    const { bus, events } = makeBusRecorder();
    const resumeHolder: ResumeContextHolder = {
      messages: [{ role: 'user', content: 'carried over' }],
    };

    await applyRebuiltContext({
      projectDir,
      sessionId,
      bus,
      resumeHolder,
      requireNonEmpty: true,
    });

    expect(resumeHolder.messages).toEqual([{ role: 'user', content: 'carried over' }]);
    expect(events.find((e) => e.type === 'warning')).toBeUndefined();
  });

  it('populates the holder even on non-empty build when requireNonEmpty is set', async () => {
    const { projectDir, sessionId } = setupSession([messageEntry('user', 'keep me')]);
    const { bus } = makeBusRecorder();
    const resumeHolder: ResumeContextHolder = { messages: [] };

    await applyRebuiltContext({
      projectDir,
      sessionId,
      bus,
      resumeHolder,
      requireNonEmpty: true,
    });

    expect(resumeHolder.messages).toEqual([{ role: 'user', content: 'keep me' }]);
  });

  it('tolerates a missing resumeHolder', async () => {
    const { projectDir, sessionId } = setupSession();
    const { bus, events } = makeBusRecorder();

    await applyRebuiltContext({
      projectDir,
      sessionId,
      bus,
      resumeHolder: undefined,
    });

    expect(events.some((e) => e.type === 'warning')).toBe(false);
  });
});

describe('autoCompactResumeContext', () => {
  it('summarizes older persisted messages when resume context exceeds the configured threshold', async () => {
    const originalEntries = Array.from({ length: 12 }, (_, index) => numberedMessageEntry(index));
    const { projectDir, sessionId } = setupSession(originalEntries);
    const { bus, events } = makeBusRecorder();
    const summarizedBatches: Array<Array<{ role: string; text: string }>> = [];
    const startedAt = Date.now();
    const call: RunnerCallContext = {
      callId: 'compaction-call-test',
      role: 'compaction',
      backendKind: 'cli',
      runnerName: 'summary-planner',
    };

    const nextState = await autoCompactResumeContext({
      projectDir,
      sessionId,
      bus,
      config: { workflow: workflowConfig(10), planner: cliPlannerConfig },
      state: createInitialState('resume'),
      planner: summarizingPlanner({
        summarize: async (messages, opts) => {
          summarizedBatches.push(messages);
          opts?.callbacks?.onCallEvent?.({ type: 'call_started', ts: startedAt, ...call });
          opts?.callbacks?.onCallEvent?.({
            type: 'call_completed',
            ts: startedAt + 1,
            ...call,
            status: 'completed',
            error: null,
            partial: false,
            startedAt,
            endedAt: startedAt + 1,
            durationMs: 1,
            usage: { inputTokens: 800, outputTokens: 120 },
            nativeSessionId: null,
          });
          return {
            text: '## Summary\nCompacted older work',
            usage: { inputTokens: 800, outputTokens: 120 },
          };
        },
      }),
    });

    const file = join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE);
    const entries = readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(summarizedBatches).toHaveLength(1);
    expect(summarizedBatches[0]).toHaveLength(3);
    expect(entries).toHaveLength(originalEntries.length + 1);
    expect(entries.at(-1)).toMatchObject({
      kind: 'summary',
      text: '## Summary\nCompacted older work',
      summarizedUpTo: '1002',
    });
    expect(events.find((event) => event.type === 'warning')).toBeUndefined();
    expect(nextState.tokenUsage.plannerInput).toBe(800);
    expect(nextState.tokenUsage.plannerOutput).toBe(120);
    expect(events.some((event) => event.type === 'cost_update')).toBe(true);
    expect(
      events.filter((event) => event.type.startsWith('runner_call_')).map((event) => event.type),
    ).toEqual(['runner_call_started', 'runner_call_completed', 'runner_call_activity']);
    expect(events.find((event) => event.type === 'runner_call_completed')).toMatchObject({
      callId: 'compaction-call-test',
      role: 'compaction',
    });
    expect(events.find((event) => event.type === 'runner_call_activity')).toMatchObject({
      callId: 'compaction-call-test',
      role: 'compaction',
      stage: 'completed',
      kind: 'text',
    });
  });

  it('does not compact when the workflow signal is already aborted', async () => {
    const originalEntries = Array.from({ length: 12 }, (_, index) => numberedMessageEntry(index));
    const { projectDir, sessionId } = setupSession(originalEntries);
    const { bus, events } = makeBusRecorder();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await autoCompactResumeContext({
      projectDir,
      sessionId,
      bus,
      config: { workflow: workflowConfig(10), planner: cliPlannerConfig },
      state: createInitialState('resume'),
      signal: controller.signal,
      planner: summarizingPlanner(),
    });

    const file = join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE);
    expect(readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(originalEntries.length);
    expect(events.find((event) => event.type === 'warning')).toBeUndefined();
    expect(events.find((event) => event.type.startsWith('runner_call_'))).toBeUndefined();
  });

  it('uses structured compaction for api planners in auto mode', async () => {
    const originalEntries = Array.from({ length: 12 }, (_, index) => numberedMessageEntry(index));
    const { projectDir, sessionId } = setupSession(originalEntries);
    const { bus, events } = makeBusRecorder();
    const structured = {
      goal: 'resume api planner',
      stepsCompleted: ['older turns compacted'],
      currentStep: 'resume',
      filesModified: ['src/engine/orchestrator/resume-context.ts'],
      constraintsDiscovered: ['api planners use structured auto mode'],
      remainingWork: ['continue'],
    };

    const nextState = await autoCompactResumeContext({
      projectDir,
      sessionId,
      bus,
      config: { workflow: workflowConfig(10), planner: apiPlannerConfig },
      state: createInitialState('resume'),
      planner: summarizingPlanner({
        summarizeStructured: async () => ({
          text: JSON.stringify(structured),
          structured,
          usage: { inputTokens: 500, outputTokens: 60 },
        }),
      }),
    });

    const file = join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE);
    const entries = readFileSync(file, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(entries.at(-1)).toMatchObject({
      kind: 'summary',
      text: JSON.stringify(structured),
      structured,
    });
    expect(events.find((event) => event.type === 'warning')).toBeUndefined();
    expect(nextState.tokenUsage.plannerInput).toBe(500);
    expect(nextState.tokenUsage.plannerOutput).toBe(60);
  });

  it('emits a warning when structured compaction falls back to freeform text', async () => {
    const originalEntries = Array.from({ length: 12 }, (_, index) => numberedMessageEntry(index));
    const { projectDir, sessionId } = setupSession(originalEntries);
    const { bus, events } = makeBusRecorder();

    await autoCompactResumeContext({
      projectDir,
      sessionId,
      bus,
      config: { workflow: workflowConfig(10), planner: apiPlannerConfig },
      state: createInitialState('resume'),
      planner: summarizingPlanner({
        summarizeStructured: async () => ({ text: 'not json', structured: null, usage: null }),
      }),
    });

    const warning = events.find((event) => event.type === 'warning');
    expect(warning && 'message' in warning ? warning.message : '').toMatch(/invalid JSON/i);
  });

  it('leaves the transcript untouched when the planner cannot summarize', async () => {
    const originalEntries = Array.from({ length: 12 }, (_, index) => numberedMessageEntry(index));
    const { projectDir, sessionId } = setupSession(originalEntries);
    const { bus } = makeBusRecorder();

    await autoCompactResumeContext({
      projectDir,
      sessionId,
      bus,
      config: { workflow: workflowConfig(10), planner: cliPlannerConfig },
      state: createInitialState('resume'),
      planner: summarizingPlanner({ supportsSelfSummarisation: false }),
    });

    const file = join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE);
    expect(readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(originalEntries.length);
  });
});

describe('createSessionExpiredHandler', () => {
  it('emits the "rebuilding context" warning and populates the resumeHolder from disk on invocation', async () => {
    const { projectDir, sessionId } = setupSession([
      messageEntry('user', 'first turn'),
      messageEntry('assistant', 'ack'),
    ]);
    const { bus, events } = makeBusRecorder();
    const resumeHolder: ResumeContextHolder = { messages: [] };

    const handler = createSessionExpiredHandler({
      projectDir,
      sessionId,
      bus,
      resumeHolder,
    });

    await handler();

    const warnings = events.filter((e) => e.type === 'warning');
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => 'message' in w && /rebuild/i.test(w.message))).toBe(true);
    expect(resumeHolder.messages).toEqual([
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'ack' },
    ]);
  });
});
