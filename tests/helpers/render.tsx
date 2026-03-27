import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';
import TaskSummary from '../../src/tui/task-summary.js';

type Props = Parameters<typeof TaskSummary>[0];

export async function renderToString(props: Props): Promise<string> {
  const stdout = new PassThrough();
  let output = '';
  stdout.on('data', (chunk: Buffer) => { output = chunk.toString(); });

  const instance = render(<TaskSummary {...props} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: process.stdin,
    stderr: process.stderr,
    debug: true,
    patchConsole: false,
  });

  await new Promise(resolve => setTimeout(resolve, 50));
  instance.unmount();
  return output;
}
