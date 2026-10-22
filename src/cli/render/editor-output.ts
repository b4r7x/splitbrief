import { terminalSequences } from '../../lib/terminal/control.js';

export function createEditorOutput(source: NodeJS.WriteStream) {
  let state: 'open' | 'suspended' | 'closed' = 'open';
  // Ink pushes its keyboard mode once and pops it on unmount; an editor handover hands it over.
  let keyboardPush: string | undefined;
  const write: typeof source.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    if (typeof chunk === 'string' && chunk.startsWith('\u001b[>') && chunk.endsWith('u'))
      keyboardPush = chunk;
    if (chunk === terminalSequences.popKittyKeyboard) keyboardPush = undefined;
    if (
      state === 'suspended' ||
      (state === 'closed' && chunk !== terminalSequences.popKittyKeyboard)
    ) {
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      done?.();
      return true;
    }
    return typeof encodingOrCallback === 'string'
      ? source.write(chunk, encodingOrCallback, callback)
      : source.write(chunk, encodingOrCallback ?? callback);
  };
  const stdout = new Proxy(source, {
    get: (target, key) => {
      if (key === 'write') return write;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    stdout,
    suspend: () => {
      state = 'suspended';
    },
    resume: () => {
      state = 'open';
    },
    keyboardPush: () => keyboardPush,
    // Ink's unmount still pops the keyboard mode it pushed. An editor handover pops it itself,
    // so a stream closed while an editor holds the terminal keeps dropping everything.
    close: () => {
      if (state === 'open') state = 'closed';
    },
  };
}
