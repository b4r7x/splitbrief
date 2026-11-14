import { chmodSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';

export const itUnix = process.platform === 'win32' ? it.skip : it;

export function makeExecutable(path: string, body = '#!/bin/sh\nexit 0\n'): void {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}
