export type StateSerializer = <T>(fn: () => T | Promise<T>) => Promise<T>;

export function createStateSerializer(): StateSerializer {
  let chain: Promise<void> | undefined;
  return <T>(fn: () => T | Promise<T>): Promise<T> => {
    const run = () => {
      try {
        return Promise.resolve(fn());
      } catch (err) {
        return Promise.reject(err);
      }
    };
    const result = chain ? chain.then(run) : run();
    const settled = result.then(
      () => {},
      () => {},
    );
    const next = settled.then(() => {
      if (chain === next) chain = undefined;
    });
    chain = next;
    return result;
  };
}
