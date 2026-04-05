import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';

export async function renderComponent(element: React.ReactElement): Promise<string> {
  const stdout = new PassThrough();
  let output = '';
  stdout.on('data', (chunk: Buffer) => { output = chunk.toString(); });

  const instance = render(element, {
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
