import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTerminalControls } from '../../../../src/utils/display-text.js';
import { formatViewport, parseViewport, type Viewport } from '../../contracts/geometry.js';
import { PTY_CHILD_VIEWPORT } from '../child.js';
import { runPtySmoke, type RunPtySmokeOptions } from './run.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export function parsePtySmokeArgs(argv: readonly string[]): RunPtySmokeOptions {
  let viewport: Viewport = PTY_CHILD_VIEWPORT;
  let sawViewport = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--viewport' || sawViewport) {
      throw new Error('PTY smoke accepts only one --viewport option');
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('PTY smoke --viewport requires a value');
    }
    viewport = parseViewport(value);
    sawViewport = true;
    index += 1;
  }
  if (viewport.cols !== PTY_CHILD_VIEWPORT.cols || viewport.rows !== PTY_CHILD_VIEWPORT.rows) {
    throw new Error(`PTY smoke supports only ${formatViewport(PTY_CHILD_VIEWPORT)}`);
  }
  return { viewport, timeoutMs: DEFAULT_TIMEOUT_MS };
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint || !existsSync(entrypoint)) return false;
  return pathToFileURL(resolve(entrypoint)).href === import.meta.url;
}

async function main(): Promise<void> {
  const result = await runPtySmoke(parsePtySmokeArgs(process.argv.slice(2)));
  if (result.status === 'skipped') {
    process.stdout.write(`PTY smoke SKIP: ${stripTerminalControls(result.reason)}\n`);
    return;
  }
  process.stdout.write(
    `PTY smoke PASS: marker; viewport ${formatViewport(result.viewport)}; resize; clean exit; terminal restored\n`,
  );
}

function reportFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown PTY smoke failure';
  process.stderr.write(`PTY smoke failed: ${stripTerminalControls(message)}\n`);
  process.exitCode = 1;
}

if (isDirectExecution()) void main().catch(reportFailure);
