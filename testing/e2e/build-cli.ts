import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export default function buildCli() {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], {
    cwd: resolve(import.meta.dirname, '../..'),
    timeout: 120_000,
    stdio: 'pipe',
  });
}
