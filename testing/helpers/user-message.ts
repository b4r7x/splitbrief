import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { formatAttachedText, resolveInputFile } from '../../src/core/attachments/resolve.js';
import { readMessages } from '../../src/core/sessions/log-reader.js';
import type { SessionRef } from '../../src/core/types/session-ref.js';
import { plainUserMessage, type UserMessageInput } from '../../src/core/types/user-input.js';
import { readRunEvents } from '../../src/engine/events/replay.js';
import type { EngineEvent } from '../../src/engine/events/types.js';
import { buildResumeContext } from '../../src/engine/orchestrator/transcript/rebuild.js';

export function attachedMessage(projectDir: string): UserMessageInput {
  const path = join(projectDir, 'notes.md');
  writeFileSync(path, 'PELICAN-42 \n\t\n');
  const file = resolveInputFile({ input: path, projectDir });
  if (!file.ok || file.kind !== 'text') throw new Error('expected the text fixture to resolve');
  const displayText = `Use @${path}`;
  return {
    ...plainUserMessage(displayText),
    text: `${displayText}\n\n${formatAttachedText(path, file.content)}`,
    attachedInputs: [{ path: file.path, kind: 'text' }],
  };
}

export async function expectCompactMessage(
  ref: SessionRef,
  events: readonly EngineEvent[],
  message: UserMessageInput,
): Promise<void> {
  const published = events.filter((event) => event.type === 'user_message');
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    text: message.displayText,
    attachedInputs: message.attachedInputs,
  });
  expect(JSON.stringify(published)).not.toContain('PELICAN-42');
  const logged = [];
  for await (const entry of readMessages(ref)) {
    if (entry.role === 'user') logged.push(entry);
  }
  expect(logged).toHaveLength(1);
  expect(logged[0]?.text).toBe(message.displayText);
  expect(JSON.stringify(logged)).not.toContain('PELICAN-42');
  const replay = await readRunEvents(ref);
  expect(replay.events.filter((event) => event.type === 'user_message')).toEqual(published);
}

export async function expectResumedMessage(
  ref: SessionRef,
  message: UserMessageInput,
): Promise<void> {
  const resumed = await buildResumeContext({ ref });
  expect(resumed.messages.filter((entry) => entry.role === 'user')).toContainEqual({
    role: 'user',
    content: message.text,
  });
}
