import { describe, expect, it } from 'vitest';
import { makeCtx } from '#testing/helpers/runtime-commands.js';
import { ioCommands } from './io.js';

function imageCommand(ctx: Parameters<typeof ioCommands>[0]) {
  const command = ioCommands(ctx).find((candidate) => candidate.name === '/image');
  if (command?.kind !== 'arg') throw new Error('/image is not an argument command');
  return command;
}

describe('/image command', () => {
  it('uses the inline insertion port for a successful path', async () => {
    const inserted: string[] = [];
    const attached: string[] = [];
    const messages: string[] = [];
    const command = imageCommand(
      makeCtx({
        insertImage: (path) => {
          inserted.push(path);
          return { ok: true, path: '/project/shot.png' };
        },
        attachImage: (path) => {
          attached.push(path);
          return { ok: true, path };
        },
        setFeedbackMessage: (message) => messages.push(message),
      }),
    );

    await command.handler('./shot.png');

    expect(inserted).toEqual(['./shot.png']);
    expect(attached).toEqual([]);
    expect(messages).toEqual(['Attached: /project/shot.png']);
  });

  it('keeps legacy attachment contexts working until they provide the inline port', async () => {
    const attached: string[] = [];
    const command = imageCommand(
      makeCtx({
        attachImage: (path) => {
          attached.push(path);
          return { ok: true, path };
        },
      }),
    );

    await command.handler('./legacy.png');

    expect(attached).toEqual(['./legacy.png']);
  });

  it('turns an attachment refusal into repair guidance', async () => {
    const errors: string[] = [];
    const command = imageCommand(
      makeCtx({
        insertImage: () => ({ ok: false, reason: 'outside-safe-roots' }),
        setFeedbackError: (message) => errors.push(message),
      }),
    );

    await command.handler('/tmp/outside.png');

    expect(errors).toEqual([
      'Cannot attach image: the file must be inside the project or home folder.',
    ]);
  });
});
