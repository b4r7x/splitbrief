export function parseBackgroundReply(data: string): string | undefined {
  const reply =
    // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC replies use ESC and BEL delimiters.
    /\u001b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\u0007|\u001b\\)/i.exec(
      data,
    );
  if (!reply) return undefined;
  return `#${reply
    .slice(1)
    .map((component) =>
      Math.round((Number.parseInt(component, 16) / (16 ** component.length - 1)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

export function queryTerminalBackground(
  input: NodeJS.ReadStream,
  output: NodeJS.WritableStream,
  timeoutMs: number,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const raw = input.isRaw;
    let buffer = '';
    const cleanup = () => {
      clearTimeout(timer);
      input.off('data', onData);
      input.pause();
      try {
        input.setRawMode(raw);
      } catch {
        resolve(undefined);
      }
    };
    const settle = () => {
      cleanup();
      resolve(parseBackgroundReply(buffer));
    };
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      // biome-ignore lint/suspicious/noControlCharactersInRegex: DA1 replies begin with ESC.
      if (/\u001b\[\?[0-9;]*c/.test(buffer)) settle();
    };
    const timer = setTimeout(settle, timeoutMs);
    try {
      input.setRawMode(true);
      input.on('data', onData);
      input.resume();
      output.write('\u001b]11;?\u001b\\');
      output.write('\u001b[c');
    } catch {
      cleanup();
      resolve(undefined);
    }
  });
}
