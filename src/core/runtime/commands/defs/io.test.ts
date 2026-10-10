import { describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeCtx } from '#testing/helpers/runtime-commands.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { resolveAttachment } from '../../../attachments/resolve.js';
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
        insertImage: () => ({ ok: false, reason: 'not-found' }),
        setFeedbackError: (message) => errors.push(message),
      }),
    );

    await command.handler('/tmp/outside.png');

    expect(errors).toEqual(['Cannot attach image: file not found. Check the path and try again.']);
  });

  it('names a folder refusal as not a regular file', async () => {
    const projectDir = createTempDir('image-command-folder');
    try {
      mkdirSync(join(projectDir, 'folder'));
      const errors: string[] = [];
      const command = imageCommand(
        makeCtx({
          insertImage: (input) => {
            const result = resolveAttachment({ input, projectDir });
            return result.ok ? { ok: true, path: result.attachment.path } : result;
          },
          setFeedbackError: (message) => errors.push(message),
        }),
      );

      await command.handler('folder');

      expect(errors).toEqual([
        'Cannot attach image: not a regular file. Name a file, not a directory.',
      ]);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
