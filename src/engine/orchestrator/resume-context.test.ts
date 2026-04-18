import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { sessionDir, SESSION_LOG_FILE } from '../../core/paths.js';
import type { ResumeContextHolder } from './types.js';
import { applyRebuiltContext, createSessionExpiredHandler } from './resume-context.js';

function workflowConfig(persistTranscript: boolean) {
  return {
    autoApproveSpec: false,
    autoApprovePlan: false,
    maxRetries: 3,
    commitStrategy: 'none' as const,
    persistTranscript,
  };
}

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

describe('applyRebuiltContext', () => {
  it('populates the resume holder with user+assistant messages read from disk', async () => {
    const { projectDir, sessionId } = setupSession([
      messageEntry('user', 'add auth'),
      messageEntry('assistant', 'here is the spec'),
    ]);
    const { callbacks, events } = makeCallbacks();
    const resumeHolder: ResumeContextHolder = { messages: [] };

    await applyRebuiltContext({
      projectDir,
      sessionId,
      callbacks,
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
    const { callbacks, events } = makeCallbacks();
    const resumeHolder: ResumeContextHolder = {
      messages: [{ role: 'user', content: 'pre-existing' }],
    };

    await applyRebuiltContext({
      projectDir,
      sessionId,
      callbacks,
      config: { workflow: workflowConfig(false) },
      resumeHolder,
    });

    expect(resumeHolder.messages).toEqual([{ role: 'user', content: 'pre-existing' }]);
    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toBeDefined();
    expect(warning && 'message' in warning ? warning.message : '').toMatch(/expired|no transcript/i);
  });

  it('skips populating the holder when requireNonEmpty is set and no messages were rebuilt', async () => {
    const { projectDir, sessionId } = setupSession();
    const { callbacks, events } = makeCallbacks();
    const resumeHolder: ResumeContextHolder = { messages: [] };

    await applyRebuiltContext({
      projectDir,
      sessionId,
      callbacks,
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
    const resumeHolder: ResumeContextHolder = { messages: [] };

    await applyRebuiltContext({
      projectDir,
      sessionId,
      callbacks,
      config: { workflow: workflowConfig(true) },
      resumeHolder,
      requireNonEmpty: true,
    });

    expect(resumeHolder.messages).toEqual([{ role: 'user', content: 'keep me' }]);
  });

  it('tolerates a missing resumeHolder and still emits the fallback warning', async () => {
    const { projectDir, sessionId } = setupSession();
    const { callbacks, events } = makeCallbacks();

    await applyRebuiltContext({
      projectDir,
      sessionId,
      callbacks,
      config: { workflow: workflowConfig(false) },
      resumeHolder: undefined,
    });

    expect(events.some((e) => e.type === 'warning')).toBe(true);
  });
});

describe('createSessionExpiredHandler', () => {
  it('emits the "rebuilding context" warning and populates the resumeHolder from disk on invocation', async () => {
    const { projectDir, sessionId } = setupSession([
      messageEntry('user', 'first turn'),
      messageEntry('assistant', 'ack'),
    ]);
    const { callbacks, events } = makeCallbacks();
    const resumeHolder: ResumeContextHolder = { messages: [] };

    const handler = createSessionExpiredHandler({
      projectDir,
      sessionId,
      callbacks,
      config: { workflow: workflowConfig(true) },
      resumeHolder,
    });

    await handler();

    const warnings = events.filter((e) => e.type === 'warning');
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(
      warnings.some((w) => 'message' in w && /rebuild/i.test(w.message)),
    ).toBe(true);
    expect(resumeHolder.messages).toEqual([
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'ack' },
    ]);
  });
});
