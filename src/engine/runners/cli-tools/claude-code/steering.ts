import { classifyCliAdmittedVersion } from '../../../../core/runners/cli-tool/version.js';
import type { Attachment } from '../../../../core/schemas/attachment.js';
import { spawnPipeError } from '../../../../lib/process/spawn/fatal.js';
import type { SpawnStdinWriter } from '../../../../lib/process/spawn/types.js';
import { error } from '../../../../utils/error.js';
import type { SteerOutcome } from '../../../calls/steering.js';
import { readImagesAsBase64 } from '../../../streaming/attachments.js';
import type { CliSteeringTransport } from '../contract.js';
import { CLAUDE_STREAM_INPUT_ARGS } from './args.js';
import { createClaudeParser } from './protocol.js';

export const CLAUDE_STEERING: CliSteeringTransport = {
  supportsVersion: (installedVersion) =>
    installedVersion !== undefined &&
    classifyCliAdmittedVersion({ installedVersion, minimumAdmittedVersion: '2.1.296' }) ===
      'compatible',
  open: async ({ invocation, prompt, onReady, onAdmissionClosed }) => {
    const baseArgs = invocation.baseArgs ?? invocation.args;
    const flags = [
      ...(baseArgs.includes('--input-format') ? [] : CLAUDE_STREAM_INPUT_ARGS),
      '--replay-user-messages',
    ];
    let writer: SpawnStdinWriter | undefined;
    let writes = Promise.resolve();
    let admissionOpen = true;
    let promptEchoPending = true;
    const pending: { text: string; settle: (outcome: SteerOutcome) => void }[] = [];
    const closeAdmission = () => {
      if (!admissionOpen) return;
      admissionOpen = false;
      try {
        onAdmissionClosed();
      } finally {
        writer?.end();
      }
    };
    return {
      invocation: {
        ...invocation,
        baseArgs: [...baseArgs, ...flags],
        args: [...baseArgs, ...flags, ...invocation.args.slice(baseArgs.length)],
      },
      parse: createClaudeParser(),
      onAdmissionClosed: closeAdmission,
      onStdinReady: (value) => {
        writer = value;
        if (!admissionOpen) {
          writer.end();
          return;
        }
        onReady((message) => {
          if (!admissionOpen || writer === undefined) return Promise.resolve('deferred');
          const delivery = Promise.withResolvers<SteerOutcome>();
          const entry = { text: message.text, settle: delivery.resolve };
          pending.push(entry);
          writes = writes
            .then(async () => value.write(await inputLine(message.text, message.images)))
            .catch((cause: unknown) => {
              const index = pending.indexOf(entry);
              if (index < 0) return;
              pending.splice(index, 1);
              entry.settle(
                admissionOpen && spawnPipeError.isStdinClosed(cause) ? 'deferred' : 'uncertain',
              );
            });
          return delivery.promise;
        });
      },
      onLine: (_line, events) => {
        for (const event of events) {
          if (event.type === 'input-ack') {
            if (promptEchoPending) {
              if (event.text === prompt) promptEchoPending = false;
            } else if (pending[0]?.text === event.text) {
              pending.shift()?.settle('delivered');
            }
          }
          if (event.type === 'result') {
            closeAdmission();
            return pending.length > 0;
          }
        }
        return false;
      },
      close: async () => {
        try {
          closeAdmission();
        } finally {
          for (const entry of pending.splice(0)) entry.settle('uncertain');
        }
        await writes;
      },
    };
  },
};

export async function inputLine(text: string, images?: readonly Attachment[]): Promise<string> {
  if (images === undefined || images.length === 0)
    return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
  let encoded: Awaited<ReturnType<typeof readImagesAsBase64>>;
  try {
    encoded = await readImagesAsBase64([...images]);
  } catch (cause) {
    throw error(
      'prompt-transport-error',
      'Claude Code image attachments could not be read',
      undefined,
      cause,
    );
  }
  const content = [
    { type: 'text', text },
    ...encoded.map(({ mime, data }) => ({
      type: 'image',
      source: { type: 'base64', media_type: mime, data },
    })),
  ];
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}
