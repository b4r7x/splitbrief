export function createEditorOutput(source: NodeJS.WriteStream) {
  let suspended = false;
  const write: typeof source.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    if (suspended) {
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
      suspended = true;
    },
    resume: () => {
      suspended = false;
    },
  };
}
