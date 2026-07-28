import { closeSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isDirectExecution,
  PTY_EDITOR_FINISHED_MARKER,
  PTY_EDITOR_SENTINEL_ENV,
  PTY_EDITOR_STARTED_MARKER,
} from './contract.js';

export function runEditorChild(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (argv.length !== 1 || argv[0]?.length === 0) {
    throw new Error('PTY editor requires exactly one review file');
  }
  const sentinel = env[PTY_EDITOR_SENTINEL_ENV];
  if (!sentinel) throw new Error('PTY editor sentinel is unavailable');

  let descriptor: number;
  try {
    descriptor = openSync(sentinel, 'wx');
  } catch {
    throw new Error('PTY editor must run exactly once');
  }
  closeSync(descriptor);

  process.stdout.write(`${PTY_EDITOR_STARTED_MARKER}:${process.pid}\n`);
  process.stdout.write(`${PTY_EDITOR_FINISHED_MARKER}:${process.pid}\n`);
}

export function editorChildEntrypoint(): string {
  return fileURLToPath(import.meta.url);
}

function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown PTY editor failure';
  process.stderr.write(`PTY editor failed: ${message}\n`);
  process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  try {
    runEditorChild(process.argv.slice(2));
  } catch (error) {
    reportFailure(error);
  }
}
