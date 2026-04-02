import React from 'react';
import { render } from 'ink';
import { PassThrough } from 'node:stream';

export function renderHook<T>(
  hookFn: () => T,
  options?: { wrapper?: React.FC<{ children: React.ReactNode }> },
): {
  result: { current: T };
  act: (fn: () => void) => Promise<void>;
  unmount: () => void;
} {
  const resultRef: { current: T | null } = { current: null };

  function HookHost() {
    const value = hookFn();
    resultRef.current = value;
    return null;
  }

  const element = options?.wrapper
    ? React.createElement(options.wrapper, null, React.createElement(HookHost))
    : React.createElement(HookHost);

  const stdout = new PassThrough();
  const inst = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stderr: new PassThrough() as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
  });

  function act(fn: () => void) {
    fn();
    return new Promise<void>(resolve => setTimeout(resolve, 10));
  }

  function unmount() {
    inst.unmount();
  }

  return { result: resultRef as { current: T }, act, unmount };
}
