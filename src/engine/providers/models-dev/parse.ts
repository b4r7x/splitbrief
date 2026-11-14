import { Worker } from 'node:worker_threads';
import { error } from '../../../utils/error.js';
import type {
  ModelsDevCacheMetadata,
  ModelsDevCacheRecord,
  ModelsDevParseRequest,
  ModelsDevParseResult,
  ParsedModelsDevCatalog,
} from './record.js';

export function parseModelsDevPayload(
  request: ModelsDevParseRequest & Readonly<{ kind: 'record' }>,
): Promise<ModelsDevCacheRecord | null>;
export function parseModelsDevPayload(
  request: ModelsDevParseRequest & Readonly<{ kind: 'metadata' }>,
): Promise<ModelsDevCacheMetadata | null>;
export function parseModelsDevPayload(
  request: ModelsDevParseRequest & Readonly<{ kind: 'catalog' }>,
): Promise<ParsedModelsDevCatalog>;
export async function parseModelsDevPayload(
  request: ModelsDevParseRequest,
): Promise<ModelsDevParseResult> {
  const source = import.meta.url.endsWith('.ts');
  const workerUrl = source
    ? new URL('./parse-worker.ts', import.meta.url)
    : new URL('./parse-worker.js', import.meta.url);
  const worker = new Worker(
    source
      ? `import(${JSON.stringify(import.meta.resolve('tsx/esm/api'))}).then(({ tsImport }) => tsImport(${JSON.stringify(workerUrl.href)}, ${JSON.stringify(import.meta.url)}))`
      : workerUrl,
    { eval: source, workerData: request, execArgv: [] },
  );
  try {
    return await new Promise<ModelsDevParseResult>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('messageerror', reject);
      worker.once('error', reject);
      worker.once('exit', (code) => {
        reject(
          error(
            'models-dev-parser-exited',
            `Models.dev parser exited before returning a result (${code}).`,
            { code },
          ),
        );
      });
    });
  } finally {
    await worker.terminate();
  }
}
