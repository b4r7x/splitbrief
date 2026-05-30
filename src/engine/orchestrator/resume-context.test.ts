import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeCallbacks, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { sessionDir, SESSION_LOG_FILE } from '../../core/paths.js';
import type { ResumeContextHolder } from './types.js';
import {
  applyRebuiltContext,
  autoCompactResumeContext,
  createSessionExpiredHandler,
} from './resume-context.js';

function workflowConfig(persistTranscript: boolean, compactionThreshold?: number) {
  return {
    autoApproveSpec: false,
    autoApprovePlan: false,
    maxRetries: 3,
    commitStrategy: 'none' as const,
    persistTranscript,
    compactionFormat: 'auto' as const,
    ...(compactionThreshold !== undefined && { compactionThreshold }),
  };
}

const cliPlannerConfig = { kind: 'cli' as const, tool: 'claude-code' as const };
const apiPlannerConfig = {
  kind: 'api' as const,
  provider: 'ollama' as const,
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
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const resumeHolder: ResumeContextHolder = { messages: [] };

    await applyRebuiltContext({
      projectDir,
      sessionId,
      callbacks,
      bus,
      config: { workflow: workflowConfig(true) },
      resumeHolder,
    });

    expect(resumeHolder.messages).toEqual([
      { role: 'user', content: 'add auth' },
      { role: 'assistant', content: 'here is the spec' },
    ]);
    // No warning when transcript is present and non-empty.
    expect(events.find((e) => e.type === 'warning')).toBeUndefined();
  });

  it('emits the transcript-unavailable warning and leaves the resume holder untouched when persistTranscript is false', async () => {
    const { projectDir, sessionId } = setupSession();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const resumeHolder: ResumeContextHolder = {
      messages: [{ role: 'user', content: 'pre-existing' }],
    };

    await applyRebuiltContext({
      projectDir,
      sessionId,
      callbacks,
      bus,
      config: { workflow: workflowConfig(false) },
      resumeHolder,
    });

    expect(resumeHolder.messages).toEqual([{ role: 'user', content: 'pre-existing' }]);
    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toBeDefined();
    expect(warning && 'message' in warning ? warning.message : '').toMatch(
      /expired|no transcript/i,
    );
  });

  it('skips populating the holder when requireNonEmpty is set and no messages were rebuilt', async () => {
    const { projectDir, sessionId } = setupSession();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const resumeHolder: ResumeContextHolder = { messages: [] };

    await applyRebuiltContext({
      projectDir,
      sessionId,
      callbacks,
      bus,
      config: { workflow: workflowConfig(true) },
      resumeHolder,
      requireNonEmpty: true,
    });

    expect(resumeHolder.messages).toEqual([]);
    expect(events.find((e) => e.type === 'warning')).toBeUndefined();
  });

  it('populates the holder even on non-empty build when requireNonEmpty is set', async () => {
    const { projectDir, sessionId } = setupSession([messageEntry('user', 'keep me')]);
    const { callbacks } = makeCallbacks();
    const { bus } = makeBusRecorder();
    const resumeHolder: ResumeContextHolder = { messages: [] };

    await applyRebuiltContext({
      projectDir,
      sessionId,
      callbacks,
      bus,
      config: { workflow: workflowConfig(true) },
      resumeHolder,
      requireNonEmpty: true,
    });

    expect(resumeHolder.messages).toEqual([{ role: 'user', content: 'keep me' }]);
  });

  it('tolerates a missing resumeHolder and still emits the fallback warning', async () => {
    const { projectDir, sessionId } = setupSession();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();

    await applyRebuiltContext({
      projectDir,
      sessionId,
      callbacks,
      bus,
      config: { workflow: workflowConfig(false) },
      resumeHolder: undefined,
    });

    expect(events.some((e) => e.type === 'warning')).toBe(true);
  });
});

describe('autoCompactResumeContext', () => {
  it('summarizes older persisted messages when resume context exceeds the configured threshold', async () => {
    const originalEntries = Array.from({ length: 12 }, (_, index) => numberedMessageEntry(index));
    const { projectDir, sessionId } = setupSession(originalEntries);
    const { bus, events } = makeBusRecorder();
    const summarizedBatches: Array<Array<{ role: string; text: string }>> = [];

    await autoCompactResumeContext({
      projectDir,
      sessionId,
      bus,
      config: { workflow: workflowConfig(true, 10), planner: cliPlannerConfig },
      planner: {
        capabilities: {
          supportsConversationalPlanning: false,
          supportsHintEscalation: true,
          supportsSessionResume: false,
          supportsEffort: false,
          supportsImages: false,
          supportsSelfSummarisation: true,
        },
        summarize: async (messages) => {
          summarizedBatches.push(messages);
          return '## Summary\nCompacted older work';
        },
      },
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

    await autoCompactResumeContext({
      projectDir,
      sessionId,
      bus,
      config: { workflow: workflowConfig(true, 10), planner: apiPlannerConfig },
      planner: {
        capabilities: {
          supportsConversationalPlanning: false,
          supportsHintEscalation: true,
          supportsSessionResume: false,
          supportsEffort: false,
          supportsImages: false,
          supportsSelfSummarisation: true,
        },
        summarize: async () => {
          throw new Error('freeform summarization should not be used');
        },
        summarizeStructured: async () => ({ text: JSON.stringify(structured), structured }),
      },
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
  });

  it('emits a warning when structured compaction falls back to freeform text', async () => {
    const originalEntries = Array.from({ length: 12 }, (_, index) => numberedMessageEntry(index));
    const { projectDir, sessionId } = setupSession(originalEntries);
    const { bus, events } = makeBusRecorder();

    await autoCompactResumeContext({
      projectDir,
      sessionId,
      bus,
      config: { workflow: workflowConfig(true, 10), planner: apiPlannerConfig },
      planner: {
        capabilities: {
          supportsConversationalPlanning: false,
          supportsHintEscalation: true,
          supportsSessionResume: false,
          supportsEffort: false,
          supportsImages: false,
          supportsSelfSummarisation: true,
        },
        summarize: async () => {
          throw new Error('freeform summarization should not be used');
        },
        summarizeStructured: async () => ({ text: 'not json', structured: null }),
      },
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
      config: { workflow: workflowConfig(true, 10), planner: cliPlannerConfig },
      planner: {
        capabilities: {
          supportsConversationalPlanning: false,
          supportsHintEscalation: true,
          supportsSessionResume: false,
          supportsEffort: false,
          supportsImages: false,
          supportsSelfSummarisation: false,
        },
        summarize: async () => {
          throw new Error('should not be called');
        },
      },
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
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const resumeHolder: ResumeContextHolder = { messages: [] };

    const handler = createSessionExpiredHandler({
      projectDir,
      sessionId,
      callbacks,
      bus,
      config: { workflow: workflowConfig(true) },
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
