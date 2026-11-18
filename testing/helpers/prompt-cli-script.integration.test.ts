import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { makeExecutable } from '#testing/helpers/cli-executable.js';
import { promptCliScript } from '#testing/helpers/prompt-cli-script.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { spawnPipe } from '../../src/lib/process/spawn/lifecycle.js';
import { shellQuoteArg } from '../../src/utils/shell-quote.js';

it('receives the full stdin prompt before answering', async () => {
  await withTempDir('prompt-cli-script', async (dir) => {
    const command = join(dir, 'fake-cli');
    const capturePath = join(dir, 'prompt');
    const sentinel = 'prompt-cli-script-final-sentinel';
    const prompt = `${'first line\n'.repeat(100_000)}${sentinel}`;
    makeExecutable(
      command,
      promptCliScript({
        capturePath,
        body: `tail -c ${sentinel.length} ${shellQuoteArg(capturePath)}`,
      }),
    );

    let answer = '';
    const code = await spawnPipe({
      command,
      args: [],
      cwd: dir,
      env: { PATH: '/usr/bin:/bin' },
      stdin: prompt,
      onStdout: (chunk) => {
        answer += chunk;
      },
      onStderr: () => undefined,
      onError: () => null,
      onClose: (exitCode) => exitCode,
    });

    expect(code).toBe(0);
    expect(answer).toBe(sentinel);
    expect(readFileSync(capturePath, 'utf8')).toBe(prompt);
  });
});
