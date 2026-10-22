import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { warnError } from '../../lib/warn.js';

// Codex takes `--output-schema <FILE>`, so each call gets its own private schema file.
export async function withSchemaFile<R>(
  json: Readonly<Record<string, unknown>>,
  fn: (path: string) => Promise<R>,
): Promise<R> {
  const dir = await mkdtemp(join(tmpdir(), 'splitbrief-schema-'));
  const path = join(dir, 'schema.json');
  try {
    await writeFile(path, JSON.stringify(json), { mode: 0o600 });
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((err: unknown) =>
      warnError(`Could not remove the temporary folder ${dir}`, err),
    );
  }
}
