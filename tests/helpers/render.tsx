import { render } from 'ink';
import { PassThrough } from 'node:stream';
import { renderTaskSummary } from '../../src/ui/task-summary.js';
import { getTheme } from '../../src/theme.js';

type Props = Parameters<typeof renderTaskSummary>[0];

export async function renderToString(props: Props): Promise<string> {
  const theme = getTheme();
  const stdout = new PassThrough();
  let output = '';
  stdout.on('data', (chunk: Buffer) => { output = chunk.toString(); });

  const el = renderTaskSummary(props, theme);
  const instance = render(el, {
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
