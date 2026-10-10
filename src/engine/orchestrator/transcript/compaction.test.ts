import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { sessionDir, SESSION_LOG_FILE } from '../../../core/paths.js';
import { compactResumeTranscript, keepRecentCountForThreshold } from './compaction.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import { attachedMessage } from '#testing/helpers/user-message.js';
import { createEventBus } from '../../events/bus.js';
import { recordSteer } from '../continuation.js';
import { buildResumeContext } from './rebuild.js';
import { drainQueue } from '../queue/drain.js';
import { findLatestSummary, readSessionLog } from '../../../core/sessions/log-reader.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('transcript-compaction-test');
  dirs.push(projectDir);
  const sessionId = 'sess-transcript';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function writeSessionLog(projectDir: string, sessionId: string, entries: unknown[]): void {
  const filePath = join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE);
  writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

describe('keepRecentCountForThreshold', () => {
  it('returns threshold minus one for typical values', () => {
    expect(keepRecentCountForThreshold(10)).toBe(9);
    expect(keepRecentCountForThreshold(20)).toBe(19);
  });

  it('clamps to at least 1', () => {
    expect(keepRecentCountForThreshold(1)).toBe(1);
    expect(keepRecentCountForThreshold(0)).toBe(1);
  });
});

describe('compactResumeTranscript', () => {
  it.each(['freeform', 'structured'] as const)(
    'keeps pending attachments outside the %s summary until delivery',
    async (format) => {
      const ref = setupProject();
      const message = attachedMessage(ref.projectDir);
      const queuedAt = '3000';
      const structured = {
        goal: 'Earlier work',
        stepsCompleted: [],
        currentStep: 'planning',
        filesModified: [],
        constraintsDiscovered: [],
        remainingWork: [],
      };
      const state = {
        ...createInitialState('feature'),
        phase: 'planning' as const,
        messageQueue: [
          {
            id: 'pending',
            ...message,
            queuedAt,
            phase: 'planning' as const,
            deliveredViaNative: false,
            nativeDeliveryState: 'pending' as const,
          },
        ],
      };
      saveState(ref, state);
      writeSessionLog(ref.projectDir, ref.sessionId, [
        { kind: 'message', ts: 1000, role: 'user', phase: 'planning', text: 'old request' },
        {
          kind: 'summary',
          ts: 2000,
          text: 'Earlier work',
          summarizedUpTo: 1000,
          summarizedCount: 1,
          ...(format === 'structured' && { structured }),
        },
        { kind: 'message', ts: 2500, role: 'assistant', phase: 'planning', text: 'before queue' },
        {
          kind: 'message',
          ts: queuedAt,
          role: 'user',
          phase: 'planning',
          text: message.displayText,
          queuedAt,
          queueMessageId: 'pending',
        },
        { kind: 'message', ts: 4000, role: 'assistant', phase: 'planning', text: 'after queue' },
        { kind: 'message', ts: 5000, role: 'user', phase: 'planning', text: 'recent request' },
      ]);
      const result = await compactResumeTranscript({
        ...ref,
        keepRecentCount: 1,
        format,
        planner: {
          summarize: async (messages) => {
            expect(messages).toEqual([
              { role: 'user', text: 'Earlier work' },
              { role: 'assistant', text: 'before queue' },
            ]);
            return { text: 'Before queue summarized', usage: null };
          },
          summarizeStructured: async (messages, opts) => {
            expect(messages).toEqual([{ role: 'assistant', text: 'before queue' }]);
            expect(opts?.previousSummary).toEqual(structured);
            return {
              text: 'Before queue summarized',
              structured: { ...structured, goal: 'Before queue summarized' },
              usage: null,
            };
          },
        },
      });
      expect(result.entriesRemoved).toBe(format === 'structured' ? 1 : 2);
      const log = [];
      for await (const entry of readSessionLog(ref)) log.push(entry);
      expect(findLatestSummary(log)).toMatchObject({
        summarizedUpTo: '2500',
        summarizedCount: 2,
      });
      const beforeDelivery = await buildResumeContext({ ref });
      expect(JSON.stringify(beforeDelivery.messages)).not.toContain('PELICAN-42');
      expect(beforeDelivery.messages.slice(-2)).toEqual([
        { role: 'assistant', content: 'after queue' },
        { role: 'user', content: 'recent request' },
      ]);
      drainQueue({ ...ref, state, bus: createEventBus() });
      const rebuilt = await buildResumeContext({ ref });
      expect(rebuilt.messages.slice(1)).toEqual([
        { role: 'user', content: message.text },
        { role: 'assistant', content: 'after queue' },
        { role: 'user', content: 'recent request' },
      ]);
      expect(
        rebuilt.messages
          .map((entry) => entry.content)
          .join('\n')
          .split('PELICAN-42'),
      ).toHaveLength(2);
    },
  );

  it.each([true, false])(
    'does not compact across the first pending entry with a queue ID: %s',
    async (withQueueId) => {
      const ref = setupProject();
      const message = attachedMessage(ref.projectDir);
      const queuedAt = '1000';
      const state = {
        ...createInitialState('feature'),
        phase: 'planning' as const,
        messageQueue: [
          {
            id: 'pending',
            ...message,
            queuedAt,
            phase: 'planning' as const,
            deliveredViaNative: false,
            nativeDeliveryState: 'pending' as const,
          },
        ],
      };
      saveState(ref, state);
      writeSessionLog(ref.projectDir, ref.sessionId, [
        {
          kind: 'message',
          ts: queuedAt,
          role: 'user',
          phase: 'planning',
          text: message.displayText,
          queuedAt,
          ...(withQueueId && { queueMessageId: 'pending' }),
        },
        { kind: 'message', ts: 1001, role: 'assistant', phase: 'planning', text: 'working' },
      ]);
      const result = await compactResumeTranscript({
        ...ref,
        keepRecentCount: 0,
        planner: {
          summarize: async () => {
            throw new Error('pending entry must prevent compaction');
          },
        },
      });
      expect(result).toEqual({ summary: '', entriesRemoved: 0, usage: null });
      expect((await buildResumeContext({ ref })).messages).toEqual([
        { role: 'assistant', content: 'working' },
      ]);
    },
  );

  it('expands an attachment after a structured summary without resummarizing earlier raw text', async () => {
    const ref = setupProject();
    const message = attachedMessage(ref.projectDir);
    const structured = {
      goal: 'Earlier work',
      stepsCompleted: [],
      currentStep: 'planning',
      filesModified: [],
      constraintsDiscovered: [],
      remainingWork: [],
    };
    saveState(ref, {
      ...createInitialState('feature'),
      phase: 'planning',
      resumeUserMessages: [
        { ts: '3000', phase: 'planning', displayText: message.displayText, text: message.text },
      ],
    });
    writeSessionLog(ref.projectDir, ref.sessionId, [
      { kind: 'message', ts: 1000, role: 'user', phase: 'planning', text: 'old compact reference' },
      {
        kind: 'summary',
        ts: 2000,
        text: JSON.stringify(structured),
        structured,
        summarizedUpTo: 1000,
        summarizedCount: 1,
      },
      { kind: 'message', ts: 3000, role: 'user', phase: 'planning', text: message.displayText },
      { kind: 'message', ts: 4000, role: 'assistant', phase: 'planning', text: 'recent reply' },
    ]);
    await compactResumeTranscript({
      ...ref,
      keepRecentCount: 1,
      format: 'structured',
      planner: {
        summarize: async () => {
          throw new Error('structured summary expected');
        },
        summarizeStructured: async (messages, opts) => {
          expect(messages).toEqual([{ role: 'user', text: message.text }]);
          expect(opts?.previousSummary).toEqual(structured);
          return {
            text: 'PELICAN-42 summarized',
            structured: { ...structured, goal: 'PELICAN-42 summarized' },
            usage: null,
          };
        },
      },
    });
    expect(loadState(ref)?.resumeUserMessages).toEqual([]);
    expect((await buildResumeContext({ ref })).messages).toEqual([
      { role: 'user', content: JSON.stringify({ ...structured, goal: 'PELICAN-42 summarized' }) },
      { role: 'assistant', content: 'recent reply' },
    ]);
  });

  it('matches identical references at one timestamp before selecting the summary input', async () => {
    const ref = setupProject();
    const message = attachedMessage(ref.projectDir);
    const ts = '2026-10-10T00:00:00.000Z';
    const later = { ...message, text: message.text.replace('PELICAN-42', 'HERON-73') };
    saveState(ref, {
      ...createInitialState('feature'),
      phase: 'planning',
      resumeUserMessages: [
        { ts, phase: 'planning', displayText: message.displayText, text: message.text },
        { ts, phase: 'planning', displayText: later.displayText, text: later.text },
      ],
    });
    writeSessionLog(ref.projectDir, ref.sessionId, [
      { kind: 'message', ts, role: 'user', phase: 'planning', text: message.displayText },
      { kind: 'message', ts, role: 'user', phase: 'planning', text: later.displayText },
    ]);
    await compactResumeTranscript({
      ...ref,
      keepRecentCount: 1,
      planner: {
        summarize: async (messages) => {
          expect(messages).toEqual([{ role: 'user', text: message.text }]);
          return { text: 'PELICAN-42 summarized', usage: null };
        },
      },
    });
    expect(loadState(ref)?.resumeUserMessages).toEqual([
      { ts, phase: 'planning', displayText: later.displayText, text: later.text },
    ]);
    expect((await buildResumeContext({ ref })).messages).toEqual([
      { role: 'user', content: 'PELICAN-42 summarized' },
      { role: 'user', content: later.text },
    ]);
  });

  it.each(['native', 'prompt', 'steer', 'answer'] as const)(
    'summarizes the expanded %s attachment and prunes only summarized records',
    async (delivery) => {
      const ref = setupProject();
      const message = attachedMessage(ref.projectDir);
      const ts = '2026-10-10T00:00:00.000Z';
      saveState(ref, {
        ...createInitialState('feature'),
        phase: 'planning',
        ...(delivery === 'native' || delivery === 'prompt'
          ? {
              messageQueue: [
                {
                  id: 'delivered',
                  ...message,
                  queuedAt: ts,
                  phase: 'planning',
                  deliveredViaNative: delivery === 'native',
                  nativeDeliveryState: delivery === 'native' ? 'delivered' : 'pending',
                  ...(delivery === 'prompt' && { drainedAt: ts }),
                },
              ],
            }
          : {
              resumeUserMessages: [
                {
                  ts,
                  phase: 'planning',
                  displayText: message.displayText,
                  ...(delivery === 'answer' ? { answerIndex: 0 } : { text: message.text }),
                },
              ],
              ...(delivery === 'answer' && {
                userAnswers: [{ reply: 'Which file?', answer: message.text }],
              }),
            }),
      });
      writeSessionLog(ref.projectDir, ref.sessionId, [
        {
          kind: 'message',
          ts,
          role: 'user',
          phase: 'planning',
          text: message.displayText,
          ...((delivery === 'native' || delivery === 'prompt') && { queueMessageId: 'delivered' }),
        },
        {
          kind: 'message',
          ts: '2026-10-10T00:00:01.000Z',
          role: 'assistant',
          phase: 'planning',
          text: 'heard',
        },
      ]);
      const later = { ...message, text: message.text.replace('PELICAN-42', 'HERON-73') };
      recordSteer({ ...ref, bus: createEventBus() }, 'planning', later);
      recordSteer(
        { ...ref, bus: createEventBus() },
        'planning',
        plainUserMessage('plain follow-up'),
      );
      const result = await compactResumeTranscript({
        ...ref,
        keepRecentCount: 2,
        planner: {
          summarize: async (messages) => {
            expect(messages).toEqual([
              { role: 'user', text: message.text },
              { role: 'assistant', text: 'heard' },
            ]);
            return { text: 'PELICAN-42 summarized', usage: null };
          },
        },
      });
      expect(result.entriesRemoved).toBe(2);
      const saved = loadState(ref)?.resumeUserMessages;
      expect(saved).toHaveLength(1);
      expect(saved?.[0]).toMatchObject({ text: later.text });
      expect((await buildResumeContext({ ref })).messages).toEqual([
        { role: 'user', content: 'PELICAN-42 summarized' },
        { role: 'user', content: later.text },
        { role: 'user', content: 'plain follow-up' },
      ]);
      await compactResumeTranscript({
        ...ref,
        keepRecentCount: 1,
        planner: {
          summarize: async (messages) => {
            expect(messages).toEqual([
              { role: 'user', text: 'PELICAN-42 summarized' },
              { role: 'user', text: later.text },
            ]);
            return { text: 'PELICAN-42 and HERON-73 summarized', usage: null };
          },
        },
      });
      expect(loadState(ref)?.resumeUserMessages).toEqual([]);
    },
  );

  it('surfaces the planner usage from the summarization call', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSessionLog(projectDir, sessionId, [
      { kind: 'message', ts: 1000, role: 'user', phase: 'planning', text: 'first' },
      { kind: 'message', ts: 1001, role: 'assistant', phase: 'planning', text: 'second' },
      { kind: 'message', ts: 1002, role: 'user', phase: 'planning', text: 'third' },
    ]);

    const result = await compactResumeTranscript({
      projectDir,
      sessionId,
      keepRecentCount: 1,
      planner: {
        summarize: async () => ({
          text: '## Summary',
          usage: { inputTokens: 1200, outputTokens: 90 },
        }),
      },
    });

    expect(result.summary).toBe('## Summary');
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 90 });
  });

  it('returns null usage when nothing needs summarizing', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSessionLog(projectDir, sessionId, [
      { kind: 'message', ts: 1000, role: 'user', phase: 'planning', text: 'only message' },
    ]);

    const result = await compactResumeTranscript({
      projectDir,
      sessionId,
      keepRecentCount: 10,
      planner: {
        summarize: async () => {
          throw new Error('should not summarize');
        },
      },
    });

    expect(result.entriesRemoved).toBe(0);
    expect(result.usage).toBeNull();
  });
});
