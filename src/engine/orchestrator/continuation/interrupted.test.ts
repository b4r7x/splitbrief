import { afterEach, describe, expect, it } from 'vitest';
import { dirs, setupProjectDir } from '#testing/helpers/continuation.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { appendEngineEvent, appendMessage } from '../../../core/sessions/log/writer.js';
import { createTranscriptBuffer } from '../../streaming/transcript-buffer.js';
import { readInterruptedPartial } from './interrupted.js';

afterEach(() => {
  for (const d of dirs.splice(0)) cleanupTempDir(d);
});

describe('readInterruptedPartial', () => {
  it('returns the last interrupted flush and ignores completed messages', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const ref = { projectDir, sessionId };
    const started = (callId: string) =>
      appendEngineEvent(ref, {
        type: 'runner_call_started',
        ts: Date.now(),
        phase: 'implementing',
        callId,
        role: 'implementer',
      });
    started('old');
    appendMessage(ref, { role: 'assistant', text: 'an older cut', interrupted: true });
    started('finished');
    appendMessage(ref, { role: 'assistant', text: 'a finished call' });
    started('cut');
    appendMessage(ref, { role: 'assistant', text: 'the cut attempt', interrupted: true });

    expect(await readInterruptedPartial(ref)).toBe('the cut attempt');
  });

  it('is absent when nothing was ever cut', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    appendMessage({ projectDir, sessionId }, { role: 'assistant', text: 'a finished call' });

    expect(await readInterruptedPartial({ projectDir, sessionId })).toBeUndefined();
  });

  it('leaves a cut with its own call: a call started after it was cut before any output', async () => {
    const { projectDir, sessionId } = setupProjectDir();
    const ref = { projectDir, sessionId };
    const callStarted = (callId: string) => ({
      type: 'runner_call_started',
      ts: Date.now(),
      phase: 'implementing',
      callId,
      role: 'implementer',
    });
    appendEngineEvent(ref, callStarted('implementer-1'));
    appendMessage(ref, { role: 'assistant', text: 'T001 wrote half', interrupted: true });

    expect(await readInterruptedPartial(ref)).toBe('T001 wrote half');

    appendEngineEvent(ref, callStarted('implementer-2'));

    expect(await readInterruptedPartial(ref)).toBeUndefined();
  });

  it('reconstructs a bounded tail across flushed chunks and an empty final marker', async () => {
    const ref = setupProjectDir();
    appendEngineEvent(ref, {
      type: 'runner_call_started',
      ts: Date.now(),
      phase: 'implementing',
      callId: 'cut-call',
      role: 'implementer',
    });
    const buffer = createTranscriptBuffer({ ...ref, phase: 'implementing' });
    buffer.append('A'.repeat(16 * 1024 + 1));
    buffer.append('TAIL');
    buffer.flushInterrupted();

    expect(await readInterruptedPartial(ref)).toBe(`…${'A'.repeat(7_995)}TAIL`);

    appendEngineEvent(ref, {
      type: 'runner_call_started',
      ts: Date.now(),
      phase: 'implementing',
      callId: 'next-call',
      role: 'implementer',
    });
    expect(await readInterruptedPartial(ref)).toBeUndefined();
  });

  it('recognizes a cut before the first text as an empty partial', async () => {
    const ref = setupProjectDir();
    const buffer = createTranscriptBuffer({ ...ref, phase: 'implementing' });
    buffer.flushInterrupted();

    expect(await readInterruptedPartial(ref)).toBe('');
  });

  it('reads only the latest cut after repeated call restarts', async () => {
    const ref = setupProjectDir();
    for (const [callId, text] of [
      ['first', 'FIRST'],
      ['second', 'SECOND'],
      ['third', 'THIRD'],
    ] as const) {
      appendEngineEvent(ref, {
        type: 'runner_call_started',
        ts: Date.now(),
        phase: 'implementing',
        callId,
        role: 'implementer',
      });
      const buffer = createTranscriptBuffer({ ...ref, phase: 'implementing' });
      buffer.append(text);
      buffer.flushInterrupted();
      expect(await readInterruptedPartial(ref)).toBe(text);
    }
  });
});
