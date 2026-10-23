import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { sessionDir, SESSION_LOG_FILE } from '../../../core/paths.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { createInitialState } from '../../../core/state/machine.js';
import { plainUserMessage, type UserMessageInput } from '../../../core/types/user-input.js';
import { buildResumeContext } from './rebuild.js';
import { attachedMessage } from '#testing/helpers/user-message.js';
import { createEventBus } from '../../events/bus.js';
import { recordSteer } from '../continuation.js';
import { transitionAndSave } from '../state-ops.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import { readRunEvents } from '../../events/replay.js';
import { enqueueUserMessage } from '../queue/submit.js';
import { recordUserMessage } from './user-message.js';
import { readMessages } from '../../../core/sessions/log-reader.js';
import {
  SESSION_LOG_MAX_ENTRY_BYTES,
  SESSION_LOG_MAX_STRING_BYTES,
} from '../../../core/schemas/session-log.js';
import { CALL_CONSUMER_STRING_TRUNCATION_PLACEHOLDER } from '../../../core/payload-bounds.js';
import type { SessionRef } from '../../../core/types/session-ref.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('transcript-rebuild-test');
  dirs.push(projectDir);
  const sessionId = 'sess-transcript';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function writeSessionLog(projectDir: string, sessionId: string, entries: unknown[]): void {
  const filePath = join(sessionDir(projectDir, sessionId), SESSION_LOG_FILE);
  writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

describe('buildResumeContext', () => {
  it('reports a missing saved attachment answer as a typed error', async () => {
    const ref = setupProject();
    const ts = '2026-10-10T00:00:00.000Z';
    saveState(ref, {
      ...createInitialState('feature'),
      phase: 'planning',
      resumeUserMessages: [{ ts, phase: 'planning', displayText: '@notes.md', answerIndex: 0 }],
    });
    writeSessionLog(ref.projectDir, ref.sessionId, [
      { kind: 'message', ts, role: 'user', phase: 'planning', text: '@notes.md' },
    ]);
    await expect(buildResumeContext({ ref })).rejects.toMatchObject({
      kind: 'transcript-missing-attachment-answer',
      message: 'Saved attachment answer is missing.',
      data: { answerIndex: 0 },
    });
  });

  it.each(['native', 'prompt'] as const)(
    'restores a delivered %s attachment by queueMessageId after compaction',
    async (delivery) => {
      const ref = setupProject();
      const message = attachedMessage(ref.projectDir);
      const queuedAt = '2026-10-10T00:00:03.000Z';
      saveState(ref, {
        ...createInitialState('feature'),
        phase: 'planning',
        messageQueue: [
          {
            id: 'delivered',
            ...message,
            queuedAt,
            phase: 'planning',
            deliveredViaNative: delivery === 'native',
            nativeDeliveryState: delivery === 'native' ? 'delivered' : 'pending',
            ...(delivery === 'prompt' && { drainedAt: queuedAt }),
          },
        ],
      });
      writeSessionLog(ref.projectDir, ref.sessionId, [
        { kind: 'message', ts: 1000, role: 'user', text: 'old request' },
        { kind: 'summary', ts: 2000, text: 'Earlier work', summarizedUpTo: 1000 },
        {
          kind: 'message',
          ts: queuedAt,
          role: 'user',
          phase: 'planning',
          text: message.displayText,
          queuedAt,
          queueMessageId: 'delivered',
        },
        {
          kind: 'message',
          ts: queuedAt,
          role: 'assistant',
          phase: 'planning',
          text: message.displayText,
          queueMessageId: 'delivered',
        },
      ]);

      expect((await buildResumeContext({ ref })).messages).toEqual([
        { role: 'user', content: 'Earlier work' },
        { role: 'user', content: message.text },
        { role: 'assistant', content: message.displayText },
      ]);
    },
  );

  it('excludes a pending attachment whose compact text differs from its queue text', async () => {
    const ref = setupProject();
    const message = attachedMessage(ref.projectDir);
    const queuedAt = '2026-10-10T00:00:03.000Z';
    saveState(ref, {
      ...createInitialState('feature'),
      phase: 'planning',
      messageQueue: [
        {
          id: 'pending',
          ...message,
          queuedAt,
          phase: 'planning',
          deliveredViaNative: false,
          nativeDeliveryState: 'pending',
        },
      ],
    });
    writeSessionLog(ref.projectDir, ref.sessionId, [
      {
        kind: 'message',
        ts: queuedAt,
        role: 'user',
        phase: 'planning',
        text: message.displayText,
        queuedAt,
        queueMessageId: 'pending',
      },
      {
        kind: 'message',
        ts: queuedAt,
        role: 'user',
        phase: 'planning',
        text: message.displayText,
        queuedAt,
      },
    ]);
    expect((await buildResumeContext({ ref })).messages).toEqual([]);
  });

  it('keeps each steer body when the same reference is submitted again and the file changes', async () => {
    const ref = setupProject();
    saveState(ref, { ...createInitialState('feature'), phase: 'planning' });
    const message = attachedMessage(ref.projectDir);
    const nextMessage = { ...message, text: message.text.replace('PELICAN-42', 'HERON-73') };
    const ctx = { ...ref, bus: createEventBus() };
    recordSteer(ctx, 'planning', message);
    recordSteer(ctx, 'planning', nextMessage);
    writeFileSync(message.attachedInputs[0]?.path ?? '', 'CHANGED ON DISK');

    expect((await buildResumeContext({ ref })).messages).toEqual([
      { role: 'user', content: message.text },
      { role: 'user', content: nextMessage.text },
    ]);
  });

  it('keeps a recorded steer body through a transition from an older in-memory state', async () => {
    const ref = setupProject();
    const state = { ...createInitialState('feature'), phase: 'planning' as const };
    saveState(ref, state);
    const message = attachedMessage(ref.projectDir);
    recordSteer({ ...ref, bus: createEventBus() }, state.phase, message);
    transitionAndSave(ref, state, { type: 'SET_PLANNER_SESSION_ID', sessionId: 'new-native' });

    expect((await buildResumeContext({ ref })).messages).toEqual([
      { role: 'user', content: message.text },
    ]);
  });

  it('restores the later body when compaction cuts identical references at the same timestamp', async () => {
    const ref = setupProject();
    const message = attachedMessage(ref.projectDir);
    const ts = '2026-10-10T00:00:00.000Z';
    const nextText = message.text.replace('PELICAN-42', 'HERON-73');
    saveState(ref, {
      ...createInitialState('feature'),
      phase: 'planning',
      resumeUserMessages: [
        { ts, phase: 'planning', displayText: message.displayText, text: message.text },
        { ts, phase: 'planning', displayText: message.displayText, text: nextText },
      ],
    });
    writeSessionLog(ref.projectDir, ref.sessionId, [
      { kind: 'message', ts, role: 'user', phase: 'planning', text: message.displayText },
      {
        kind: 'summary',
        ts: '2026-10-10T00:00:01.000Z',
        text: 'Earlier work',
        summarizedUpTo: ts,
        summarizedCount: 1,
      },
      { kind: 'message', ts, role: 'user', phase: 'planning', text: message.displayText },
    ]);
    expect((await buildResumeContext({ ref })).messages).toEqual([
      { role: 'user', content: 'Earlier work' },
      { role: 'user', content: nextText },
    ]);
  });

  it('collects messages from the real session log on disk', async () => {
    const { projectDir, sessionId } = setupProject();
    const now = new Date().toISOString();
    writeSessionLog(projectDir, sessionId, [
      { kind: 'message', ts: now, role: 'user', phase: 'planning', text: 'hello' },
      { kind: 'message', ts: now, role: 'assistant', phase: 'planning', text: 'hi there' },
      { kind: 'event', ts: now, type: 'workflow_started', phase: 'idle', data: {} },
    ]);

    const result = await buildResumeContext({ ref: { projectDir, sessionId } });
    expect(result.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    expect(result.warning).toBeUndefined();
  });

  it("rebuilds the planner conversation without the implementer's output", async () => {
    const { projectDir, sessionId } = setupProject();
    const now = new Date().toISOString();
    writeSessionLog(projectDir, sessionId, [
      { kind: 'message', ts: now, role: 'user', phase: 'planning', text: 'which module?' },
      { kind: 'message', ts: now, role: 'assistant', phase: 'planning', text: 'The export one.' },
      {
        kind: 'message',
        ts: now,
        role: 'assistant',
        phase: 'implementing',
        text: 'Wrote src/a.ts',
      },
      { kind: 'message', ts: now, role: 'user', phase: 'implementing', text: 'keep it small' },
    ]);

    const result = await buildResumeContext({ ref: { projectDir, sessionId } });

    expect(result.messages).toEqual([
      { role: 'user', content: 'which module?' },
      { role: 'assistant', content: 'The export one.' },
      { role: 'user', content: 'keep it small' },
    ]);
  });

  it('rebuilds compacted sessions from the latest summary plus later messages', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSessionLog(projectDir, sessionId, [
      { kind: 'message', ts: 1000, role: 'user', phase: 'planning', text: 'old request' },
      { kind: 'message', ts: 1001, role: 'assistant', phase: 'planning', text: 'old answer' },
      { kind: 'summary', ts: 2000, text: '## Summary\nOld work preserved', summarizedUpTo: 1001 },
      { kind: 'message', ts: 2001, role: 'user', phase: 'planning', text: 'new request' },
      { kind: 'message', ts: 2002, role: 'assistant', phase: 'planning', text: 'new answer' },
    ]);

    const result = await buildResumeContext({ ref: { projectDir, sessionId } });

    expect(result.messages).toEqual([
      { role: 'user', content: '## Summary\nOld work preserved' },
      { role: 'user', content: 'new request' },
      { role: 'assistant', content: 'new answer' },
    ]);
  });

  it('returns empty array with no warning when no session log exists and persist is true', async () => {
    const { projectDir, sessionId } = setupProject();
    const result = await buildResumeContext({ ref: { projectDir, sessionId } });
    expect(result.messages).toEqual([]);
    expect(result.warning).toBeUndefined();
  });

  it('annotates a cut-off assistant turn so the planner is not re-fed a partial turn as complete', async () => {
    const { projectDir, sessionId } = setupProject();
    const now = new Date().toISOString();
    writeSessionLog(projectDir, sessionId, [
      { kind: 'message', ts: now, role: 'user', phase: 'planning', text: 'do the thing' },
      {
        kind: 'message',
        ts: now,
        role: 'assistant',
        phase: 'planning',
        text: 'I will start by',
        interrupted: true,
      },
    ]);

    const result = await buildResumeContext({ ref: { projectDir, sessionId } });

    expect(result.messages).toEqual([
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: 'I will start by\n\n[turn interrupted]' },
    ]);
  });

  it('annotates a cut-off assistant turn that survives compaction as a kept recent message', async () => {
    const { projectDir, sessionId } = setupProject();
    writeSessionLog(projectDir, sessionId, [
      { kind: 'message', ts: 1000, role: 'user', phase: 'planning', text: 'old request' },
      { kind: 'message', ts: 1001, role: 'assistant', phase: 'planning', text: 'old answer' },
      { kind: 'summary', ts: 2000, text: '## Summary\nOld work preserved', summarizedUpTo: 1001 },
      { kind: 'message', ts: 2001, role: 'user', phase: 'planning', text: 'new request' },
      {
        kind: 'message',
        ts: 2002,
        role: 'assistant',
        phase: 'planning',
        text: 'partial new answer',
        interrupted: true,
      },
    ]);

    const result = await buildResumeContext({ ref: { projectDir, sessionId } });

    expect(result.messages).toEqual([
      { role: 'user', content: '## Summary\nOld work preserved' },
      { role: 'user', content: 'new request' },
      { role: 'assistant', content: 'partial new answer\n\n[turn interrupted]' },
    ]);
  });

  it('excludes still-pending queued user messages so resume drains them only once', async () => {
    const { projectDir, sessionId } = setupProject();
    const queuedAt = new Date().toISOString();
    const state = {
      ...createInitialState('feature'),
      phase: 'planning' as const,
      messageQueue: [
        {
          id: 'msg-pending',
          ...plainUserMessage('still queued'),
          queuedAt,
          phase: 'planning' as const,
          deliveredViaNative: false,
          nativeDeliveryState: 'pending' as const,
        },
      ],
    };
    saveState({ projectDir, sessionId }, state);
    writeSessionLog(projectDir, sessionId, [
      {
        kind: 'message',
        ts: queuedAt,
        role: 'user',
        phase: 'planning',
        text: 'still queued',
        queuedAt,
        queueMessageId: 'msg-pending',
      },
      { kind: 'message', ts: queuedAt, role: 'assistant', phase: 'planning', text: 'working' },
    ]);

    const result = await buildResumeContext({ ref: { projectDir, sessionId } });

    expect(result.messages).toEqual([{ role: 'assistant', content: 'working' }]);
  });

  it('filters pending queued messages from compacted resume without replaying summarized raw turns', async () => {
    const { projectDir, sessionId } = setupProject();
    const queuedAt = '2026-01-01T00:00:03.000Z';
    saveState(
      { projectDir, sessionId },
      {
        ...createInitialState('feature'),
        phase: 'planning' as const,
        messageQueue: [
          {
            id: 'msg-pending',
            ...plainUserMessage('pending queued after summary'),
            queuedAt,
            phase: 'planning' as const,
            deliveredViaNative: false,
            nativeDeliveryState: 'pending' as const,
          },
        ],
      },
    );
    writeSessionLog(projectDir, sessionId, [
      { kind: 'message', ts: 1000, role: 'user', phase: 'planning', text: 'old request' },
      { kind: 'message', ts: 1001, role: 'assistant', phase: 'planning', text: 'old answer' },
      { kind: 'summary', ts: 2000, text: '## Summary\nOld work preserved', summarizedUpTo: 1001 },
      {
        kind: 'message',
        ts: queuedAt,
        role: 'user',
        phase: 'planning',
        text: 'pending queued after summary',
        queuedAt,
        queueMessageId: 'msg-pending',
      },
      { kind: 'message', ts: 3000, role: 'assistant', phase: 'planning', text: 'later answer' },
      { kind: 'message', ts: 3001, role: 'user', phase: 'planning', text: 'later request' },
    ]);

    const result = await buildResumeContext({ ref: { projectDir, sessionId } });

    expect(result.messages).toEqual([
      { role: 'user', content: '## Summary\nOld work preserved' },
      { role: 'assistant', content: 'later answer' },
      { role: 'user', content: 'later request' },
    ]);
  });
});

describe('a user message over the session log limit', () => {
  const big = 'LOG-LINE 42 failed\n'.repeat(Math.ceil((SESSION_LOG_MAX_ENTRY_BYTES + 1) / 19));

  function startPlanning(): SessionRef {
    const ref = setupProject();
    saveState(ref, { ...createInitialState('feature'), phase: 'planning' });
    return ref;
  }

  function capture<T>(act: () => T): { value: T; stderr: string } {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      return { value: act(), stderr: chunks.join('') };
    } finally {
      spy.mockRestore();
    }
  }

  async function loggedUserTexts(ref: SessionRef): Promise<string[]> {
    const texts: string[] = [];
    for await (const entry of readMessages(ref)) if (entry.role === 'user') texts.push(entry.text);
    return texts;
  }

  function expectBounded(text: string | undefined): void {
    expect(text?.endsWith(CALL_CONSUMER_STRING_TRUNCATION_PLACEHOLDER)).toBe(true);
    expect(Buffer.byteLength(text ?? '', 'utf8')).toBeLessThanOrEqual(SESSION_LOG_MAX_STRING_BYTES);
  }

  function liveBus(ref: SessionRef) {
    const bus = createEventBus();
    bus.subscribe(createJsonlSink(ref));
    return bus;
  }

  it('a steer is logged bounded, reopens as one row and resumes with the whole text', async () => {
    const ref = startPlanning();
    const { stderr } = capture(() =>
      recordSteer({ ...ref, bus: liveBus(ref) }, 'planning', plainUserMessage(big)),
    );

    expect(stderr).toBe('');
    const logged = await loggedUserTexts(ref);
    expect(logged).toHaveLength(1);
    expectBounded(logged[0]);
    const rows = (await readRunEvents(ref)).events.filter((event) => event.type === 'user_message');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: logged[0] });
    expect((await buildResumeContext({ ref })).messages).toEqual([{ role: 'user', content: big }]);
  });

  it('a steer between the string limit and the entry limit reopens as one row', async () => {
    const ref = startPlanning();
    const text = 'y'.repeat(SESSION_LOG_MAX_STRING_BYTES + 1);
    recordSteer({ ...ref, bus: liveBus(ref) }, 'planning', plainUserMessage(text));

    const rows = (await readRunEvents(ref)).events.filter((event) => event.type === 'user_message');
    expect(rows).toHaveLength(1);
    expect((await buildResumeContext({ ref })).messages).toEqual([{ role: 'user', content: text }]);
  });

  it('a steer with a key reopens as one row, keeps no raw key in the log and resumes with the whole text', async () => {
    const ref = startPlanning();
    const key = `sk-ant-api03-${'A'.repeat(90)}`;
    const text = `use ${key} please`;
    recordSteer({ ...ref, bus: liveBus(ref) }, 'planning', plainUserMessage(text));

    const rows = (await readRunEvents(ref)).events.filter((event) => event.type === 'user_message');
    expect(rows).toHaveLength(1);
    expect(
      readFileSync(join(sessionDir(ref.projectDir, ref.sessionId), SESSION_LOG_FILE), 'utf8'),
    ).not.toContain(key);
    expect((await buildResumeContext({ ref })).messages).toEqual([{ role: 'user', content: text }]);
  });

  it('a queued message is logged bounded and resumes with the whole text once delivered', async () => {
    const ref = startPlanning();
    const state = loadState(ref);
    if (state === null) throw new Error('expected the saved state');
    const { value: queued, stderr } = capture(() =>
      enqueueUserMessage({
        ...ref,
        state,
        message: plainUserMessage(big),
        phase: 'planning',
        bus: liveBus(ref),
      }),
    );
    const id = queued.message?.id ?? '';
    transitionAndSave(ref, queued.state, { type: 'MARK_DELIVERED_NATIVE', id });

    expect(stderr).toBe('');
    expectBounded((await loggedUserTexts(ref))[0]);
    expect((await buildResumeContext({ ref })).messages).toEqual([{ role: 'user', content: big }]);
  });

  it('an answer to a planner question is logged bounded and resumes with the whole answer', async () => {
    const ref = startPlanning();
    saveState(ref, {
      ...createInitialState('feature'),
      phase: 'planning',
      userAnswers: [{ reply: 'Which log?', answer: big }],
    });
    const { stderr } = capture(() =>
      recordUserMessage({ ...ref, bus: liveBus(ref), phase: 'planning' }, plainUserMessage(big), {
        qa: [{ question: 'Which log?', answer: big }],
        answerIndex: 0,
      }),
    );

    expect(stderr).toBe('');
    expectBounded((await loggedUserTexts(ref))[0]);
    expect((await buildResumeContext({ ref })).messages).toEqual([{ role: 'user', content: big }]);
  });

  it('a message with an @file and a large typed part keeps both its display and its planner text', async () => {
    const ref = startPlanning();
    const attached = attachedMessage(ref.projectDir);
    const message: UserMessageInput = {
      ...attached,
      displayText: `${big}${attached.displayText}`,
      text: `${big}${attached.text}`,
    };
    const { stderr } = capture(() =>
      recordSteer({ ...ref, bus: liveBus(ref) }, 'planning', message),
    );

    expect(stderr).toBe('');
    const logged = await loggedUserTexts(ref);
    expectBounded(logged[0]);
    expect(logged[0]).not.toContain('PELICAN-42');
    const rows = (await readRunEvents(ref)).events.filter((event) => event.type === 'user_message');
    expect(rows).toHaveLength(1);
    expect((await buildResumeContext({ ref })).messages).toEqual([
      { role: 'user', content: message.text },
    ]);
  });
});
