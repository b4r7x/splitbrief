import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const workerThreads = require('node:worker_threads');
const OriginalWorker = workerThreads.Worker;

workerThreads.Worker = class extends OriginalWorker {
  constructor(filename, options) {
    const cacheParse =
      typeof filename === 'string' &&
      filename.includes('/models-dev-cache/parse-worker.ts') &&
      options?.workerData?.kind === 'record';
    const heldSource = `
const { existsSync, watch, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const releasePath = process.env.SPLITBRIEF_E2E_PARSE_RELEASE;
const watcher = watch(dirname(releasePath), () => {
  if (!existsSync(releasePath)) return;
  watcher.close();
  Promise.resolve(${filename}).then(() => {
    writeFileSync(process.env.SPLITBRIEF_E2E_PARSE_FINISHED, '');
  });
});
writeFileSync(process.env.SPLITBRIEF_E2E_PARSE_STARTED, '');
`;
    super(cacheParse ? heldSource : filename, options);
  }
};
syncBuiltinESMExports();

globalThis.fetch = async () => {
  throw new Error('Network disabled in home boot E2E');
};
