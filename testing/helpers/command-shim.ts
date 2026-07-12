import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CommandShimOptions {
  dir: string;
  command: string;
  /** Lines printed to stdout via printf, single-quote escaped. */
  lines: string[];
  /** Seconds slept before printing — idle-watchdog tests use ~0.15. */
  sleepSeconds?: number;
}

export function writeCommandShim(opts: CommandShimOptions): string {
  const printfLines = opts.lines.map((line) => `printf '%s\\n' '${line.replace(/'/g, "'\\''")}'`);
  const script = [
    '#!/bin/bash',
    ...(opts.sleepSeconds === undefined ? [] : [`sleep ${opts.sleepSeconds}`]),
    ...printfLines,
    '',
  ].join('\n');
  const shimPath = join(opts.dir, opts.command);
  writeFileSync(shimPath, script, 'utf8');
  chmodSync(shimPath, 0o755);
  return shimPath;
}

export function prependPath(dir: string): () => void {
  const original = process.env['PATH'];
  process.env['PATH'] = `${dir}:${original ?? ''}`;
  return () => {
    if (original === undefined) delete process.env['PATH'];
    else process.env['PATH'] = original;
  };
}
